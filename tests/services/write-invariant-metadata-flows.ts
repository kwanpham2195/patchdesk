import type { GitHubReviewWriter } from "../../src/adapters/github/github-adapter";
import { err, ok, type Result } from "../../src/domain/result";
import { AssigneeService } from "../../src/services/assignee-service";
import { LabelService } from "../../src/services/label-service";
import { ReviewerService } from "../../src/services/reviewer-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import { now, profileId, reviewId, values } from "./review-invariant-fixtures";
import {
  freshGate,
  recentWritesJournal,
  recorded,
  unavailable,
  type FlowRun,
  type Trace,
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
  | "removeRequestedReviewers";

type MetadataGateway = typeof reads &
  Required<Pick<GitHubReviewWriter, MetadataWriteName>>;

function unavailableGateway(): MetadataGateway {
  return {
    ...reads,
    addLabelsToLabelable: async () => err(unavailable),
    removeLabelsFromLabelable: async () => err(unavailable),
    addAssigneesToAssignable: async () => err(unavailable),
    removeAssigneesFromAssignable: async () => err(unavailable),
    requestReviews: async () => err(unavailable),
    removeRequestedReviewers: async () => err(unavailable),
  };
}

export type MetadataFlow = {
  readonly name: string;
  readonly run: () => Promise<FlowRun>;
};

function buildRun(
  makeCommand: (
    trace: Trace,
    github: MetadataGateway,
    durability: ReturnType<typeof recentWritesJournal>,
  ) => () => Promise<Result<unknown, unknown>>,
): () => Promise<FlowRun> {
  return async () => {
    const trace: Trace = [];
    const durability = recentWritesJournal(trace);
    const command = makeCommand(trace, unavailableGateway(), durability);
    await command();
    return {
      trace,
      again: command,
      intentTag: () => durability.current()?.state._tag,
    };
  };
}

function services(
  trace: Trace,
  github: MetadataGateway,
  durability: ReturnType<typeof recentWritesJournal>,
) {
  const gate = freshGate(sessions);
  const coordinator = new ReviewOperationCoordinator();
  const gateway = recorded(trace, github);
  return {
    labels: new LabelService(
      gate,
      gateway,
      coordinator,
      now,
      durability,
      durability,
    ),
    assignees: new AssigneeService(
      gate,
      gateway,
      coordinator,
      now,
      durability,
      durability,
    ),
    reviewers: new ReviewerService(
      gate,
      gateway,
      coordinator,
      now,
      durability,
      durability,
    ),
  };
}

export const metadataFlows: ReadonlyArray<MetadataFlow> = [
  {
    name: "labels: add",
    run: buildRun((trace, github, durability) => {
      const service = services(trace, github, durability).labels;
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: { _tag: "AddLabels", labels: [{ id: "LA_1", name: "bug" }] },
        });
    }),
  },
  {
    name: "labels: remove",
    run: buildRun((trace, github, durability) => {
      const service = services(trace, github, durability).labels;
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
    run: buildRun((trace, github, durability) => {
      const service = services(trace, github, durability).assignees;
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
    run: buildRun((trace, github, durability) => {
      const service = services(trace, github, durability).assignees;
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
    run: buildRun((trace, github, durability) => {
      const service = services(trace, github, durability).assignees;
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
    run: buildRun((trace, github, durability) => {
      const service = services(trace, github, durability).reviewers;
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
    name: "reviewers: remove",
    run: buildRun((trace, github, durability) => {
      const service = services(trace, github, durability).reviewers;
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
