import type { GitHubReviewWriter } from "../../src/adapters/github/github-adapter";
import { ok, type Result } from "../../src/domain/result";
import { AssigneeService } from "../../src/services/assignee-service";
import { DraftStateService } from "../../src/services/draft-state-service";
import { LabelService } from "../../src/services/label-service";
import { ReviewerService } from "../../src/services/reviewer-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import { now, profileId, reviewId, values } from "./review-invariant-fixtures";
import {
  freshGate,
  gatewayWrite,
  recordedWriteFlowRun,
  recordingWriteOperations,
  recorded,
  TracingRecentWriteJournal,
  type FlowRun,
  type Trace,
  type WriteFlowFixture,
} from "./write-invariant-harness";

const sessions = { current: () => values.session };
const reads = {
  getPullRequest: async () =>
    ok({ ...values.snapshot.pullRequest, nodeId: "PR_node", assignees: [] }),
  resolveAuthenticatedAccount: async () =>
    ok({ host: values.identity.host, account: "fixture" }),
  getRepositoryPermission: async () =>
    ok({
      account: "fixture",
      permission: "write" as const,
      pullRequestsWrite: true,
      canManageLabels: true,
    }),
  listAssignableUsers: async () =>
    ok({ users: [{ id: "U_1", login: "fixture" }], totalCount: 1 }),
  getPullRequestReviewers: async () =>
    ok({ requested: [], latestReviews: [], reviews: [], suggested: [] }),
  listRepositoryLabels: async () => ok({ labels: [], totalCount: 0 }),
};

type MetadataWriteName =
  | "addLabelsToLabelable"
  | "removeLabelsFromLabelable"
  | "addAssigneesToAssignable"
  | "removeAssigneesFromAssignable"
  | "requestReviews"
  | "removeRequestedReviewers"
  | "setPullRequestDraftState";

type MetadataGateway = typeof reads &
  Required<Pick<GitHubReviewWriter, MetadataWriteName>>;

function metadataGateway(fixture: WriteFlowFixture): MetadataGateway {
  return {
    ...reads,
    addLabelsToLabelable: gatewayWrite(fixture, undefined),
    removeLabelsFromLabelable: gatewayWrite(fixture, undefined),
    addAssigneesToAssignable: gatewayWrite(fixture, undefined),
    removeAssigneesFromAssignable: gatewayWrite(fixture, undefined),
    requestReviews: gatewayWrite(fixture, undefined),
    removeRequestedReviewers: gatewayWrite(fixture, undefined),
    setPullRequestDraftState: gatewayWrite(fixture, undefined),
  };
}

export type MetadataFlow = {
  readonly name: string;
  readonly run: () => Promise<FlowRun>;
};

type MetadataServices = ReturnType<typeof services>;

function buildRun(
  fixture: WriteFlowFixture,
  makeCommand: (
    built: MetadataServices,
  ) => () => Promise<Result<unknown, unknown>>,
): () => Promise<FlowRun> {
  return async () => {
    const trace: Trace = [];
    const operations = recordingWriteOperations(trace);
    const command = makeCommand(
      services(
        recorded(trace, metadataGateway(fixture)),
        new TracingRecentWriteJournal(trace, fixture.journal),
        operations,
      ),
    );
    return recordedWriteFlowRun(trace, command, operations);
  };
}

function services(
  gateway: MetadataGateway,
  journal: TracingRecentWriteJournal,
  operations: ReturnType<typeof recordingWriteOperations>,
) {
  const gate = freshGate(sessions);
  const coordinator = new ReviewOperationCoordinator();
  return {
    labels: new LabelService(
      gate,
      gateway,
      coordinator,
      now,
      journal,
      operations,
    ),
    assignees: new AssigneeService(
      gate,
      gateway,
      coordinator,
      now,
      journal,
      operations,
    ),
    reviewers: new ReviewerService(
      gate,
      gateway,
      coordinator,
      now,
      journal,
      operations,
    ),
    draftState: new DraftStateService(
      gate,
      gateway,
      coordinator,
      now,
      journal,
      operations,
    ),
  };
}

/** Every pull request metadata write, built under one fixture. */
export const metadataFlows = (
  fixture: WriteFlowFixture,
): ReadonlyArray<MetadataFlow> => [
  {
    name: "labels: add",
    run: buildRun(fixture, (built) => {
      const service = built.labels;
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: {
            _tag: "AddLabels",
            labels: [{ id: "LA_1", name: "bug" }],
          },
        });
    }),
  },
  {
    name: "labels: remove",
    run: buildRun(fixture, (built) => {
      const service = built.labels;
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: {
            _tag: "RemoveLabels",
            labels: [{ id: "LA_1", name: "bug" }],
          },
        });
    }),
  },
  {
    name: "assignees: add",
    run: buildRun(fixture, (built) => {
      const service = built.assignees;
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: {
            _tag: "AddAssignees",
            assignees: [{ id: "U_1", login: "fixture" }],
          },
        });
    }),
  },
  {
    name: "assignees: remove",
    run: buildRun(fixture, (built) => {
      const service = built.assignees;
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: {
            _tag: "RemoveAssignees",
            assignees: [{ id: "U_1", login: "fixture" }],
          },
        });
    }),
  },
  {
    name: "assignees: self",
    run: buildRun(fixture, (built) => {
      const service = built.assignees;
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: { _tag: "AssignSelf" },
        });
    }),
  },
  {
    name: "reviewers: request",
    run: buildRun(fixture, (built) => {
      const service = built.reviewers;
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: {
            _tag: "RequestReviewers",
            reviewers: [{ id: "U_1", login: "fixture" }],
          },
        });
    }),
  },
  {
    // The fixture pull request is not a draft, so only the convert-to-draft
    // direction is a real write rather than the refused no-op.
    name: "draft state: convert to draft",
    run: buildRun(fixture, (built) => {
      const service = built.draftState;
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: { _tag: "SetDraftState", draft: true },
        });
    }),
  },
  {
    name: "reviewers: remove",
    run: buildRun(fixture, (built) => {
      const service = built.reviewers;
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: {
            _tag: "RemoveReviewers",
            reviewers: [{ id: "U_1", login: "fixture" }],
          },
        });
    }),
  },
];
