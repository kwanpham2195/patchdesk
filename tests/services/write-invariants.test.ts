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
import {
  issueAgainstUnavailable,
  issueTwiceAgainstSetBackedRemote,
  metadataFlows,
} from "./write-invariant-metadata-flows";

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
 * The seven pull-request metadata writes — labels, assignees, reviewers — are
 * NOT rows in this table. They are exempt, and the exemption is executable:
 * see the second `describe` below and the file docstring of
 * `write-invariant-metadata-flows.ts` for why holding them to invariant 2
 * would make a timed-out label click worse rather than better, and for the
 * two places the exemption still fails a future appending metadata write.
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
      const controller = new MergeWriteController(
        // SAFETY: the recorded gateway implements exactly the reads and the one
        // write this flow performs; no other gateway method is reached.
        recorded(trace, gateway) as never,
        ["squash"],
        now,
        operations,
        // SAFETY: this fixture gate answers with the parsed fixture Review and
        // session; the controller reads no other gate field.
        {
          requireFresh: async () =>
            ok({
              profile: values.profile,
              review: values.review,
              session: mergeSession,
              snapshot: values.snapshot,
            }),
        } as never,
        {
          reviews: {
            load: async () => ok(values.review),
            save: async () => ok(undefined),
          },
          // SAFETY: this fixture answers the one Insight read the merge gate
          // makes -- the current Analysis -- with "no Analysis stored".
          insights: {
            loadTyped: async () =>
              err({
                _tag: "StorageFailure",
                operation: "read",
                reason: "not_found",
              }),
          },
        } as never,
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

/**
 * The inverted rows: the seven metadata writes, asserting the property that
 * makes their exemption from the two invariants above SAFE, rather than
 * asserting invariants that would make a timed-out label click worse.
 *
 * Read together, the three assertions per row say: the flow issues exactly
 * one write, that write is a keyed set operation, and issuing it again is a
 * no-op on the member set. So a crash between the request and the response
 * leaves either "applied" or "not applied" — never "half applied", and never
 * a duplicate — and the user's re-click is free. That is why these flows need
 * no durable intent and must not be locked into `OutcomeUnknown`.
 *
 * `reviewers: request` is the one row that pays something for its re-click,
 * and it says so in a passing assertion rather than in a comment.
 */
describe("every pull request metadata write is an idempotent set operation", () => {
  for (const flow of metadataFlows) {
    it(`${flow.name} issues exactly one gateway write and never retries it itself`, async () => {
      const writes = await issueAgainstUnavailable(flow);
      expect(
        writes,
        `${flow.name} did not issue exactly one gateway write, so a crash could leave it half applied`,
      ).toHaveLength(1);
    });

    it(`${flow.name} addresses its members by key, so a duplicate is not representable`, async () => {
      const run = await issueTwiceAgainstSetBackedRemote(flow);
      expect(
        run.operations.length,
        `${flow.name} reached no modelled metadata write: ${flow.reason}`,
      ).toBe(2);
      const [first, second] = run.operations;
      expect(
        first?.members,
        `${flow.name} named no members, so its write is not keyed`,
      ).not.toEqual([]);
      expect(
        second,
        `${flow.name} did not re-issue the identical set operation`,
      ).toEqual(first);
    });

    it(`${flow.name} leaves the member set unchanged when issued a second time`, async () => {
      const run = await issueTwiceAgainstSetBackedRemote(flow);
      expect(
        run.afterSecond,
        `${flow.name} changed the member set on the second issue: ${flow.reason}`,
      ).toEqual(run.afterFirst);
      // The one honest asymmetry: a re-request re-opens an answered review
      // request and pings the reviewer again, so its second issue is NOT free.
      if (flow.retryCost === "notifies-a-human") {
        expect(
          run.notifiedBySecond,
          `${flow.name} is recorded as notifying a human on retry: ${flow.reason}`,
        ).toBeGreaterThan(0);
        return;
      }
      expect(
        run.notifiedBySecond,
        `${flow.name} notified somebody on the second issue, so its retry is not free`,
      ).toBe(0);
    });
  }
});
