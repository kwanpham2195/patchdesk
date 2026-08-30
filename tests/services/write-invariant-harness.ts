import { MergeOperationStore } from "../../src/adapters/storage/merge-operation-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
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

/** One run of one write entry point against an unavailable gateway write. */
export type FlowRun = {
  readonly trace: Trace;
  /** Reissues the identical command against the same durable state. */
  readonly again: () => Promise<Result<unknown, unknown>>;
  /** The durable intent tag left behind, or `undefined` when none was stored. */
  readonly intentTag: () => string | undefined;
};

export type WriteFlow = {
  readonly name: string;
  /** Issues the command once; the gateway's write answers `unavailable`. */
  readonly run: () => Promise<FlowRun>;
  /** Set when the row fails on `main`; names the program item that fixes it. */
  readonly todo?: string;
};

/**
 * The own-write journal, as a recording seam. `runGuardedMetadataWrite` and
 * the pending-review flows append here only AFTER a confirmed write, so a
 * `journal:append` entry is never durable intent — but it is now VISIBLE in
 * the trace, which it was not before. Invariant 1 is still stated over
 * `intent:` entries alone, deliberately: an append that happens after the
 * gateway confirms cannot precede the gateway write it describes. An
 * implementation that moved the append BEFORE the write, to use the journal
 * as durable intent, would now show up here as `journal:append` ahead of
 * `write:…` — visible to a reader and to a debugger, and the row would then
 * need `IN_FLIGHT_TAGS` widened to accept it rather than failing silently
 * invisible.
 */
export function recentWritesJournal(trace: Trace) {
  let operation: ReviewWriteOperation | undefined;
  return {
    append: async () => {
      trace.push("journal:append");
      return ok(undefined);
    },
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
export function pendingOwner(): PendingReviewState {
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

export function pendingReviewFlow(
  state: PendingReviewState,
  command: (service: PendingReviewService) => Promise<Result<unknown, unknown>>,
): () => Promise<FlowRun> {
  return async () => {
    const trace: Trace = [];
    const sessions = recordingSessions(trace, {
      ...values.session,
      pendingReview: state,
    });
    const service = new PendingReviewService(
      // SAFETY: this fixture gate answers with the parsed fixture Review and
      // the store's current session; the service reads no other gate field.
      freshGate(sessions) as never,
      sessions,
      // SAFETY: the recorded gateway implements exactly the reads and the one
      // write this flow performs; no other gateway method is reached.
      recorded(trace, {
        getPullRequest: async () => ok(values.snapshot.pullRequest),
        startPendingReviewWithThread: async () => err(unavailable),
        addPendingReviewThread: async () => err(unavailable),
        submitPendingReview: async () => err(unavailable),
        discardPendingReview: async () => err(unavailable),
      }) as never,
      now,
      new ReviewOperationCoordinator(),
      recentWritesJournal(trace),
    );
    await command(service);
    return {
      trace,
      again: () => command(service),
      intentTag: () => sessionIntentTag(sessions.current()),
    };
  };
}
