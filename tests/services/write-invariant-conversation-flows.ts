import { err, ok } from "../../src/domain/result";
import type { ReviewWriteOperation } from "../../src/domain/review-write-operation";
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
  unavailable,
  type Trace,
  type WriteFlow,
} from "./write-invariant-harness";

/** The five Diff-conversation writes share the durable operation store. */
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
    run: async () => {
      const trace: Trace = [];
      let operation: ReviewWriteOperation | undefined;
      const operations = {
        load: async () => ok(operation),
        begin: async (next: ReviewWriteOperation) => {
          operation = next;
          trace.push(`intent:${next.state._tag}`);
          return ok(undefined);
        },
        markOutcomeUnknown: async (next: ReviewWriteOperation) => {
          operation = next;
          trace.push(`intent:${next.state._tag}`);
          return ok(undefined);
        },
        confirm: async (next: ReviewWriteOperation) => {
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
      };
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
        operations,
      );
      const issue = () => service.execute({ profileId, reviewId, command });
      await issue();
      return {
        trace,
        again: issue,
        intentTag: () => operation?.state._tag,
      };
    },
  }));
}

/** The three published-feedback writes retain unavailable outcomes without replay. */
function publishedFeedbackFlows(): ReadonlyArray<WriteFlow> {
  const feedback = {
    reviews: [
      {
        id: "101",
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
          expected,
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
          expected,
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
          expected,
          publishedReviewId: "101",
          message: "stale",
          confirmation: true,
        }),
    },
  ];
  return commands.map(({ name, issue }) => ({
    name: `published feedback: ${name}`,
    run: async () => {
      const trace: Trace = [];
      let operation: ReviewWriteOperation | undefined;
      const operations = {
        load: async () => ok(operation),
        begin: async (next: ReviewWriteOperation) => {
          operation = next;
          trace.push(`intent:${next.state._tag}`);
          return ok(undefined);
        },
        markOutcomeUnknown: async (next: ReviewWriteOperation) => {
          operation = next;
          trace.push(`intent:${next.state._tag}`);
          return ok(undefined);
        },
        confirm: async (next: ReviewWriteOperation) => {
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
      };
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
        now,
        recentWritesJournal(trace),
        operations,
      );
      await issue(service);
      return {
        trace,
        again: () => issue(service),
        intentTag: () => operation?.state._tag,
      };
    },
  }));
}

/** Every Diff-conversation and published-feedback write, in one list. */
export function conversationFlows(): ReadonlyArray<WriteFlow> {
  return [...inlineConversationFlows(), ...publishedFeedbackFlows()];
}
