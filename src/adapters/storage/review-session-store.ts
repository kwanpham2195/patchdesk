import * as v from "valibot";
import { readdir, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import {
  createReviewSessionId,
  parseAbsolutePath,
  parseContentHash,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseLocalReviewItemId,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseReviewAttemptId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type ReviewAttemptId,
  type ReviewSessionId,
  type WorkspaceProfileId,
  type IsoTimestamp,
} from "../../domain/ids";
import type {
  ReviewAttempt,
  ReviewAttemptState,
} from "../../domain/review-attempt";
import {
  parseReviewDraft,
  type ReviewDraft,
  type ReviewDraftState,
} from "../../domain/review-draft";
import {
  parseReviewBatch,
  type ReviewBatch,
} from "../../domain/review-batch";
import { parseReviewResult } from "../../domain/review-result";
import type {
  ReviewSession,
  ReviewSessionState,
} from "../../domain/review-session";
import { startNextAttempt } from "../../domain/review-session";
import { parseReviewScope } from "../../domain/review-comparison";
import { err, ok, type Result } from "../../domain/result";
import {
  appendJsonLine,
  readJsonFile,
  type StorageFailure,
  writeAtomicJson,
} from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

const reviewFailureSchema = v.strictObject({
  category: v.picklist([
    "github_auth",
    "github_read",
    "git_worktree",
    "context",
    "flue",
    "parsing",
    "stale_head",
    "storage",
    "policy",
    "unknown",
  ]),
  message: v.pipe(v.string(), v.minLength(1)),
});

const sessionStateSchema = v.variant("_tag", [
  v.strictObject({ _tag: v.literal("Created") }),
  v.strictObject({ _tag: v.literal("Running"), attemptId: v.string() }),
  v.strictObject({ _tag: v.literal("ReviewCompleted"), attemptId: v.string() }),
  v.strictObject({
    _tag: v.literal("ReviewFailed"),
    attemptId: v.string(),
    error: reviewFailureSchema,
  }),
  v.strictObject({
    _tag: v.literal("Stale"),
    reason: v.picklist(["head_changed", "orphaned_run"]),
    currentHeadSha: v.optional(v.string()),
  }),
  v.strictObject({
    _tag: v.literal("Discarded"),
    attemptId: v.optional(v.string()),
  }),
  v.strictObject({ _tag: v.literal("Merged"), mergedAt: v.string() }),
]);

const githubWriteFailureSchema = v.strictObject({
  _tag: v.literal("GitHubWriteFailure"),
  category: v.picklist(["auth", "rejected", "unavailable"]),
  message: v.pipe(v.string(), v.minLength(1)),
});

const draftStateSchema = v.variant("_tag", [
  v.strictObject({ _tag: v.literal("LocalDraft") }),
  v.strictObject({
    _tag: v.literal("PendingGitHubReview"),
    pendingReviewId: v.pipe(v.string(), v.minLength(1)),
    commentCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
  v.strictObject({
    _tag: v.literal("SubmittedGitHubReview"),
    reviewId: v.pipe(v.string(), v.minLength(1)),
    event: v.picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
  }),
  v.strictObject({
    _tag: v.literal("DraftFailed"),
    error: githubWriteFailureSchema,
  }),
]);

const reviewSessionSchema = v.strictObject({
  schemaVersion: v.picklist([2, 3]),
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
  prContext: v.optional(v.strictObject({
    title: v.string(),
    description: v.optional(v.pipe(v.string(), v.maxLength(65_536))),
    author: v.string(),
    headBranch: v.string(),
    baseBranch: v.string(),
  })),
  patchPath: v.string(),
  scope: v.optional(v.unknown()),
  worktree: v.strictObject({ path: v.string(), headSha: v.string() }),
  state: sessionStateSchema,
  currentAttemptId: v.optional(v.string()),
  draft: v.optional(v.strictObject({ state: draftStateSchema })),
  draftContent: v.optional(v.unknown()),
  batch: v.optional(v.strictObject({ state: v.unknown() })),
  batchContent: v.optional(v.unknown()),
  submittedReview: v.optional(
    v.strictObject({
      reviewId: v.pipe(v.string(), v.minLength(1)),
      event: v.picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
      submittedAt: v.string(),
    }),
  ),
  mergeDecision: v.optional(
    v.strictObject({
      mergedAt: v.string(),
      mergeCommitSha: v.optional(v.string()),
    }),
  ),
  visibleResult: v.optional(v.unknown()),
  createdAt: v.string(),
  updatedAt: v.string(),
});

const attemptStateSchema = v.variant("_tag", [
  v.strictObject({ _tag: v.literal("Starting") }),
  v.strictObject({
    _tag: v.literal("Running"),
    flueRunId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({ _tag: v.literal("Completed"), resultPath: v.string() }),
  v.strictObject({ _tag: v.literal("Failed"), error: reviewFailureSchema }),
  v.strictObject({ _tag: v.literal("Interrupted"), interruptedAt: v.string() }),
  v.strictObject({ _tag: v.literal("Discarded"), discardedAt: v.string() }),
  v.strictObject({
    _tag: v.literal("IgnoredLateResult"),
    completedAt: v.string(),
    reason: v.picklist(["not_current", "session_discarded"]),
  }),
]);

const reviewAttemptSchema = v.strictObject({
  id: v.string(),
  sessionId: v.string(),
  state: attemptStateSchema,
  flueRunId: v.optional(v.string()),
  model: v.pipe(v.string(), v.minLength(1)),
  reasoning: v.optional(v.picklist(["low", "medium", "high"])),
  agentIdentity: v.optional(v.literal("Patchdesk review agent")),
  reviewMode: v.optional(v.picklist(["Full review", "Review updates"])),
  accessScope: v.optional(v.literal("Read-only repository inspection")),
  patchdeskVersion: v.optional(v.pipe(v.string(), v.minLength(1))),
  scopeKind: v.optional(v.picklist(["full", "incremental"])),
  baseSessionId: v.optional(v.string()),
  comparisonContentHash: v.optional(v.string()),
  fullPatchHash: v.optional(v.string()),
  reviewSkillVersion: v.string(),
  contextHash: v.string(),
  contextPath: v.string(),
  reviewInputPath: v.string(),
  resultPath: v.optional(v.string()),
  debugPath: v.string(),
  startedAt: v.string(),
  completedAt: v.optional(v.string()),
});

const debugEventSchema = v.strictObject({
  at: v.string(),
  event: v.picklist([
    "session_created",
    "attempt_started",
    "attempt_completed",
    "attempt_failed",
    "session_stale",
  ]),
  attemptId: v.optional(v.string()),
  failureCategory: v.optional(
    v.picklist([
      "github_auth",
      "github_read",
      "git_worktree",
      "context",
      "flue",
      "parsing",
      "stale_head",
      "storage",
      "policy",
      "unknown",
    ]),
  ),
});

export type DebugTraceEvent = v.InferOutput<typeof debugEventSchema>;

export type BeginAttemptFailure =
  | StorageFailure
  | { readonly _tag: "BeginAttemptRejected"; readonly reason: "not_runnable" };

export type BeginAttemptInput = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
  readonly updatedAt: IsoTimestamp;
  readonly createAttempt: (
    session: ReviewSession,
    attemptId: ReviewAttemptId,
  ) => Promise<Result<ReviewAttempt, StorageFailure>>;
};

export type InvalidSessionEntry = {
  readonly entryName: string;
  readonly sessionId?: ReviewSessionId;
};

export type SessionEntryScan = {
  readonly sessions: ReadonlyArray<ReviewSession>;
  readonly invalidEntries: ReadonlyArray<InvalidSessionEntry>;
};

/** Owns durable session and attempt artifacts; debug JSONL is never read as state. */
export class ReviewSessionStore {
  private readonly beginLocks = new Map<string, Promise<void>>();

  constructor(private readonly paths: PatchdeskPaths) {}

  async save(session: unknown): Promise<Result<void, StorageFailure>> {
    const parsed = parseStoredReviewSession(session);
    if (parsed._tag === "err") return invalidWrite();
    return writeAtomicJson(
      this.paths.sessionFile(parsed.value.key.profileId, parsed.value.id),
      parsed.value,
    );
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
    if (
      parsed.value.key.profileId !== profileId ||
      parsed.value.id !== sessionId
    ) {
      return invalidRead();
    }
    return parsed;
  }

  async saveAttempt(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    attempt: unknown,
  ): Promise<Result<void, StorageFailure>> {
    const parsed = parseStoredReviewAttempt(attempt);
    if (parsed._tag === "err") return invalidWrite();
    if (parsed.value.sessionId !== sessionId) {
      return invalidWrite();
    }
    return writeAtomicJson(
      this.paths.attemptFile(profileId, sessionId, parsed.value.id),
      parsed.value,
    );
  }

  /**
   * Allocates and persists one attempt under a session-owned critical section.
   * A failed second write leaves a visible stale session instead of an invisible
   * runnable transition. The caller supplies artifact preparation because only it
   * owns the prepared-input policy; it receives the freshly loaded session and ID.
   */
  async beginAttempt(
    input: BeginAttemptInput,
  ): Promise<Result<ReviewAttempt, BeginAttemptFailure>> {
    return this.withBeginLock(input.profileId, input.sessionId, async () => {
      const session = await this.load(input.profileId, input.sessionId);
      if (session._tag === "err") return session;
      if (session.value.state._tag === "Running") {
        const currentAttemptId = session.value.currentAttemptId;
        if (currentAttemptId === undefined) {
          return err({ _tag: "BeginAttemptRejected", reason: "not_runnable" });
        }
        const currentAttempt = await this.loadAttempt(
          input.profileId,
          input.sessionId,
          currentAttemptId,
        );
        if (currentAttempt._tag === "err" || currentAttempt.value.state._tag !== "Interrupted") {
          return err({ _tag: "BeginAttemptRejected", reason: "not_runnable" });
        }
      }
      if (session.value.state._tag === "Merged" || session.value.state._tag === "Stale") {
        return err({ _tag: "BeginAttemptRejected", reason: "not_runnable" });
      }

      const attempts = await this.listAttempts(input.profileId, input.sessionId);
      if (attempts._tag === "err") return attempts;
      const started = startNextAttempt(session.value, attempts.value.map((attempt) => attempt.id));
      if (started._tag === "err") {
        return err({ _tag: "BeginAttemptRejected", reason: "not_runnable" });
      }

      const attempt = await input.createAttempt(session.value, started.value.attemptId);
      if (attempt._tag === "err") return attempt;
      if (attempt.value.id !== started.value.attemptId || attempt.value.sessionId !== session.value.id) {
        return invalidWrite();
      }

      const startedSession: ReviewSession = {
        ...started.value.session,
        updatedAt: input.updatedAt,
      };
      const sessionSaved = await this.save(startedSession);
      if (sessionSaved._tag === "err") return sessionSaved;

      const attemptSaved = await this.saveAttempt(
        input.profileId,
        startedSession.id,
        attempt.value,
      );
      if (attemptSaved._tag === "ok") return ok(attempt.value);

      // Best effort compensation: if it too fails, startup reconciliation still
      // converts the persisted Running-without-attempt pair into an interruption.
      await this.save({
        ...startedSession,
        state: { _tag: "Stale", reason: "orphaned_run" },
      });
      return attemptSaved;
    });
  }

  async loadAttempt(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    attemptId: ReviewAttemptId,
  ): Promise<Result<ReviewAttempt, StorageFailure>> {
    const stored = await readJsonFile(
      this.paths.attemptFile(profileId, sessionId, attemptId),
    );
    if (stored._tag === "err") return stored;
    const parsed = parseStoredReviewAttempt(stored.value);
    if (parsed._tag === "err") return parsed;
    if (parsed.value.id !== attemptId || parsed.value.sessionId !== sessionId) {
      return invalidRead();
    }
    return parsed;
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
      return err({ _tag: "StorageFailure", operation: "read", reason: "io" });
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
    const root = this.paths.profileReviewsDirectory(profileId);
    let entries: ReadonlyArray<string>;
    try {
      entries = await readdir(root);
    } catch (cause: unknown) {
      if (isMissing(cause)) return ok([]);
      return storageListFailure();
    }
    const sessions: ReviewSession[] = [];
    for (const entry of entries) {
      if (entry === ".quarantine") continue;
      const sessionId = parseReviewSessionId(entry);
      if (sessionId._tag === "err") continue;
      const loaded = await this.load(profileId, sessionId.value);
      if (loaded._tag === "ok") sessions.push(loaded.value);
    }
    return ok(sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  /**
   * Whether a stored session still claims the Running state, even when its full
   * envelope cannot parse. This safety guard exists so quarantine and cache
   * clearing never move a live review aside.
   */
  async isRecordedRunning(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): Promise<Result<boolean, StorageFailure>> {
    const path = this.paths.sessionFile(profileId, sessionId);
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (cause: unknown) {
      if (isMissing(cause)) return ok(false);
      return err({
        _tag: "StorageFailure",
        operation: "read",
        reason: "io",
      });
    }
    try {
      const parsed: unknown = JSON.parse(contents);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "state" in parsed &&
        typeof (parsed as { state: unknown }).state === "object" &&
        (parsed as { state: { _tag?: unknown } }).state !== null &&
        (parsed as { state: { _tag?: unknown } }).state._tag === "Running"
      ) {
        return ok(true);
      }
      return ok(false);
    } catch {
      // A corrupt envelope must not be treated as not-Running; surface the
      // failure so callers refuse to move the data aside.
      return err({
        _tag: "StorageFailure",
        operation: "read",
        reason: "invalid_json",
      });
    }
  }

  async listAttempts(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): Promise<Result<ReadonlyArray<ReviewAttempt>, StorageFailure>> {
    let entries: ReadonlyArray<string>;
    try {
      entries = await readdir(this.paths.attemptsDirectory(profileId, sessionId));
    } catch (cause: unknown) {
      if (isMissing(cause)) return ok([]);
      return storageListFailure();
    }
    const attempts: ReviewAttempt[] = [];
    for (const entry of entries) {
      const attemptId = parseReviewAttemptId(entry);
      if (attemptId._tag === "err") continue;
      const loaded = await this.loadAttempt(profileId, sessionId, attemptId.value);
      if (loaded._tag === "ok") attempts.push(loaded.value);
    }
    return ok(attempts.sort((left, right) => right.startedAt.localeCompare(left.startedAt)));
  }

  async appendDebug(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    event: unknown,
  ): Promise<Result<void, StorageFailure>> {
    if (hasSensitiveKey(event)) {
      return err({
        _tag: "StorageFailure",
        operation: "append",
        reason: "sensitive_value",
      });
    }
    const parsed = parseDebugTraceEvent(event);
    if (parsed._tag === "err") return parsed;
    return appendJsonLine(
      this.paths.debugTraceFile(profileId, sessionId),
      parsed.value,
    );
  }

  private async withBeginLock<T>(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${profileId}:${sessionId}`;
    const predecessor = this.beginLocks.get(key);
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.beginLocks.set(key, current);
    await predecessor;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.beginLocks.get(key) === current) this.beginLocks.delete(key);
    }
  }
}

function isMissing(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function storageListFailure(): Result<never, StorageFailure> {
  return err({ _tag: "StorageFailure", operation: "read", reason: "io" });
}

/** Parse persisted session.json into full domain state, rejecting contradictory records. */
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
  const scope = parseReviewScope(raw.output.scope);
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
    scope._tag === "err" ||
    worktreePath._tag === "err" ||
    worktreeHeadSha._tag === "err" ||
    prHeadSha._tag === "err" ||
    (prBaseSha !== undefined && prBaseSha._tag === "err") ||
    createdAt._tag === "err" ||
    updatedAt._tag === "err"
  )
    return invalidRead();

  const currentAttemptId =
    raw.output.currentAttemptId === undefined
      ? undefined
      : parseReviewAttemptId(raw.output.currentAttemptId);
  if (currentAttemptId !== undefined && currentAttemptId._tag === "err")
    return invalidRead();
  const state = parseSessionState(raw.output.state);
  const storedBatch = parseStoredBatch(raw.output);
  if (state._tag === "err" || storedBatch._tag === "err") return invalidRead();
  if (
    state.value._tag === "Running" &&
    (currentAttemptId === undefined ||
      currentAttemptId.value !== state.value.attemptId)
  )
    return invalidRead();
  if (
    id.value !==
    createReviewSessionId({
      profileId: profileId.value,
      host: host.value,
      owner: owner.value,
      repo: repo.value,
      prNumber: prNumber.value,
      headSha: headSha.value,
    })
  )
    return invalidRead();
  if (
    worktreeHeadSha.value !== headSha.value ||
    prHeadSha.value !== headSha.value
  )
    return invalidRead();
  if (
    storedBatch.value.batchContent !== undefined &&
    (storedBatch.value.batchContent.sessionId !== id.value ||
      currentAttemptId === undefined ||
      storedBatch.value.batchContent.attemptId !== currentAttemptId.value)
  )
    return invalidRead();

  const submittedReview =
    raw.output.submittedReview === undefined
      ? undefined
      : parseSubmittedReview(raw.output.submittedReview);
  const mergeDecision =
    raw.output.mergeDecision === undefined
      ? undefined
      : parseMergeDecision(
          raw.output.mergeDecision.mergeCommitSha === undefined
            ? { mergedAt: raw.output.mergeDecision.mergedAt }
            : {
                mergedAt: raw.output.mergeDecision.mergedAt,
                mergeCommitSha: raw.output.mergeDecision.mergeCommitSha,
              },
        );
  const visibleResult =
    raw.output.visibleResult === undefined
      ? undefined
      : hasRawNotes(raw.output.visibleResult)
        ? invalidRead()
        : parseReviewResult(raw.output.visibleResult);
  if (
    submittedReview?._tag === "err" ||
    mergeDecision?._tag === "err" ||
    visibleResult?._tag === "err"
  )
    return invalidRead();
  const batchState = storedBatch.value.batchContent?.state;
  if (
    batchState?._tag === "Submitted" &&
    (submittedReview === undefined ||
      submittedReview.value.reviewId !== batchState.reviewId ||
      submittedReview.value.event !== batchState.event)
  ) {
    return invalidRead();
  }
  const prContext = raw.output.prContext === undefined
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
    schemaVersion: 3,
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
    scope: scope.value,
    worktree: { path: worktreePath.value, headSha: worktreeHeadSha.value },
    state: state.value,
    ...(currentAttemptId === undefined
      ? {}
      : { currentAttemptId: currentAttemptId.value }),
    ...(storedBatch.value.batch === undefined
      ? {}
      : { batch: storedBatch.value.batch }),
    ...(storedBatch.value.batchContent === undefined
      ? {}
      : { batchContent: storedBatch.value.batchContent }),
    ...(submittedReview === undefined
      ? {}
      : { submittedReview: submittedReview.value }),
    ...(mergeDecision === undefined
      ? {}
      : { mergeDecision: mergeDecision.value }),
    ...(visibleResult === undefined
      ? {}
      : { visibleResult: visibleResult.value }),
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  });
}

/** Parse persisted attempts and preserve only recognized lifecycle data. */
export function parseStoredReviewAttempt(
  input: unknown,
): Result<ReviewAttempt, StorageFailure> {
  const raw = v.safeParse(reviewAttemptSchema, input);
  if (!raw.success) return invalidRead();
  const id = parseReviewAttemptId(raw.output.id);
  const sessionId = parseReviewSessionId(raw.output.sessionId);
  const skillHash = parseContentHash(raw.output.reviewSkillVersion);
  const contextHash = parseContentHash(raw.output.contextHash);
  const baseSessionId = raw.output.baseSessionId === undefined ? undefined : parseReviewSessionId(raw.output.baseSessionId);
  const comparisonContentHash = raw.output.comparisonContentHash === undefined ? undefined : parseContentHash(raw.output.comparisonContentHash);
  const fullPatchHash = raw.output.fullPatchHash === undefined ? undefined : parseContentHash(raw.output.fullPatchHash);
  const contextPath = parseAbsolutePath(raw.output.contextPath);
  const reviewInputPath = parseAbsolutePath(raw.output.reviewInputPath);
  const debugPath = parseAbsolutePath(raw.output.debugPath);
  const startedAt = parseIsoTimestamp(raw.output.startedAt);
  const state = parseAttemptState(raw.output.state);
  if (
    id._tag === "err" ||
    sessionId._tag === "err" ||
    skillHash._tag === "err" ||
    contextHash._tag === "err" ||
    (baseSessionId !== undefined && baseSessionId._tag === "err") ||
    (comparisonContentHash !== undefined && comparisonContentHash._tag === "err") ||
    (fullPatchHash !== undefined && fullPatchHash._tag === "err") ||
    contextPath._tag === "err" ||
    reviewInputPath._tag === "err" ||
    debugPath._tag === "err" ||
    startedAt._tag === "err" ||
    state._tag === "err"
  )
    return invalidRead();

  const flueRunId = raw.output.flueRunId;
  const resultPath =
    raw.output.resultPath === undefined
      ? undefined
      : parseAbsolutePath(raw.output.resultPath);
  const completedAt =
    raw.output.completedAt === undefined
      ? undefined
      : parseIsoTimestamp(raw.output.completedAt);
  if (
    (resultPath !== undefined && resultPath._tag === "err") ||
    (completedAt !== undefined && completedAt._tag === "err")
  )
    return invalidRead();
  if (
    state.value._tag === "Running" &&
    flueRunId !== undefined &&
    flueRunId !== state.value.flueRunId
  )
    return invalidRead();
  if (
    raw.output.scopeKind === "full" &&
    (baseSessionId !== undefined || comparisonContentHash !== undefined)
  )
    return invalidRead();
  if (
    raw.output.scopeKind === "incremental" &&
    (baseSessionId === undefined ||
      comparisonContentHash === undefined ||
      fullPatchHash === undefined)
  )
    return invalidRead();

  return ok({
    id: id.value,
    sessionId: sessionId.value,
    state: state.value,
    ...(flueRunId === undefined ? {} : { flueRunId }),
    model: raw.output.model,
    reasoning: raw.output.reasoning ?? "medium",
    ...(raw.output.agentIdentity === undefined ? {} : { agentIdentity: raw.output.agentIdentity }),
    ...(raw.output.reviewMode === undefined ? {} : { reviewMode: raw.output.reviewMode }),
    ...(raw.output.accessScope === undefined ? {} : { accessScope: raw.output.accessScope }),
    ...(raw.output.patchdeskVersion === undefined
      ? {}
      : { patchdeskVersion: raw.output.patchdeskVersion }),
    ...(raw.output.scopeKind === undefined ? {} : { scopeKind: raw.output.scopeKind }),
    ...(baseSessionId === undefined ? {} : { baseSessionId: baseSessionId.value }),
    ...(comparisonContentHash === undefined ? {} : { comparisonContentHash: comparisonContentHash.value }),
    ...(fullPatchHash === undefined ? {} : { fullPatchHash: fullPatchHash.value }),
    reviewSkillVersion: skillHash.value,
    contextHash: contextHash.value,
    contextPath: contextPath.value,
    reviewInputPath: reviewInputPath.value,
    ...(resultPath === undefined ? {} : { resultPath: resultPath.value }),
    debugPath: debugPath.value,
    startedAt: startedAt.value,
    ...(completedAt === undefined ? {} : { completedAt: completedAt.value }),
  });
}

function parseSessionState(
  input: v.InferOutput<typeof sessionStateSchema>,
): Result<ReviewSessionState, StorageFailure> {
  if (input._tag === "Created") return ok(input);
  if (input._tag === "Stale") {
    const currentHeadSha =
      input.currentHeadSha === undefined
        ? undefined
        : parseGitSha(input.currentHeadSha);
    if (currentHeadSha !== undefined && currentHeadSha._tag === "err")
      return invalidRead();
    return ok({
      _tag: "Stale",
      reason: input.reason,
      ...(currentHeadSha === undefined
        ? {}
        : { currentHeadSha: currentHeadSha.value }),
    });
  }
  if (input._tag === "Merged") {
    const mergedAt = parseIsoTimestamp(input.mergedAt);
    return mergedAt._tag === "err"
      ? invalidRead()
      : ok({ _tag: "Merged", mergedAt: mergedAt.value });
  }
  if (input._tag === "Discarded") {
    const attemptId =
      input.attemptId === undefined
        ? undefined
        : parseReviewAttemptId(input.attemptId);
    if (attemptId !== undefined && attemptId._tag === "err") return invalidRead();
    return ok({
      _tag: "Discarded",
      ...(attemptId === undefined ? {} : { attemptId: attemptId.value }),
    });
  }
  const attemptId = parseReviewAttemptId(input.attemptId);
  if (attemptId._tag === "err") return invalidRead();
  if (input._tag === "ReviewFailed")
    return ok({
      _tag: "ReviewFailed",
      attemptId: attemptId.value,
      error: input.error,
    });
  return ok({ ...input, attemptId: attemptId.value });
}

function parseStoredBatch(
  input: v.InferOutput<typeof reviewSessionSchema>,
): Result<
  {
    readonly batch?: Pick<ReviewBatch, "state">;
    readonly batchContent?: ReviewBatch;
  },
  StorageFailure
> {
  if (input.schemaVersion === 3) {
    if (input.draft !== undefined || input.draftContent !== undefined) {
      return invalidRead();
    }
    if (
      (input.batch === undefined) !== (input.batchContent === undefined)
    ) {
      return invalidRead();
    }
    if (input.batchContent === undefined || input.batch === undefined) {
      return ok({});
    }

    const batchContent = parseReviewBatch(input.batchContent);
    if (
      batchContent._tag === "err" ||
      !isDeepStrictEqual(input.batch.state, batchContent.value.state)
    ) {
      return invalidRead();
    }
    return ok({
      batch: { state: batchContent.value.state },
      batchContent: batchContent.value,
    });
  }

  if (input.batch !== undefined || input.batchContent !== undefined) {
    return invalidRead();
  }
  if ((input.draft === undefined) !== (input.draftContent === undefined)) {
    return invalidRead();
  }
  if (input.draft === undefined || input.draftContent === undefined) {
    return ok({});
  }

  const draftState = parseDraftState(input.draft.state);
  const draftContent = parseReviewDraft(input.draftContent);
  if (
    draftState._tag === "err" ||
    draftContent._tag === "err" ||
    draftState.value._tag !== "LocalDraft" ||
    draftContent.value.state._tag !== draftState.value._tag
  ) {
    return invalidRead();
  }

  const migrated = migrateLocalDraft(draftContent.value);
  return migrated._tag === "err"
    ? invalidRead()
    : ok({
        batch: { state: migrated.value.state },
        batchContent: migrated.value,
      });
}

function migrateLocalDraft(
  draft: ReviewDraft,
): Result<ReviewBatch, StorageFailure> {
  const items: ReviewBatch["items"][number][] = [];
  const itemIds = new Set<string>();
  for (const comment of draft.comments) {
    let itemIdValue: string = comment.findingId;
    let suffix = 2;
    while (itemIds.has(itemIdValue)) {
      itemIdValue = `${comment.findingId}-${suffix}`;
      suffix += 1;
    }
    const itemId = parseLocalReviewItemId(itemIdValue);
    if (itemId._tag === "err") {
      return invalidRead();
    }
    itemIds.add(itemId.value);
    items.push({
      _tag: "InlineComment",
      id: itemId.value,
      source: "finding",
      findingId: comment.findingId,
      anchor: {
        path: comment.path,
        startLine: comment.line,
        line: comment.lineEnd ?? comment.line,
        side: comment.diffSide,
      },
      body: comment.body,
      include: comment.include,
      postability: comment.postability,
    });
  }

  const migrated = parseReviewBatch({
    sessionId: draft.sessionId,
    attemptId: draft.attemptId,
    state: { _tag: "Local" },
    summaryBody: draft.summaryBody,
    suggestedEvent: draft.suggestedEvent,
    items,
    receipts: [],
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  });
  return migrated._tag === "err" ? invalidRead() : ok(migrated.value);
}

function parseDraftState(
  input: v.InferOutput<typeof draftStateSchema>,
): Result<ReviewDraftState, StorageFailure> {
  return ok(input);
}

function parseSubmittedReview(input: {
  readonly reviewId: string;
  readonly event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
  readonly submittedAt: string;
}): Result<NonNullable<ReviewSession["submittedReview"]>, StorageFailure> {
  const submittedAt = parseIsoTimestamp(input.submittedAt);
  return submittedAt._tag === "err"
    ? invalidRead()
    : ok({ ...input, submittedAt: submittedAt.value });
}

function parseMergeDecision(input: {
  readonly mergedAt: string;
  readonly mergeCommitSha?: string;
}): Result<NonNullable<ReviewSession["mergeDecision"]>, StorageFailure> {
  const mergedAt = parseIsoTimestamp(input.mergedAt);
  const mergeCommitSha =
    input.mergeCommitSha === undefined
      ? undefined
      : parseGitSha(input.mergeCommitSha);
  if (
    mergedAt._tag === "err" ||
    (mergeCommitSha !== undefined && mergeCommitSha._tag === "err")
  )
    return invalidRead();
  return ok({
    mergedAt: mergedAt.value,
    ...(mergeCommitSha === undefined
      ? {}
      : { mergeCommitSha: mergeCommitSha.value }),
  });
}

function parseAttemptState(
  input: v.InferOutput<typeof attemptStateSchema>,
): Result<ReviewAttemptState, StorageFailure> {
  if (input._tag === "Starting" || input._tag === "Running" || input._tag === "Failed") return ok(input);
  if (input._tag === "Completed") {
    const resultPath = parseAbsolutePath(input.resultPath);
    return resultPath._tag === "err"
      ? invalidRead()
      : ok({ _tag: "Completed", resultPath: resultPath.value });
  }
  if (input._tag === "Interrupted") {
    const interruptedAt = parseIsoTimestamp(input.interruptedAt);
    return interruptedAt._tag === "err"
      ? invalidRead()
      : ok({ _tag: "Interrupted", interruptedAt: interruptedAt.value });
  }
  const timestamp = parseIsoTimestamp(
    input._tag === "Discarded" ? input.discardedAt : input.completedAt,
  );
  if (timestamp._tag === "err") return invalidRead();
  return input._tag === "Discarded"
    ? ok({ _tag: "Discarded", discardedAt: timestamp.value })
    : ok({
        _tag: "IgnoredLateResult",
        completedAt: timestamp.value,
        reason: input.reason,
      });
}

function parseDebugTraceEvent(
  input: unknown,
): Result<DebugTraceEvent, StorageFailure> {
  const raw = v.safeParse(debugEventSchema, input);
  if (!raw.success)
    return err({
      _tag: "StorageFailure",
      operation: "append",
      reason: "invalid_stored_value",
    });
  const at = parseIsoTimestamp(raw.output.at);
  const attemptId =
    raw.output.attemptId === undefined
      ? undefined
      : parseReviewAttemptId(raw.output.attemptId);
  if (
    at._tag === "err" ||
    (attemptId !== undefined && attemptId._tag === "err")
  )
    return err({
      _tag: "StorageFailure",
      operation: "append",
      reason: "invalid_stored_value",
    });
  return ok({
    ...raw.output,
    at: at.value,
    ...(attemptId === undefined ? {} : { attemptId: attemptId.value }),
  });
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

function hasSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSensitiveKey);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, nestedValue]) =>
      /(?:token|secret|authorization|cookie|password)/i.test(key) ||
      hasSensitiveKey(nestedValue),
  );
}

function hasRawNotes(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "rawNotes")
  );
}
