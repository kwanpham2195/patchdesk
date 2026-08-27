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
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../../domain/ids";
import {
  parseFindingReviewReceipts,
  parsePendingReviewState,
  pendingReviewMatchesSession,
  type PendingReviewState,
} from "../../domain/pending-review";
import { parseDirectSummaryReviewState } from "../../domain/direct-summary-review";
import type { ReviewSession } from "../../domain/review-session";
import { err, ok, type Result } from "../../domain/result";
import {
  readJsonFile,
  type StorageFailure,
  writeAtomicJson,
} from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

const reviewSessionSchema = v.strictObject({
  schemaVersion: v.literal(6),
  id: v.string(),
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
  patchPath: v.string(),
  canonicalPatchHash: v.optional(v.string()),
  localCheckoutWarning: v.optional(
    v.picklist(["missing_local_path", "local_checkout_unavailable"]),
  ),
  worktree: v.strictObject({ path: v.string(), headSha: v.string() }),
  pendingReview: v.optional(v.unknown()),
  findingReviewReceipts: v.optional(v.unknown()),
  directSummaryReview: v.optional(v.unknown()),
  createdAt: v.string(),
  updatedAt: v.string(),
});

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
  private readonly saveLocks = new Map<string, Promise<void>>();

  constructor(private readonly paths: PatchdeskPaths) {}

  async save(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the very first statement below runs parseStoredReviewSession, the actual I/O boundary parser for this shape; there is no earlier boundary to move it to.
    session: unknown,
    expectedUpdatedAt?: ReviewSession["updatedAt"],
  ): Promise<Result<void, StorageFailure>> {
    const parsed = parseStoredReviewSession(session);
    if (parsed._tag === "err") return invalidWrite();
    const value = parsed.value;
    const key = `${value.key.profileId}:${value.id}`;
    return this.withSaveLock(key, async () => {
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
        value,
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
      if (isMissing(cause)) return ok({ sessions: [], invalidEntries: [] });
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

  private async withSaveLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const predecessor = this.saveLocks.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.saveLocks.set(key, current);
    if (predecessor !== undefined) await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.saveLocks.get(key) === current) this.saveLocks.delete(key);
    }
  }
}

async function mapConcurrent<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<ReadonlyArray<R>> {
  const values: Array<R> = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    const index = nextIndex;
    nextIndex += 1;
    const item = items[index];
    if (item === undefined) return;
    values[index] = await map(item);
    return worker();
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return values;
}

/** Mutable draft of `ReviewSession`, built in statements so each optional
 * field is added only when it has a value. */
type MutableReviewSession = {
  -readonly [K in keyof ReviewSession]: ReviewSession[K];
};
/** Mutable draft of `ReviewSession["pr"]`. */
type MutableSessionPr = {
  headSha: GitSha;
  baseSha: GitSha;
  isDraft: boolean;
  isOpen: boolean;
};
/** Mutable draft of `ReviewSession["prContext"]`, built in statements so the
 * optional `description` is added only when it has a value. */
type MutableSessionPrContext = {
  title: string;
  description?: string;
  author: string;
  headBranch: string;
  baseBranch: string;
};
/** Mutable draft of the `parseFindingReviewReceipts` session argument, built
 * in statements so the optional `pendingReview` is added only when it has a
 * value. */
type MutableFindingReviewContext = {
  id: ReviewSessionId;
  headSha: GitSha;
  pendingReview?: PendingReviewState;
};

function buildSessionPr(
  headSha: GitSha,
  baseSha: GitSha,
  isDraft: boolean,
  isOpen: boolean,
): MutableSessionPr {
  return { headSha, baseSha, isDraft, isOpen };
}

function buildSessionPrContext(raw: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly author: string;
  readonly headBranch: string;
  readonly baseBranch: string;
}): MutableSessionPrContext {
  const context: MutableSessionPrContext = {
    title: raw.title,
    author: raw.author,
    headBranch: raw.headBranch,
    baseBranch: raw.baseBranch,
  };
  if (raw.description !== undefined) context.description = raw.description;
  return context;
}

function buildFindingReviewContext(
  id: ReviewSessionId,
  headSha: GitSha,
  pendingReview: PendingReviewState | undefined,
): MutableFindingReviewContext {
  const context: MutableFindingReviewContext = { id, headSha };
  if (pendingReview !== undefined) context.pendingReview = pendingReview;
  return context;
}

/** Parses one current schema-6 session and rejects all removed authority fields. */
export function parseStoredReviewSession(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser for stored sessions; there is no earlier boundary to run it at.
  input: unknown,
): Result<ReviewSession, StorageFailure> {
  const raw = v.safeParse(reviewSessionSchema, input);
  if (!raw.success) return invalidRead();
  const profileId = parseWorkspaceProfileId(raw.output.key.profileId);
  const host = parseGitHubHost(raw.output.key.host);
  const owner = parseGitHubOwner(raw.output.key.owner);
  const repo = parseGitHubRepoName(raw.output.key.repo);
  const prNumber = parsePullRequestNumber(raw.output.key.prNumber);
  const headSha = parseGitSha(raw.output.key.headSha);
  const baseSha = parseGitSha(raw.output.key.baseSha);
  const id = parseReviewSessionId(raw.output.id);
  const patchPath = parseAbsolutePath(raw.output.patchPath);
  const canonicalPatchHash =
    raw.output.canonicalPatchHash === undefined
      ? undefined
      : parseContentHash(raw.output.canonicalPatchHash);
  const worktreePath = parseAbsolutePath(raw.output.worktree.path);
  const worktreeHeadSha = parseGitSha(raw.output.worktree.headSha);
  const prHeadSha = parseGitSha(raw.output.pr.headSha);
  const prBaseSha = parseGitSha(raw.output.pr.baseSha);
  const createdAt = parseIsoTimestamp(raw.output.createdAt);
  const updatedAt = parseIsoTimestamp(raw.output.updatedAt);
  if (
    profileId._tag === "err" ||
    host._tag === "err" ||
    owner._tag === "err" ||
    repo._tag === "err" ||
    prNumber._tag === "err" ||
    headSha._tag === "err" ||
    baseSha._tag === "err" ||
    id._tag === "err" ||
    patchPath._tag === "err" ||
    (canonicalPatchHash !== undefined && canonicalPatchHash._tag === "err") ||
    worktreePath._tag === "err" ||
    worktreeHeadSha._tag === "err" ||
    prHeadSha._tag === "err" ||
    prBaseSha._tag === "err" ||
    createdAt._tag === "err" ||
    updatedAt._tag === "err"
  ) {
    return invalidRead();
  }
  if (
    id.value !==
      createReviewSessionId({
        profileId: profileId.value,
        host: host.value,
        owner: owner.value,
        repo: repo.value,
        prNumber: prNumber.value,
        headSha: headSha.value,
        baseSha: baseSha.value,
      }) ||
    worktreeHeadSha.value !== headSha.value ||
    prHeadSha.value !== headSha.value ||
    prBaseSha.value !== baseSha.value
  ) {
    return invalidRead();
  }
  const pendingReview =
    raw.output.pendingReview === undefined
      ? ok(undefined)
      : parsePendingReviewState(raw.output.pendingReview);
  if (pendingReview._tag === "err") return invalidRead();
  if (
    pendingReview.value !== undefined &&
    !pendingReviewMatchesSession(pendingReview.value, {
      host: host.value,
      owner: owner.value,
      repo: repo.value,
      number: prNumber.value,
    })
  ) {
    return invalidRead();
  }
  const findingReviewReceipts =
    raw.output.findingReviewReceipts === undefined
      ? ok(undefined)
      : parseFindingReviewReceipts(
          raw.output.findingReviewReceipts,
          buildFindingReviewContext(
            id.value,
            headSha.value,
            pendingReview.value,
          ),
        );
  const directSummaryReview =
    raw.output.directSummaryReview === undefined
      ? ok(undefined)
      : parseDirectSummaryReviewState(raw.output.directSummaryReview);
  if (
    findingReviewReceipts._tag === "err" ||
    directSummaryReview._tag === "err" ||
    (directSummaryReview.value !== undefined &&
      (directSummaryReview.value._tag === "Confirmed"
        ? directSummaryReview.value.receipt.headSha !== headSha.value
        : directSummaryReview.value.operation.headSha !== headSha.value))
  ) {
    return invalidRead();
  }
  const prContext =
    raw.output.prContext === undefined
      ? undefined
      : buildSessionPrContext(raw.output.prContext);
  const session: MutableReviewSession = {
    schemaVersion: 6,
    id: id.value,
    key: {
      profileId: profileId.value,
      host: host.value,
      owner: owner.value,
      repo: repo.value,
      prNumber: prNumber.value,
      headSha: headSha.value,
      baseSha: baseSha.value,
    },
    pr: buildSessionPr(
      prHeadSha.value,
      prBaseSha.value,
      raw.output.pr.isDraft,
      raw.output.pr.isOpen,
    ),
    patchPath: patchPath.value,
    worktree: { path: worktreePath.value, headSha: worktreeHeadSha.value },
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  };
  if (prContext !== undefined) session.prContext = prContext;
  if (canonicalPatchHash !== undefined)
    session.canonicalPatchHash = canonicalPatchHash.value;
  if (raw.output.localCheckoutWarning !== undefined)
    session.localCheckoutWarning = raw.output.localCheckoutWarning;
  if (pendingReview.value !== undefined)
    session.pendingReview = pendingReview.value;
  if (findingReviewReceipts.value !== undefined)
    session.findingReviewReceipts = findingReviewReceipts.value;
  if (directSummaryReview.value !== undefined)
    session.directSummaryReview = directSummaryReview.value;
  return ok(session);
}

function isMissing(cause: unknown): boolean {
  return (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a caught exception of unknown shape at this exact I/O boundary predicate; no earlier parser exists for a thrown value.
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
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
