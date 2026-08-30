import { describe, expect, it } from "vitest";

import { err, ok } from "../../src/domain/result";
import { DirectSummaryReviewService } from "../../src/services/direct-summary-review-service";
import { MergeWriteController } from "../../src/services/merge-write-controller";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import {
  anchor,
  at,
  expected,
  now,
  profileId,
  reviewId,
  reviewNodeId,
  values,
} from "./review-invariant-fixtures";
import {
  IN_FLIGHT_TAGS,
  OUTCOME_UNKNOWN,
  freshGate,
  mergeSession,
  pendingOwner,
  pendingReviewFlow,
  recentWritesJournal,
  recorded,
  recordingSessions,
  sessionIntentTag,
  unavailable,
  TracingMergeOperationStore,
  type Trace,
  type WriteFlow,
} from "./write-invariant-harness";
import { conversationFlows } from "./write-invariant-conversation-flows";
import { metadataFlows } from "./write-invariant-metadata-flows";

/**
 * One table over EVERY GitHub write entry point in the application, asserting
 * the two invariants the audit-blockers plan restores. Written as a table so
 * a flow added later cannot quietly skip them: a new entry point is a new row
 * in `writeFlows`, and both invariants run against it automatically.
 *
 * Invariant 1 — durable intent precedes the remote boundary. Before the first
 * call that MUTATES GitHub, the flow must have persisted an in-flight intent
 * (`WriteInFlight` in a `ReviewSession`, `Requested`/`OutcomeUnknown` in the
 * merge-operation store). Gateway READS before that point are deliberately
 * allowed and are not violations: `requireCurrentHead`, ownership checks and
 * permission checks cannot create a duplicate, so the boundary that matters is
 * the first write, not the first call.
 *
 * Invariant 2 — an unavailable outcome locks the flow. When the gateway write
 * fails with `category: "unavailable"` (timeout, lost response), the durable
 * state must end in an outcome-unknown tag, and the SAME command issued a
 * second time must not reach the gateway's write again. Retrying an
 * unconfirmed write is how one comment becomes two.
 *
 * Rows that fail today are `it.todo` and name the program item that will make
 * them pass. Their exact observed failure is recorded in
 * `.agents/PLANS/program/reports/E12.md`; the one-line reason is on the row.
 *
 * Pull-request metadata writes are ordinary rows in this table. Replaying a
 * reviewer request can notify a human again, and all metadata uncertainty
 * must retain the same durable no-replay lock as conversation writes.
 */

const writeFlows: ReadonlyArray<WriteFlow> = [
  {
    name: "pending review: start",
    run: pendingReviewFlow({ _tag: "None" }, (service) =>
      service.start({ profileId, reviewId, expected, anchor, body: "note" }),
    ),
  },
  {
    name: "pending review: add thread",
    run: pendingReviewFlow(pendingOwner(), (service) =>
      service.addThread({
        profileId,
        reviewId,
        expected,
        anchor,
        body: "note",
        pendingReviewNodeId: reviewNodeId,
      }),
    ),
  },
  {
    name: "pending review: submit",
    run: pendingReviewFlow(pendingOwner(), (service) =>
      service.submit({
        profileId,
        reviewId,
        expected,
        event: "COMMENT",
        summaryBody: "summary",
      }),
    ),
  },
  {
    name: "pending review: discard",
    run: pendingReviewFlow(pendingOwner(), (service) =>
      service.discard({ profileId, reviewId, expected, confirmation: true }),
    ),
  },
  {
    name: "direct summary: submit",
    run: async () => {
      const trace: Trace = [];
      const sessions = recordingSessions(trace, values.session);
      const gateway = {
        getPullRequest: async () => ok(values.snapshot.pullRequest),
        resolveAuthenticatedAccount: async () => ok({ account: "fixture" }),
        getViewerPendingReview: async () => ok({ _tag: "None" as const }),
        getViewerDirectSummaryReviews: async () =>
          ok({ reviews: [], complete: true }),
        createDirectSummaryReview: async () => err(unavailable),
      };
      const service = new DirectSummaryReviewService(
        // SAFETY: this fixture gate answers with the parsed fixture Review and
        // the store's current session; the service reads no other gate field.
        freshGate(sessions) as never,
        sessions,
        // SAFETY: the recorded gateway implements exactly the reads and the one
        // write this flow performs; no other gateway method is reached.
        recorded(trace, gateway) as never,
        now,
        new ReviewOperationCoordinator(),
        recentWritesJournal(trace),
      );
      const command = () =>
        service.submit({
          profileId,
          reviewId,
          expected,
          event: "COMMENT",
          body: "summary",
        });
      await command();
      return {
        trace,
        again: command,
        intentTag: () => sessionIntentTag(sessions.current()),
      };
    },
  },
  ...conversationFlows(),
  ...metadataFlows,
  {
    name: "merge",
    run: async () => {
      const trace: Trace = [];
      const operations = new TracingMergeOperationStore(trace);
      const gateway = {
        getPullRequest: async () =>
          ok({ ...values.snapshot.pullRequest, changedFileCount: 1 }),
        getPullRequestDiff: async () =>
          ok(
            "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n",
          ),
        getMergePolicy: async () =>
          ok({
            pr: {
              host: values.identity.host,
              owner: values.identity.owner,
              repo: values.identity.repo,
              number: values.identity.prNumber,
            },
            headSha: values.headSha,
            baseSha: values.baseSha,
            isOpen: true,
            isDraft: false,
            mergeability: "mergeable" as const,
            reviewDecision: "approved" as const,
            checks: { overall: "passing" as const, checks: [] },
            complete: true,
          }),
        mergePullRequest: async () => err(unavailable),
      };
      // SAFETY: the merge controller reads only the deterministic requireFresh result supplied here.
      const mergeWriteGate = {
        requireFresh: async () =>
          ok({
            profile: values.profile,
            review: values.review,
            session: mergeSession,
            snapshot: values.snapshot,
          }),
      } as never;
      // SAFETY: the merge controller reads only the recorded Review stores and current-Analysis absence supplied here.
      const mergeDependencies = {
        reviews: {
          load: async () => ok(values.review),
          save: async () => ok(undefined),
        },
        insights: {
          loadTyped: async () =>
            err({
              _tag: "StorageFailure",
              operation: "read",
              reason: "not_found",
            }),
        },
      } as never;
      const controller = new MergeWriteController(
        recorded(trace, gateway),
        ["squash"],
        now,
        operations,
        mergeWriteGate,
        mergeDependencies,
        new ReviewOperationCoordinator(),
      );
      const command = () =>
        controller.merge({
          profileId,
          reviewId,
          sessionId: mergeSession.id,
          expectedHeadSha: values.headSha,
          expectedBaseSha: values.baseSha,
          expectedPatchHash: expected.patchHash,
          expectedRevision: at,
          method: "squash",
          acknowledgedWarnings: {
            revision: {
              headSha: values.headSha,
              baseSha: values.baseSha,
              patchHash: expected.patchHash,
            },
            warningCodes: [],
          },
        });
      await command();
      return { trace, again: command, intentTag: () => operations.intentTag() };
    },
  },
];

function firstIndex(
  trace: ReadonlyArray<string>,
  predicate: (entry: string) => boolean,
): number {
  return trace.findIndex(predicate);
}

describe("every GitHub write persists intent before the remote boundary", () => {
  for (const flow of writeFlows) {
    const scenario = flow.todo === undefined ? it : it.todo;
    // A todo row's `flow.todo` names the program item that will make it pass.
    scenario(
      `${flow.name} persists intent before its first gateway write`,
      async () => {
        const run = await flow.run();
        const write = firstIndex(run.trace, (entry) =>
          entry.startsWith("write:"),
        );
        const intent = firstIndex(run.trace, (entry) =>
          IN_FLIGHT_TAGS.has(entry.slice("intent:".length)),
        );
        expect(
          write,
          `${flow.name} never reached a gateway write`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          intent,
          `${flow.name} persisted no in-flight intent`,
        ).toBeGreaterThanOrEqual(0);
        expect(intent).toBeLessThan(write);
      },
    );

    scenario(
      `${flow.name} locks on an unavailable outcome and refuses the retry`,
      async () => {
        const run = await flow.run();
        const tag = run.intentTag();
        expect(
          tag === undefined ? "<no durable intent>" : tag,
          `${flow.name} left no outcome-unknown state`,
        ).toBe(OUTCOME_UNKNOWN);
        const before = run.trace.length;
        await run.again();
        const retried = run.trace
          .slice(before)
          .filter((entry) => entry.startsWith("write:"));
        expect(retried, `${flow.name} re-issued the unconfirmed write`).toEqual(
          [],
        );
      },
    );
  }
});
