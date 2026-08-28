import { err, ok } from "../../src/domain/result";
import { InlineConversationService } from "../../src/services/inline-conversation-service";
import { PublishedFeedbackService } from "../../src/services/published-feedback-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import type { Result } from "../../src/domain/result";
import {
  anchor,
  at,
  expected,
  now,
  profileId,
  reviewId,
  threadId,
  values,
} from "./review-invariant-fixtures";
import {
  recentWritesJournal,
  recorded,
  recordingSessions,
  sessionIntentTag,
  unavailable,
  type Trace,
  type WriteFlow,
} from "./write-invariant-harness";

/**
 * WHAT F1 HAS TO CHANGE HERE, for both groups below.
 *
 * Not just `todo`. Every row in this file builds a `recordingSessions` store
 * and reads `sessions.current()` for its `intentTag`, but never hands that
 * store to the service — because it cannot. `InlineConversationService`'s
 * constructor is `(gate, github, writeCoordinator, now, recentWrites)` and
 * `PublishedFeedbackService`'s is `(gate, github, coordinator, refresh?)`;
 * neither takes a `ReviewSessionStore`, and the gate they do take is a
 * `Pick<ReviewWriteGate, …>` that returns session VALUES with no save path.
 * So the stores below are inert today and the rows are red for a real
 * reason, not a wiring slip.
 *
 * When F1 lands, three edits are needed per group, not one: add the session
 * store to the service constructor, pass `sessions` into BOTH constructions
 * in this file, and then drop the row's `todo`. Only the third is a flag
 * flip.
 */

/**
 * The five Diff-conversation writes. None of them touches a session store at
 * all: `InlineConversationService`'s constructor takes no `ReviewSessionStore`,
 * so no intent can be persisted and a retry re-issues the write.
 */
function inlineConversationFlows(): ReadonlyArray<WriteFlow> {
  const commands = [
    {
      name: "create comment",
      command: {
        _tag: "CreateComment" as const,
        expected,
        anchor,
        body: "note",
      },
    },
    {
      name: "reply",
      command: {
        _tag: "Reply" as const,
        expected,
        threadId,
        body: "note",
      },
    },
    {
      name: "resolve thread",
      command: {
        _tag: "SetThreadState" as const,
        expected,
        threadId,
        state: "resolved" as const,
      },
    },
    {
      name: "edit comment",
      command: {
        _tag: "EditComment" as const,
        expected,
        commentId: "comment-1",
        body: "edited",
      },
    },
    {
      name: "delete comment",
      command: {
        _tag: "DeleteComment" as const,
        expected,
        commentId: "comment-1",
        confirmation: true,
      },
    },
  ];
  return commands.map(({ name, command }) => ({
    name: `inline conversation: ${name}`,
    todo: "F1 — InlineConversationService persists no write intent",
    run: async () => {
      const trace: Trace = [];
      const sessions = recordingSessions(trace, values.session);
      const gateway = {
        getPullRequest: async () => ok(values.snapshot.pullRequest),
        getReviewThreadTarget: async () => ok({ found: true }),
        getReviewCommentTarget: async () =>
          ok({ found: true, viewerDidAuthor: true }),
        createInlineComment: async () => err(unavailable),
        createThreadReply: async () => err(unavailable),
        setReviewThreadState: async () => err(unavailable),
        updateThreadComment: async () => err(unavailable),
        deleteThreadComment: async () => err(unavailable),
      };
      const service = new InlineConversationService(
        // SAFETY: this fixture gate answers with the parsed fixture session;
        // the service reads no other gate field.
        {
          requireFresh: async () =>
            ok({ profile: values.profile, session: values.session }),
        } as never,
        // SAFETY: the recorded gateway implements exactly the reads and the one
        // write this flow performs; no other gateway method is reached.
        recorded(trace, gateway) as never,
        new ReviewOperationCoordinator(),
        now,
        recentWritesJournal(trace),
      );
      const issue = () => service.execute({ profileId, reviewId, command });
      await issue();
      return {
        trace,
        again: issue,
        intentTag: () => sessionIntentTag(sessions.current()),
      };
    },
  }));
}

/**
 * The three published-feedback writes. Like the inline conversation ones,
 * `PublishedFeedbackService` takes no session store; `afterWrite` maps every
 * gateway failure, unavailable included, to `github_write_failed`.
 */
function publishedFeedbackFlows(): ReadonlyArray<WriteFlow> {
  const feedback = {
    reviews: [
      {
        id: "published-1",
        author: "fixture",
        body: "",
        event: "APPROVED" as const,
        submittedAt: at,
        canDismiss: true,
      },
    ],
    comments: [
      {
        id: "comment-1",
        author: "fixture",
        body: "old",
        createdAt: at,
        canEdit: true,
        canDelete: true,
      },
    ],
    complete: true,
  };
  const commands: ReadonlyArray<{
    readonly name: string;
    readonly issue: (
      service: PublishedFeedbackService,
    ) => Promise<Result<unknown, unknown>>;
  }> = [
    {
      name: "edit comment",
      issue: (service) =>
        service.editComment({
          profileId,
          reviewId,
          commentId: "comment-1",
          body: "edited",
        }),
    },
    {
      name: "delete comment",
      issue: (service) =>
        service.deleteComment({
          profileId,
          reviewId,
          commentId: "comment-1",
          confirmation: true,
        }),
    },
    {
      name: "dismiss review",
      issue: (service) =>
        service.dismissReview({
          profileId,
          reviewId,
          publishedReviewId: "published-1",
          message: "stale",
          confirmation: true,
        }),
    },
  ];
  return commands.map(({ name, issue }) => ({
    name: `published feedback: ${name}`,
    todo: "F1 — PublishedFeedbackService persists no write intent",
    run: async () => {
      const trace: Trace = [];
      const sessions = recordingSessions(trace, values.session);
      const gateway = {
        getPullRequest: async () => ok(values.snapshot.pullRequest),
        getPullRequestComments: async () => ok(values.snapshot.comments),
        getPullRequestPublishedFeedback: async () => ok(feedback),
        updateReviewComment: async () => err(unavailable),
        deleteReviewComment: async () => err(unavailable),
        dismissReview: async () => err(unavailable),
      };
      const service = new PublishedFeedbackService(
        // SAFETY: this fixture gate answers with the parsed fixture Review and
        // session; the service reads no other gate field.
        {
          requireFresh: async () =>
            ok({
              profile: values.profile,
              review: values.review,
              session: values.session,
              snapshot: values.snapshot,
            }),
        } as never,
        // SAFETY: the recorded gateway implements exactly the reads and the one
        // write this flow performs; no other gateway method is reached.
        recorded(trace, gateway) as never,
        new ReviewOperationCoordinator(),
      );
      await issue(service);
      return {
        trace,
        again: () => issue(service),
        intentTag: () => sessionIntentTag(sessions.current()),
      };
    },
  }));
}

/** Every Diff-conversation and published-feedback write, in one list. */
export function conversationFlows(): ReadonlyArray<WriteFlow> {
  return [...inlineConversationFlows(), ...publishedFeedbackFlows()];
}
