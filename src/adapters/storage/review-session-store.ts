import * as v from "valibot";
import { readdir } from "node:fs/promises";

import {
  createReviewSessionId,
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../../domain/ids";
import {
  parseFindingReviewReceipts,
  parsePendingReviewState,
  pendingReviewMatchesSession,
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
  schemaVersion: v.literal(5),
  id: v.string(),
  key: v.strictObject({
    profileId: v.string(),
    host: v.string(),
    owner: v.string(),
    repo: v.string(),
    prNumber: v.number(),
    headSha: v.string(),
  }),
  pr: v.strictObject({
    headSha: v.string(),
    baseSha: v.optional(v.string()),
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
  worktree: v.strictObject({ path: v.string(), headSha: v.string() }),
  pendingReview: v.optional(v.unknown()),
  findingReviewReceipts: v.optional(v.unknown()),
  directSummaryReview: v.optional(v.unknown()),
  createdAt: v.string(),
  updatedAt: v.string(),
});

export type InvalidSessionEntry = {
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
        if (current.error.reason !== "not_found" || expectedUpdatedAt !== undefined)
          return current;
      } else if (
        expectedUpdatedAt !== undefined &&
        (current.value.updatedAt !== expectedUpdatedAt ||
          Date.parse(value.updatedAt) <= Date.parse(current.value.updatedAt))
      ) {
        return invalidWrite();
      }
      return writeAtomicJson(this.paths.sessionFile(value.key.profileId, value.id), value);
    });
  }

  async load(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): Promise<Result<ReviewSession, StorageFailure>> {
    const stored = await readJsonFile(this.paths.sessionFile(profileId, sessionId));
    if (stored._tag === "err") return stored;
    const parsed = parseStoredReviewSession(stored.value);
    if (parsed._tag === "err") return parsed;
    return parsed.value.key.profileId === profileId && parsed.value.id === sessionId
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
    const sessions: ReviewSession[] = [];
    const invalidEntries: InvalidSessionEntry[] = [];
    for (const entry of entries) {
      if (entry === ".quarantine" || entry === "diagnostics.jsonl") continue;
      const sessionId = parseReviewSessionId(entry);
      if (sessionId._tag === "err") {
        invalidEntries.push({ entryName: entry });
        continue;
      }
      const loaded = await this.load(profileId, sessionId.value);
      if (loaded._tag === "ok") sessions.push(loaded.value);
      else invalidEntries.push({ entryName: entry, sessionId: sessionId.value });
    }
    sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
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

/** Parses one current schema-5 session and rejects all removed authority fields. */
export function parseStoredReviewSession(
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
  const id = parseReviewSessionId(raw.output.id);
  const patchPath = parseAbsolutePath(raw.output.patchPath);
  const worktreePath = parseAbsolutePath(raw.output.worktree.path);
  const worktreeHeadSha = parseGitSha(raw.output.worktree.headSha);
  const prHeadSha = parseGitSha(raw.output.pr.headSha);
  const prBaseSha =
    raw.output.pr.baseSha === undefined
      ? undefined
      : parseGitSha(raw.output.pr.baseSha);
  const createdAt = parseIsoTimestamp(raw.output.createdAt);
  const updatedAt = parseIsoTimestamp(raw.output.updatedAt);
  if (
    profileId._tag === "err" ||
    host._tag === "err" ||
    owner._tag === "err" ||
    repo._tag === "err" ||
    prNumber._tag === "err" ||
    headSha._tag === "err" ||
    id._tag === "err" ||
    patchPath._tag === "err" ||
    worktreePath._tag === "err" ||
    worktreeHeadSha._tag === "err" ||
    prHeadSha._tag === "err" ||
    (prBaseSha !== undefined && prBaseSha._tag === "err") ||
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
      }) ||
    worktreeHeadSha.value !== headSha.value ||
    prHeadSha.value !== headSha.value
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
      : parseFindingReviewReceipts(raw.output.findingReviewReceipts, {
          id: id.value,
          headSha: headSha.value,
          ...(pendingReview.value === undefined
            ? {}
            : { pendingReview: pendingReview.value }),
        });
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
      : {
          title: raw.output.prContext.title,
          ...(raw.output.prContext.description === undefined
            ? {}
            : { description: raw.output.prContext.description }),
          author: raw.output.prContext.author,
          headBranch: raw.output.prContext.headBranch,
          baseBranch: raw.output.prContext.baseBranch,
        };
  return ok({
    schemaVersion: 5,
    id: id.value,
    key: {
      profileId: profileId.value,
      host: host.value,
      owner: owner.value,
      repo: repo.value,
      prNumber: prNumber.value,
      headSha: headSha.value,
    },
    pr: {
      headSha: prHeadSha.value,
      ...(prBaseSha === undefined ? {} : { baseSha: prBaseSha.value }),
      isDraft: raw.output.pr.isDraft,
      isOpen: raw.output.pr.isOpen,
    },
    ...(prContext === undefined ? {} : { prContext }),
    patchPath: patchPath.value,
    worktree: { path: worktreePath.value, headSha: worktreeHeadSha.value },
    ...(pendingReview.value === undefined
      ? {}
      : { pendingReview: pendingReview.value }),
    ...(findingReviewReceipts.value === undefined
      ? {}
      : { findingReviewReceipts: findingReviewReceipts.value }),
    ...(directSummaryReview.value === undefined
      ? {}
      : { directSummaryReview: directSummaryReview.value }),
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  });
}

function isMissing(cause: unknown): boolean {
  return (
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
