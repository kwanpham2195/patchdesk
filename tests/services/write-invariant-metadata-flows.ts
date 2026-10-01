import type {
  GitHubReadFailure,
  GitHubReviewWriter,
} from "../../src/adapters/github/github-adapter";
import type { PullRequestSummary } from "../../src/domain/github-context";
import { err, ok, type Result } from "../../src/domain/result";
import { AssigneeService } from "../../src/services/assignee-service";
import { BaseBranchService } from "../../src/services/base-branch-service";
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
  refusedWrite as refusedWriteFixture,
  recorded,
  TracingRecentWriteJournal,
  type FlowRun,
  type Trace,
  type WriteFlowFixture,
} from "./write-invariant-harness";

const sessions = { current: () => values.session };

/** Fields a row sets on the pull request read; `undefined` drops a field the read normally carries. */
type PullRequestFields = {
  readonly [Key in keyof PullRequestSummary]?:
    | PullRequestSummary[Key]
    | undefined;
};

/** What the write's own preparation read sees (`before`) and what the landed check reads after a refusal (`after`). */
export type PullRequestReads = {
  readonly before: PullRequestFields;
  readonly after: PullRequestFields | "failed";
};

/** Odd reads are a command's preparation, even reads its landed check, so a reissued command reads the same pair. */
function pullRequestRead(pullRequests: PullRequestReads | undefined) {
  let calls = 0;
  return async (): Promise<Result<PullRequestSummary, GitHubReadFailure>> => {
    calls += 1;
    const fields =
      pullRequests === undefined
        ? { assignees: [] }
        : calls % 2 === 1
          ? pullRequests.before
          : pullRequests.after;
    if (fields === "failed")
      return err({ _tag: "GitHubReadFailed", operation: "get_pr" });
    // SAFETY: the fixture pull request is complete; a row only overrides or drops fields of it.
    return ok({
      ...values.snapshot.pullRequest,
      nodeId: "PR_node",
      ...fields,
    } as PullRequestSummary);
  };
}

const reads = {
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
  listRepositoryBranches: async () =>
    ok({ branches: ["release/1.2"], totalCount: 1 }),
};

type MetadataWriteName =
  | "addLabelsToLabelable"
  | "removeLabelsFromLabelable"
  | "addAssigneesToAssignable"
  | "removeAssigneesFromAssignable"
  | "requestReviews"
  | "removeRequestedReviewers"
  | "setPullRequestDraftState"
  | "setPullRequestBaseBranch";

type MetadataGateway = typeof reads &
  Required<Pick<GitHubReviewWriter, MetadataWriteName>> & {
    readonly getPullRequest: ReturnType<typeof pullRequestRead>;
  };

function metadataGateway(
  fixture: WriteFlowFixture,
  pullRequests: PullRequestReads | undefined,
): MetadataGateway {
  return {
    ...reads,
    getPullRequest: pullRequestRead(pullRequests),
    addLabelsToLabelable: gatewayWrite(fixture, undefined),
    removeLabelsFromLabelable: gatewayWrite(fixture, undefined),
    addAssigneesToAssignable: gatewayWrite(fixture, undefined),
    removeAssigneesFromAssignable: gatewayWrite(fixture, undefined),
    requestReviews: gatewayWrite(fixture, undefined),
    removeRequestedReviewers: gatewayWrite(fixture, undefined),
    setPullRequestDraftState: gatewayWrite(fixture, undefined),
    setPullRequestBaseBranch: gatewayWrite(fixture, undefined),
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
  pullRequests?: PullRequestReads,
): () => Promise<FlowRun> {
  return async () => {
    const trace: Trace = [];
    const operations = recordingWriteOperations(trace);
    const command = makeCommand(
      services(
        recorded(trace, metadataGateway(fixture, pullRequests)),
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
    baseBranch: new BaseBranchService(
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
    // The fixture pull request targets `sit`, so another branch is a real write.
    name: "base branch: change",
    run: buildRun(fixture, (built) => {
      const service = built.baseBranch;
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: { _tag: "SetBaseBranch", branch: "release/1.2" },
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

const bug = { name: "bug", color: "d73a4a" };
const docs = { name: "docs", color: "0075ca" };

type MetadataCommand = Parameters<
  | LabelService["execute"]
  | AssigneeService["execute"]
  | ReviewerService["execute"]
  | DraftStateService["execute"]
  | BaseBranchService["execute"]
>[0]["command"];

type RefusalSpec = {
  readonly name: string;
  readonly service: (built: MetadataServices) => {
    readonly execute: (input: {
      readonly profileId: typeof profileId;
      readonly reviewId: typeof reviewId;
      // SAFETY: each spec pairs a service with a command that service accepts.
      readonly command: never;
    }) => Promise<Result<unknown, unknown>>;
  };
  readonly command: MetadataCommand;
  /** The pull request as the write's own preparation read sees it. */
  readonly before: PullRequestFields;
  /** Reads after the refusal that show the intended state still absent. */
  readonly unchanged: ReadonlyArray<readonly [string, PullRequestFields]>;
  /** Reads after the refusal the landed check cannot treat as unchanged. */
  readonly unproven: ReadonlyArray<
    readonly [string, PullRequestFields | "failed"]
  >;
};

const refusalSpecs: ReadonlyArray<RefusalSpec> = [
  {
    name: "labels: add",
    service: (built) => built.labels,
    command: { _tag: "AddLabels", labels: [{ id: "LA_1", name: "bug" }] },
    before: { labels: [] },
    unchanged: [
      ["label still missing", { labels: [] }],
      ["a different label present", { labels: [docs] }],
    ],
    unproven: [
      ["label present", { labels: [bug] }],
      ["label present beside another", { labels: [docs, bug] }],
      ["labels truncated", { labels: [docs], labelCount: 150 }],
      ["read failed", "failed"],
    ],
  },
  {
    name: "labels: remove",
    service: (built) => built.labels,
    command: { _tag: "RemoveLabels", labels: [{ id: "LA_1", name: "bug" }] },
    before: { labels: [bug] },
    unchanged: [
      ["label still present", { labels: [bug] }],
      ["label present beside another", { labels: [docs, bug] }],
    ],
    unproven: [
      ["label gone", { labels: [] }],
      ["only a different label present", { labels: [docs] }],
      ["read failed", "failed"],
    ],
  },
  {
    name: "assignees: add",
    service: (built) => built.assignees,
    command: {
      _tag: "AddAssignees",
      assignees: [{ id: "U_1", login: "fixture" }],
    },
    before: { assignees: [] },
    unchanged: [
      ["assignee still missing", { assignees: [] }],
      ["a different assignee present", { assignees: ["someone"] }],
    ],
    unproven: [
      ["assignee present", { assignees: ["fixture"] }],
      ["assignees missing from the read", { assignees: undefined }],
      ["read failed", "failed"],
    ],
  },
  {
    name: "assignees: assign self",
    service: (built) => built.assignees,
    command: { _tag: "AssignSelf" },
    before: { assignees: [] },
    unchanged: [["assignee still missing", { assignees: [] }]],
    unproven: [["assignee present", { assignees: ["fixture"] }]],
  },
  {
    name: "assignees: remove",
    service: (built) => built.assignees,
    command: {
      _tag: "RemoveAssignees",
      assignees: [{ id: "U_1", login: "fixture" }],
    },
    before: { assignees: ["fixture"] },
    unchanged: [
      ["assignee still present", { assignees: ["fixture"] }],
      [
        "assignee present beside another",
        { assignees: ["someone", "fixture"] },
      ],
    ],
    unproven: [
      ["assignee gone", { assignees: [] }],
      ["only a different assignee present", { assignees: ["someone"] }],
      ["assignees missing from the read", { assignees: undefined }],
      ["read failed", "failed"],
    ],
  },
  {
    name: "reviewers: request",
    service: (built) => built.reviewers,
    command: {
      _tag: "RequestReviewers",
      reviewers: [{ id: "U_1", login: "fixture" }],
    },
    before: { requestedReviewers: [] },
    unchanged: [
      ["reviewer still missing", { requestedReviewers: [] }],
      ["a different reviewer requested", { requestedReviewers: ["someone"] }],
    ],
    unproven: [
      ["reviewer requested", { requestedReviewers: ["fixture"] }],
      [
        "requested reviewers missing from the read",
        { requestedReviewers: undefined },
      ],
      ["read failed", "failed"],
    ],
  },
  {
    name: "reviewers: remove",
    service: (built) => built.reviewers,
    command: {
      _tag: "RemoveReviewers",
      reviewers: [{ id: "U_1", login: "fixture" }],
    },
    before: { requestedReviewers: ["fixture"] },
    unchanged: [
      ["reviewer still requested", { requestedReviewers: ["fixture"] }],
      [
        "reviewer requested beside another",
        { requestedReviewers: ["someone", "fixture"] },
      ],
    ],
    unproven: [
      ["reviewer gone", { requestedReviewers: [] }],
      [
        "only a different reviewer requested",
        { requestedReviewers: ["someone"] },
      ],
      [
        "requested reviewers missing from the read",
        { requestedReviewers: undefined },
      ],
      ["read failed", "failed"],
    ],
  },
  {
    name: "draft state: convert to draft",
    service: (built) => built.draftState,
    command: { _tag: "SetDraftState", draft: true },
    before: { isDraft: false },
    unchanged: [["still not a draft", { isDraft: false }]],
    unproven: [
      ["now a draft", { isDraft: true }],
      ["read failed", "failed"],
    ],
  },
  {
    name: "draft state: publish for review",
    service: (built) => built.draftState,
    command: { _tag: "SetDraftState", draft: false },
    before: { isDraft: true },
    unchanged: [["still a draft", { isDraft: true }]],
    unproven: [
      ["no longer a draft", { isDraft: false }],
      ["read failed", "failed"],
    ],
  },
  {
    name: "base branch: change",
    service: (built) => built.baseBranch,
    command: { _tag: "SetBaseBranch", branch: "release/1.2" },
    before: { baseBranch: "sit" },
    unchanged: [["still the old base", { baseBranch: "sit" }]],
    unproven: [
      ["now the new base", { baseBranch: "release/1.2" }],
      ["now a third branch", { baseBranch: "hotfix" }],
      ["read failed", "failed"],
    ],
  },
];

export type MetadataRefusalRow = {
  readonly name: string;
  readonly run: () => Promise<FlowRun>;
};

function refusalRow(
  spec: RefusalSpec,
  name: string,
  after: PullRequestFields | "failed",
): MetadataRefusalRow {
  return {
    name: `metadata: ${spec.name} (${name})`,
    run: buildRun(
      refusedWriteFixture,
      (built) => () =>
        spec.service(built).execute({
          profileId,
          reviewId,
          // SAFETY: the spec's command is one its own service accepts.
          command: spec.command as never,
        }),
      { before: spec.before, after },
    ),
  };
}

/** Refused metadata writes whose landed check read shows the intended state still absent: the refusal is final. */
export const unchangedMetadataRefusalRows: ReadonlyArray<MetadataRefusalRow> =
  refusalSpecs.flatMap((spec) =>
    spec.unchanged.map(([name, after]) => refusalRow(spec, name, after)),
  );

/** Refused metadata writes whose read shows the intended state, lacks a field, differs, or fails: the lock stays. */
export const unprovenMetadataRefusalRows: ReadonlyArray<MetadataRefusalRow> =
  refusalSpecs.flatMap((spec) =>
    spec.unproven.map(([name, after]) => refusalRow(spec, name, after)),
  );
