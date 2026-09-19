import { ok } from "../../src/domain/result";
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
  gatewayWrite,
  recordedWriteFlowRun,
  recordingWriteOperations,
  recorded,
  TracingRecentWriteJournal,
  type Trace,
  type WriteFlow,
  type WriteFlowFixture,
} from "./write-invariant-harness";

/** The five Diff-conversation writes share the durable operation store. */
function inlineConversationFlows(
  fixture: WriteFlowFixture,
): ReadonlyArray<WriteFlow> {
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
      const operations = recordingWriteOperations(trace);
      const gateway = {
        getPullRequest: async () => ok(values.snapshot.pullRequest),
        getReviewThreadTarget: async () => ok({ found: true }),
        getReviewCommentTarget: async () =>
          ok({ found: true, viewerDidAuthor: true }),
        createInlineComment: gatewayWrite(fixture, {
          commentId: "comment-2",
          commentNodeId: "PRRC_comment-2",
        }),
        createThreadReply: gatewayWrite(fixture, { commentId: "comment-2" }),
        setReviewThreadState: gatewayWrite(fixture, undefined),
        updateThreadComment: gatewayWrite(fixture, undefined),
        deleteThreadComment: gatewayWrite(fixture, undefined),
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
        new TracingRecentWriteJournal(trace, fixture.journal),
        operations,
      );
      const issue = () => service.execute({ profileId, reviewId, command });
      return recordedWriteFlowRun(trace, issue, operations);
    },
  }));
}

/** The three published-feedback writes retain unavailable outcomes without replay. */
function publishedFeedbackFlows(
  fixture: WriteFlowFixture,
): ReadonlyArray<WriteFlow> {
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
      const operations = recordingWriteOperations(trace);
      const gateway = {
        getPullRequest: async () => ok(values.snapshot.pullRequest),
        getPullRequestComments: async () => ok(values.snapshot.comments),
        getPullRequestPublishedFeedback: async () => ok(feedback),
        updateReviewComment: gatewayWrite(fixture, undefined),
        deleteReviewComment: gatewayWrite(fixture, undefined),
        dismissReview: gatewayWrite(fixture, undefined),
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
        new TracingRecentWriteJournal(trace, fixture.journal),
        operations,
      );
      return recordedWriteFlowRun(trace, () => issue(service), operations);
    },
  }));
}

/** Every Diff-conversation and published-feedback write, in one list. */
export function conversationFlows(
  fixture: WriteFlowFixture,
): ReadonlyArray<WriteFlow> {
  return [
    ...inlineConversationFlows(fixture),
    ...publishedFeedbackFlows(fixture),
  ];
}
