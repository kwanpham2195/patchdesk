import { vi } from "vitest";

import { MergeOperationStore } from "../../src/adapters/storage/merge-operation-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { RecentWriteJournalStore } from "../../src/adapters/storage/recent-write-journal-store";
import type { StorageFailure } from "../../src/adapters/storage/json-file";
import type { MergeOperation } from "../../src/domain/merge-operation";
import type { PendingReviewState } from "../../src/domain/pending-review";
import type { ReviewWriteOperation } from "../../src/domain/review-write-operation";
import {
  createReviewSession,
  type ReviewSession,
} from "../../src/domain/review-session";
import { err, ok, type Result } from "../../src/domain/result";
import { PendingReviewService } from "../../src/services/pending-review-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import {
  anchor,
  at,
  login,
  reviewCommentId,
  reviewNodeId,
  reviewRestId,
  threadId,
  values,
} from "./review-invariant-fixtures";

/**
 * The recording seams `write-invariants.test.ts` states its two invariants
 * over: one ordered trace per flow, a session store that reports the durable
 * intent tag of every save, and the merge flow's own intent store.
 *
 * Every row hands in a plain object of gateway methods rather than a
 * `FakeGitHubAdapter`: the shared double answers with fixtures but records
 * nothing, and these invariants are entirely about the ORDER of calls.
 */

/** The gateway methods that MUTATE GitHub, as opposed to reading it. */
export const GATEWAY_WRITES: ReadonlySet<string> = new Set([
  "startPendingReviewWithThread",
  "addPendingReviewThread",
  "submitPendingReview",
  "discardPendingReview",
  "createPendingReview",
  "createDirectSummaryReview",
  "createInlineComment",
  "createThreadReply",
  "setReviewThreadState",
  "updateThreadComment",
  "deleteThreadComment",
  "updateReviewComment",
  "deleteReviewComment",
  "dismissReview",
  "addLabelsToLabelable",
  "removeLabelsFromLabelable",
  "addAssigneesToAssignable",
  "removeAssigneesFromAssignable",
  "requestReviews",
  "removeRequestedReviewers",
  "setPullRequestDraftState",
  "mergePullRequest",
]);

/** Durable state tags that mean "a remote write may have happened". */
export const IN_FLIGHT_TAGS: ReadonlySet<string> = new Set([
  "WriteInFlight",
  "Requested",
  "OutcomeUnknown",
]);
/** The one tag every flow must end in when the gateway answers `unavailable`. */
export const OUTCOME_UNKNOWN = "OutcomeUnknown";

/**
 * One ordered log per flow run. Entries are `intent:<tag>`, `write:<method>`
 * and `read:<method>`; the invariants are stated purely as positions in it.
 */
export type Trace = Array<string>;

export const unavailable = {
  _tag: "GitHubWriteFailure",
  category: "unavailable",
  message: "fixture timeout",
} as const;

/** What a row's gateway write answers: a lost response or a confirmed success. */
export type GatewayWriteOutcome = "unavailable" | "confirmed";

/** What the own-write journal's `append` answers after a confirmed write. */
export type JournalAppendOutcome = "stored" | "failed";

/** The two fixtures every row constructor takes instead of hard-coding them. */
export type WriteFlowFixture = {
  readonly gateway: GatewayWriteOutcome;
  readonly journal: JournalAppendOutcome;
};

/** The fixture the intent and lock invariants run under. */
export const unavailableWrite: WriteFlowFixture = {
  gateway: "unavailable",
  journal: "stored",
};

/** The fixture the confirmed-write invariant runs under. */
export const confirmedWriteFailingJournal: WriteFlowFixture = {
  gateway: "confirmed",
  journal: "failed",
};

/** One gateway write answering `unavailable` or the given success value. */
export function gatewayWrite<T>(
  fixture: WriteFlowFixture,
  confirmed: T,
): () => Promise<Result<T, typeof unavailable>> {
  return async () =>
    fixture.gateway === "unavailable" ? err(unavailable) : ok(confirmed);
}

/** One gateway method, in the only shape this file calls one. */
export type GatewayCall = (input: never) => Promise<Result<unknown, unknown>>;

/**
 * Wraps a gateway so every method call lands in the trace, tagged read or
 * write. Every row hands in a plain object of gateway methods rather than a
 * `FakeGitHubAdapter`: the shared double answers with fixtures but records
 * nothing, and these invariants are entirely about the ORDER of calls.
 */
export function recorded<T extends Record<string, GatewayCall>>(
  trace: Trace,
  gateway: T,
): T {
  const recording = Object.entries(gateway).map(([name, method]) => [
    name,
    async (input: never) => {
      trace.push(`${GATEWAY_WRITES.has(name) ? "write" : "read"}:${name}`);
      return method(input);
    },
  ]);
  // SAFETY: every value is the same function with the same signature, wrapped;
  // `Object.fromEntries` loses only the key literals TypeScript already knows.
  return Object.fromEntries(recording) as T;
}

/** The durable-intent tag a stored session carries, if any. */
export function sessionIntentTag(session: ReviewSession): string | undefined {
  return (
    session.pendingReview?._tag ??
    session.directSummaryReview?._tag ??
    undefined
  );
}

/**
 * A `ReviewSessionStore` that records the intent tag of every save. This is
 * the seam invariant 1 watches: a flow that never calls `save` produces no
 * `intent:` entry at all, which is exactly the bug the blockers plan's M7
 * describes for inline conversation and published feedback.
 */
export function recordingSessions(trace: Trace, initial: ReviewSession) {
  let stored = initial;
  return {
    load: async (): Promise<Result<ReviewSession, StorageFailure>> =>
      ok(stored),
    save: async (
      next: ReviewSession,
    ): Promise<Result<void, StorageFailure>> => {
      stored = next;
      const tag = sessionIntentTag(next);
      if (tag !== undefined) trace.push(`intent:${tag}`);
      return ok(undefined);
    },
    current: (): ReviewSession => stored,
  };
}

/** In-memory `MergeOperationStore`: the merge flow's own intent store. */
export class TracingMergeOperationStore extends MergeOperationStore {
  private operation: MergeOperation | undefined;

  constructor(private readonly trace: Trace) {
    super(PatchdeskPaths.forTest("/tmp/patchdesk-write-invariants"));
  }

  override async begin(
    operation: MergeOperation,
  ): Promise<Awaited<ReturnType<MergeOperationStore["begin"]>>> {
    if (
      this.operation !== undefined &&
      this.operation.state._tag !== "Rejected"
    )
      return err({ _tag: "MergeOperationExists" });
    this.operation = operation;
    this.trace.push(`intent:${operation.state._tag}`);
    return ok(undefined);
  }

  override async markOutcomeUnknown(
    operation: MergeOperation,
  ): Promise<Awaited<ReturnType<MergeOperationStore["markOutcomeUnknown"]>>> {
    this.operation = operation;
    this.trace.push(`intent:${operation.state._tag}`);
    return ok(undefined);
  }

  override async confirm(
    operation: MergeOperation,
  ): Promise<Awaited<ReturnType<MergeOperationStore["confirm"]>>> {
    this.operation = operation;
    return ok(undefined);
  }

  override async reject(
    operation: MergeOperation,
  ): Promise<Awaited<ReturnType<MergeOperationStore["reject"]>>> {
    this.operation = operation;
    return ok(undefined);
  }

  override async removeAfterSessionReceipt(): Promise<
    Awaited<ReturnType<MergeOperationStore["removeAfterSessionReceipt"]>>
  > {
    this.operation = undefined;
    return ok(undefined);
  }

  intentTag(): string | undefined {
    return this.operation?.state._tag;
  }
}

/** One run of one write entry point under one `WriteFlowFixture`. */
export type FlowRun = {
  readonly trace: Trace;
  /** What the first issue of the command answered. */
  readonly result: Result<unknown, unknown>;
  /** Reissues the identical command against the same durable state. */
  readonly again: () => Promise<Result<unknown, unknown>>;
  /** The durable intent tag left behind, or `undefined` when none was stored. */
  readonly intentTag: () => string | undefined;
  /** The durable state still refusing this Review's next write, if any. */
  readonly writeLock: () => string | undefined;
};

export type WriteFlow = {
  readonly name: string;
  /** Issues the command once under the fixture its row was built with. */
  readonly run: () => Promise<FlowRun>;
  /** Set when the row fails on `main`; names the program item that fixes it. */
  readonly todo?: string;
};

/**
 * The own-write journal, as a recording seam over the real store, so the
 * store's own failure policy runs. Every flow appends only AFTER a confirmed
 * write, so `journal:append` is never durable intent; it is visible in the
 * trace so an append moved ahead of `write:…` would show up there.
 */
export class TracingRecentWriteJournal extends RecentWriteJournalStore {
  constructor(
    private readonly trace: Trace,
    private readonly outcome: JournalAppendOutcome,
  ) {
    super(PatchdeskPaths.forTest("/tmp/patchdesk-write-invariants"), {
      write: () => undefined,
    });
  }

  override async append(): Promise<
    Awaited<ReturnType<RecentWriteJournalStore["append"]>>
  > {
    this.trace.push("journal:append");
    return this.outcome === "stored"
      ? ok(undefined)
      : err({ _tag: "StorageFailure", operation: "read", reason: "io" });
  }
}

/** The journal double service tests hand in; `appendConfirmed` records its calls. */
export function confirmedWriteJournal() {
  return { appendConfirmed: vi.fn(async () => undefined) };
}

/** In-memory `ReviewWriteOperationStore` that traces every intent it stores. */
export function recordingWriteOperations(
  trace: Trace,
  initial?: ReviewWriteOperation,
) {
  let operation = initial;
  return {
    load: async () => ok(operation),
    begin: async (next: ReviewWriteOperation) => {
      trace.push(`intent:${next.state._tag}`);
      operation = next;
      return ok(undefined);
    },
    markOutcomeUnknown: async (next: ReviewWriteOperation) => {
      trace.push(`intent:${next.state._tag}`);
      operation = next;
      return ok(undefined);
    },
    confirm: async (next: ReviewWriteOperation) => {
      trace.push(`intent:${next.state._tag}`);
      operation = next;
      return ok(undefined);
    },
    reject: async () => {
      operation = undefined;
      return ok(undefined);
    },
    remove: async () => {
      operation = undefined;
      return ok(undefined);
    },
    current: () => operation,
  };
}

/** Issues a command once and describes the run through its operation store. */
export async function recordedWriteFlowRun(
  trace: Trace,
  issue: () => Promise<Result<unknown, unknown>>,
  operations: { readonly current: () => ReviewWriteOperation | undefined },
): Promise<FlowRun> {
  const result = await issue();
  const tag = () => operations.current()?.state._tag;
  return { trace, result, again: issue, intentTag: tag, writeLock: tag };
}

/** A session's intent tag, but only while it still refuses the next write. */
export function sessionWriteLock(session: ReviewSession): string | undefined {
  const tag = sessionIntentTag(session);
  return tag !== undefined && IN_FLIGHT_TAGS.has(tag) ? tag : undefined;
}

const now = () => at;

/**
 * The merge flow re-derives revision identity from the live diff, so its
 * session must carry no `canonicalPatchHash` — the fixture's placeholder hash
 * would read as a changed revision and the flow would never reach its write.
 * Same key as the shared fixture session, so the id is the same.
 */
export const mergeSession = createReviewSession({
  key: values.session.key,
  pr: values.session.pr,
  patchPath: values.session.patchPath,
  worktree: values.session.worktree,
  createdAt: values.session.createdAt,
});

/** Pending-review and direct-summary flows share this fresh-gate shape. */
export function freshGate(sessions: { current: () => ReviewSession }) {
  return {
    requireFresh: async () =>
      ok({
        profile: values.profile,
        review: values.review,
        session: sessions.current(),
        snapshot: values.snapshot,
      }),
    requireCurrentSession: async () =>
      ok({
        profile: values.profile,
        review: values.review,
        session: sessions.current(),
      }),
  };
}

/** A session carrying an already-open pending review, for add/submit/discard. */
export function pendingOwner(): Extract<
  PendingReviewState,
  { _tag: "Pending" }
> {
  return {
    _tag: "Pending",
    review: {
      restId: reviewRestId,
      nodeId: reviewNodeId,
      author: login,
      pr: {
        host: values.identity.host,
        owner: values.identity.owner,
        repo: values.identity.repo,
        number: values.identity.prNumber,
      },
      headSha: values.headSha,
      comments: [
        {
          reviewCommentId,
          threadId,
          body: "body",
          anchor,
          createdAt: at,
        },
      ],
      createdAt: at,
      updatedAt: at,
    },
  };
}

/** A confirmed start or add-thread answer: the open pending review and its new thread. */
const pendingThreadWrite = {
  review: pendingOwner().review,
  createdThreadId: threadId,
};

export function pendingReviewFlow(
  fixture: WriteFlowFixture,
  state: PendingReviewState,
  command: (service: PendingReviewService) => Promise<Result<unknown, unknown>>,
): () => Promise<FlowRun> {
  return async () => {
    const trace: Trace = [];
    const sessions = recordingSessions(trace, {
      ...values.session,
      pendingReview: state,
    });
    const gateway = {
      getPullRequest: async () => ok(values.snapshot.pullRequest),
      startPendingReviewWithThread: gatewayWrite(fixture, pendingThreadWrite),
      addPendingReviewThread: gatewayWrite(fixture, pendingThreadWrite),
      submitPendingReview: gatewayWrite(fixture, { reviewId: reviewRestId }),
      discardPendingReview: gatewayWrite(fixture, undefined),
    };
    const service = new PendingReviewService(
      // SAFETY: this fixture gate answers with the parsed fixture Review and
      // the store's current session; the service reads no other gate field.
      freshGate(sessions) as never,
      sessions,
      // SAFETY: the recorded gateway implements exactly the reads and the one
      // write this flow performs; no other gateway method is reached.
      recorded(trace, gateway) as never,
      now,
      new ReviewOperationCoordinator(),
      new TracingRecentWriteJournal(trace, fixture.journal),
    );
    const result = await command(service);
    return {
      trace,
      result,
      again: () => command(service),
      intentTag: () => sessionIntentTag(sessions.current()),
      writeLock: () => sessionWriteLock(sessions.current()),
    };
  };
}
