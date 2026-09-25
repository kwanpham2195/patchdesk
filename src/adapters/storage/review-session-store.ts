import * as v from "valibot";
import { readdir } from "node:fs/promises";

import {
  createReviewSessionId,
  parseAbsolutePath,
  parseContentHash,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type GitSha,
  type PullRequestNumber,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../../domain/ids";
import {
  parseFindingReviewReceipts,
  parsePendingReviewState,
  pendingReviewMatchesSession,
  type PendingReviewState,
} from "../../domain/pending-review";
import { definedProps } from "../../domain/defined-props";
import { parseDirectSummaryReviewState } from "../../domain/direct-summary-review";
import { KeyedMutex } from "../../domain/keyed-mutex";
import { mapConcurrent } from "../../domain/map-concurrent";
import {
  isPullRequestReviewSession,
  type LocalReviewSession,
  type PullRequestReviewSession,
  type ReviewSession,
  type ReviewSessionFields,
  type ReviewSessionKey,
} from "../../domain/review-session";
import {
  parseStoredLocalReviewSource,
  storedLocalReviewSourceSchema,
  type ReviewSource,
} from "../../domain/review-source";
import { err, ok, type Result } from "../../domain/result";
import {
  isNotFound,
  readJsonFile,
  type StorageFailure,
  writeAtomicJson,
} from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

const sessionFieldEntries = {
  schemaVersion: v.literal(6),
  id: v.string(),
  patchPath: v.string(),
  canonicalPatchHash: v.optional(v.string()),
  localCheckoutWarning: v.optional(
    v.picklist(["missing_local_path", "local_checkout_unavailable"]),
  ),
  worktree: v.strictObject({ path: v.string(), headSha: v.string() }),
  createdAt: v.string(),
  updatedAt: v.string(),
};

/**
 * A pull request session is stored exactly as before ADR 0050: `prNumber`
 * flat in `key` and no `source`, so records already on disk load unchanged
 * and there is one stored form per kind.
 */
const pullRequestSessionSchema = v.strictObject({
  ...sessionFieldEntries,
  key: v.strictObject({
    profileId: v.string(),
    host: v.string(),
    owner: v.string(),
    repo: v.string(),
    prNumber: v.number(),
    headSha: v.string(),
    baseSha: v.string(),
  }),
  pr: v.strictObject({
    headSha: v.string(),
    baseSha: v.string(),
    isDraft: v.boolean(),
    isOpen: v.boolean(),
  }),
  prContext: v.optional(
    v.strictObject({
      title: v.string(),
      description: v.optional(v.pipe(v.string(), v.maxLength(65_536))),
      author: v.string(),
      headBranch: v.string(),
      baseBranch: v.string(),
    }),
  ),
  pendingReview: v.optional(v.unknown()),
  findingReviewReceipts: v.optional(v.unknown()),
  directSummaryReview: v.optional(v.unknown()),
});

const localSessionSchema = v.strictObject({
  ...sessionFieldEntries,
  key: v.strictObject({
    profileId: v.string(),
    host: v.string(),
    owner: v.string(),
    repo: v.string(),
    source: storedLocalReviewSourceSchema,
    headSha: v.string(),
    baseSha: v.string(),
  }),
});

type RawPullRequestSession = v.InferOutput<typeof pullRequestSessionSchema>;
type RawLocalSession = v.InferOutput<typeof localSessionSchema>;

type InvalidSessionEntry = {
  readonly entryName: string;
  readonly sessionId?: ReviewSessionId;
};

export type SessionEntryScan = {
  readonly sessions: ReadonlyArray<ReviewSession>;
  readonly invalidEntries: ReadonlyArray<InvalidSessionEntry>;
};

/** Owns one strict current session schema and its profile-scoped persistence. */
export class ReviewSessionStore {
  private readonly saveLocks = new KeyedMutex();

  constructor(private readonly paths: PatchdeskPaths) {}

  async save(
    session: ReviewSession,
    expectedUpdatedAt?: ReviewSession["updatedAt"],
  ): Promise<Result<void, StorageFailure>> {
    const stored = serializeReviewSession(session);
    const parsed = parseStoredReviewSession(stored);
    if (parsed._tag === "err") return invalidWrite();
    const value = parsed.value;
    const key = `${value.key.profileId}:${value.id}`;
    return this.saveLocks.run(key, async () => {
      const current = await this.load(value.key.profileId, value.id);
      if (current._tag === "err") {
        if (
          current.error.reason !== "not_found" ||
          expectedUpdatedAt !== undefined
        )
          return current;
      } else if (
        expectedUpdatedAt !== undefined &&
        (current.value.updatedAt !== expectedUpdatedAt ||
          Date.parse(value.updatedAt) <= Date.parse(current.value.updatedAt))
      ) {
        return invalidWrite();
      }
      return writeAtomicJson(
        this.paths.sessionFile(value.key.profileId, value.id),
        stored,
      );
    });
  }

  async load(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): Promise<Result<ReviewSession, StorageFailure>> {
    const stored = await readJsonFile(
      this.paths.sessionFile(profileId, sessionId),
    );
    if (stored._tag === "err") return stored;
    const parsed = parseStoredReviewSession(stored.value);
    if (parsed._tag === "err") return parsed;
    return parsed.value.key.profileId === profileId &&
      parsed.value.id === sessionId
      ? parsed
      : invalidRead();
  }

  async scanSessionEntries(
    profileId: WorkspaceProfileId,
  ): Promise<Result<SessionEntryScan, StorageFailure>> {
    const root = this.paths.profileReviewsDirectory(profileId);
    let entries: ReadonlyArray<string>;
    try {
      entries = await readdir(root);
    } catch (cause: unknown) {
      if (isNotFound(cause)) return ok({ sessions: [], invalidEntries: [] });
      return storageListFailure();
    }
    const candidates = entries.flatMap((entry, index) => {
      if (entry === ".quarantine" || entry === "diagnostics.jsonl") return [];
      const sessionId = parseReviewSessionId(entry);
      return sessionId._tag === "ok"
        ? [{ entry, index, sessionId: sessionId.value }]
        : [];
    });
    const loadedSessions = await mapConcurrent(
      candidates,
      8,
      async (candidate) => ({
        candidate,
        loaded: await this.load(profileId, candidate.sessionId),
      }),
    );
    const loadedByIndex = new Map(
      loadedSessions.map(({ candidate, loaded }) => [candidate.index, loaded]),
    );
    const sessions: Array<ReviewSession> = [];
    const invalidEntries: Array<InvalidSessionEntry> = [];
    for (const [index, entry] of entries.entries()) {
      if (entry === ".quarantine" || entry === "diagnostics.jsonl") continue;
      const sessionId = parseReviewSessionId(entry);
      if (sessionId._tag === "err") {
        invalidEntries.push({ entryName: entry });
        continue;
      }
      const loaded = loadedByIndex.get(index);
      if (loaded?._tag === "ok") sessions.push(loaded.value);
      else
        invalidEntries.push({ entryName: entry, sessionId: sessionId.value });
    }
    sessions.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    return ok({ sessions, invalidEntries });
  }

  async listSessions(
    profileId: WorkspaceProfileId,
  ): Promise<Result<ReadonlyArray<ReviewSession>, StorageFailure>> {
    const scanned = await this.scanSessionEntries(profileId);
    return scanned._tag === "ok" ? ok(scanned.value.sessions) : scanned;
  }
}

function buildSessionPrContext(raw: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly author: string;
  readonly headBranch: string;
  readonly baseBranch: string;
}): NonNullable<PullRequestReviewSession["prContext"]> {
  return {
    title: raw.title,
    author: raw.author,
    headBranch: raw.headBranch,
    baseBranch: raw.baseBranch,
    ...definedProps({ description: raw.description }),
  };
}

function buildFindingReviewContext(
  id: ReviewSessionId,
  headSha: GitSha,
  pendingReview: PendingReviewState | undefined,
): Parameters<typeof parseFindingReviewReceipts>[1] {
  return { id, headSha, ...definedProps({ pendingReview }) };
}

/**
 * The stored form of a session, the inverse of `parseStoredReviewSession`. A
 * pull request key is written flat with `prNumber`, as before local sources
 * existed; a local key is written with its `source`.
 */
function serializeReviewSession(session: ReviewSession): StoredReviewSession {
  if (!isPullRequestReviewSession(session)) return session;
  const { source, ...key } = session.key;
  return { ...session, key: { ...key, prNumber: source.prNumber } };
}

type StoredReviewSession =
  | (Omit<PullRequestReviewSession, "key"> & {
      readonly key: Omit<ReviewSessionKey, "source"> & {
        readonly prNumber: PullRequestNumber;
      };
    })
  | LocalReviewSession;

/** Parses one current schema-6 session and rejects all removed authority fields. */
export function parseStoredReviewSession(
  input: unknown,
): Result<ReviewSession, StorageFailure> {
  const pullRequest = v.safeParse(pullRequestSessionSchema, input);
  if (pullRequest.success) return parsePullRequestSession(pullRequest.output);
  const local = v.safeParse(localSessionSchema, input);
  return local.success ? parseLocalSession(local.output) : invalidRead();
}

function parsePullRequestSession(
  raw: RawPullRequestSession,
): Result<PullRequestReviewSession, StorageFailure> {
  const prNumber = parsePullRequestNumber(raw.key.prNumber);
  if (prNumber._tag === "err") return invalidRead();
  const fields = parseSessionFields(raw, {
    kind: "pull_request",
    prNumber: prNumber.value,
  });
  if (fields._tag === "err") return fields;
  const { key, id } = fields.value;
  const prHeadSha = parseGitSha(raw.pr.headSha);
  const prBaseSha = parseGitSha(raw.pr.baseSha);
  if (
    prHeadSha._tag === "err" ||
    prBaseSha._tag === "err" ||
    prHeadSha.value !== key.headSha ||
    prBaseSha.value !== key.baseSha
  ) {
    return invalidRead();
  }
  const pendingReview =
    raw.pendingReview === undefined
      ? ok(undefined)
      : parsePendingReviewState(raw.pendingReview);
  if (pendingReview._tag === "err") return invalidRead();
  if (
    pendingReview.value !== undefined &&
    !pendingReviewMatchesSession(pendingReview.value, {
      host: key.host,
      owner: key.owner,
      repo: key.repo,
      number: key.source.prNumber,
    })
  ) {
    return invalidRead();
  }
  const findingReviewReceipts =
    raw.findingReviewReceipts === undefined
      ? ok(undefined)
      : parseFindingReviewReceipts(
          raw.findingReviewReceipts,
          buildFindingReviewContext(id, key.headSha, pendingReview.value),
        );
  const directSummaryReview =
    raw.directSummaryReview === undefined
      ? ok(undefined)
      : parseDirectSummaryReviewState(raw.directSummaryReview);
  if (
    findingReviewReceipts._tag === "err" ||
    directSummaryReview._tag === "err" ||
    (directSummaryReview.value !== undefined &&
      (directSummaryReview.value._tag === "Confirmed"
        ? directSummaryReview.value.receipt.headSha !== key.headSha
        : directSummaryReview.value.operation.headSha !== key.headSha))
  ) {
    return invalidRead();
  }
  return ok({
    ...fields.value,
    key,
    pr: {
      headSha: prHeadSha.value,
      baseSha: prBaseSha.value,
      isDraft: raw.pr.isDraft,
      isOpen: raw.pr.isOpen,
    },
    ...definedProps({
      prContext:
        raw.prContext === undefined
          ? undefined
          : buildSessionPrContext(raw.prContext),
      pendingReview: pendingReview.value,
      findingReviewReceipts: findingReviewReceipts.value,
      directSummaryReview: directSummaryReview.value,
    }),
  });
}

function parseLocalSession(
  raw: RawLocalSession,
): Result<LocalReviewSession, StorageFailure> {
  const source = parseStoredLocalReviewSource(raw.key.source);
  if (source._tag === "err") return invalidRead();
  return parseSessionFields(raw, source.value);
}

/** Parses the fields every kind shares and checks the id against the key. */
function parseSessionFields<Source extends ReviewSource>(
  raw: RawPullRequestSession | RawLocalSession,
  source: Source,
): Result<
  ReviewSessionFields & { readonly key: ReviewSessionKey<Source> },
  StorageFailure
> {
  const profileId = parseWorkspaceProfileId(raw.key.profileId);
  const host = parseGitHubHost(raw.key.host);
  const owner = parseGitHubOwner(raw.key.owner);
  const repo = parseGitHubRepoName(raw.key.repo);
  const headSha = parseGitSha(raw.key.headSha);
  const baseSha = parseGitSha(raw.key.baseSha);
  const id = parseReviewSessionId(raw.id);
  const patchPath = parseAbsolutePath(raw.patchPath);
  const canonicalPatchHash =
    raw.canonicalPatchHash === undefined
      ? undefined
      : parseContentHash(raw.canonicalPatchHash);
  const worktreePath = parseAbsolutePath(raw.worktree.path);
  const worktreeHeadSha = parseGitSha(raw.worktree.headSha);
  const createdAt = parseIsoTimestamp(raw.createdAt);
  const updatedAt = parseIsoTimestamp(raw.updatedAt);
  if (
    profileId._tag === "err" ||
    host._tag === "err" ||
    owner._tag === "err" ||
    repo._tag === "err" ||
    headSha._tag === "err" ||
    baseSha._tag === "err" ||
    id._tag === "err" ||
    patchPath._tag === "err" ||
    (canonicalPatchHash !== undefined && canonicalPatchHash._tag === "err") ||
    worktreePath._tag === "err" ||
    worktreeHeadSha._tag === "err" ||
    createdAt._tag === "err" ||
    updatedAt._tag === "err"
  ) {
    return invalidRead();
  }
  const key: ReviewSessionKey<Source> = {
    profileId: profileId.value,
    host: host.value,
    owner: owner.value,
    repo: repo.value,
    source,
    headSha: headSha.value,
    baseSha: baseSha.value,
  };
  if (
    id.value !== createReviewSessionId(key) ||
    worktreeHeadSha.value !== headSha.value
  ) {
    return invalidRead();
  }
  return ok({
    schemaVersion: 6,
    id: id.value,
    key,
    patchPath: patchPath.value,
    worktree: { path: worktreePath.value, headSha: worktreeHeadSha.value },
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
    ...definedProps({
      canonicalPatchHash: canonicalPatchHash?.value,
      localCheckoutWarning: raw.localCheckoutWarning,
    }),
  });
}

function storageListFailure(): Result<never, StorageFailure> {
  return err({ _tag: "StorageFailure", operation: "read", reason: "io" });
}

function invalidRead(): Result<never, StorageFailure> {
  return err({
    _tag: "StorageFailure",
    operation: "read",
    reason: "invalid_stored_value",
  });
}

function invalidWrite(): Result<never, StorageFailure> {
  return err({
    _tag: "StorageFailure",
    operation: "write",
    reason: "invalid_stored_value",
  });
}
