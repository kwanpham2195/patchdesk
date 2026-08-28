import type { GitHubReviewWriter } from "../../src/adapters/github/github-adapter";
import type { GitHubWriteFailure } from "../../src/domain/github-write";
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
  type Trace,
} from "./write-invariant-harness";

/**
 * Labels, assignees and reviewers — the seven metadata writes, held here as an
 * EXECUTABLE EXEMPTION from `write-invariants.test.ts`'s two invariants rather
 * than as fourteen permanently-red rows or as silence.
 *
 * Why an exemption. Invariant 2 requires an `unavailable` outcome to leave the
 * Review in `OutcomeUnknown` and to refuse the same command afterwards. That
 * rule exists because a retried inline comment becomes two comments. No such
 * duplicate exists here: every one of these writes names its members by id
 * (or, for `removeRequestedReviewers`, by login) and GitHub applies it to a
 * SET, so re-issuing it lands on the same members. Satisfying invariant 2
 * would cost more than it buys — a timed-out label click would lock the
 * Review's metadata into a state needing reconciliation and block a re-click
 * guaranteed to be a no-op. The only residue of a crash mid-write is the
 * own-write journal, appended to only after a confirmed write: the next
 * detect-updates pass may read the maintainer's own change as somebody
 * else's. An attribution wobble, not lost state.
 *
 * Why keep the rows at all. The table's value is that a new entry point is a
 * new row. Deleting these seven would let a future metadata write that
 * APPENDS rather than set-unions arrive with nothing to catch it. So the
 * exemption is asserted, not asserted away, and it has teeth in three places:
 * `MetadataWriteName` is derived from the three services' own gateway types
 * and `SET_SEMANTICS_WRITES` must cover it; `MetadataWriteModel.effect` is
 * `"add" | "remove"` and nothing else, with `read` yielding member KEYS; and
 * each `read` is typed by its real `GitHubReviewWriter` payload. A new or
 * appending metadata write has no honest entry to make here.
 *
 * `reviewers: request` is the exception, and it is asserted as one rather than
 * exempted with the rest. `requestReviews` is still a keyed set-add — the
 * requested-reviewer SET is unchanged by a second issue — but GitHub re-opens
 * a request the person already answered and notifies them again. So the model
 * marks it `notifiesOnEveryCall` and its test asserts the second issue DOES
 * notify. Only the weaker property it really holds is claimed, and the cost it
 * carries is pinned by a passing assertion rather than hidden behind a `todo`.
 */

/** The three member sets these writes mutate on one pull request. */
export type MetadataField = "labels" | "assignees" | "reviewers";

/**
 * Every mutating gateway method the three metadata services can reach,
 * derived from their own constructor gateway types rather than restated.
 */
export type MetadataWriteName =
  | Extract<
      keyof ConstructorParameters<typeof LabelService>[1],
      keyof GitHubReviewWriter
    >
  | Extract<
      keyof ConstructorParameters<typeof AssigneeService>[1],
      keyof GitHubReviewWriter
    >
  | Extract<
      keyof ConstructorParameters<typeof ReviewerService>[1],
      keyof GitHubReviewWriter
    >;

/** The payload GitHub's own mutation takes, for one metadata write. */
type MetadataWriteInput<Method extends MetadataWriteName> = Parameters<
  NonNullable<GitHubReviewWriter[Method]>
>[0];

/** The node a write addresses, and the member keys it names on that node. */
export type MetadataMembers = {
  readonly target: string;
  readonly members: ReadonlyArray<string>;
};

/**
 * GitHub's own semantics for one metadata mutation. There is no `"append"`
 * effect and `read` yields member KEYS: a write that could only be described
 * some other way is exactly the write this exemption does not cover.
 */
export type MetadataWriteModel = {
  readonly field: MetadataField;
  readonly effect: "add" | "remove";
  /** True when GitHub acts on every call, not only when the set changes. */
  readonly notifiesOnEveryCall: boolean;
  /** Over `never` so each entry names its own real mutation payload. */
  readonly read: (input: never) => MetadataMembers;
};

const SET_SEMANTICS_WRITES = {
  addLabelsToLabelable: {
    field: "labels",
    effect: "add",
    notifiesOnEveryCall: false,
    read: (input: MetadataWriteInput<"addLabelsToLabelable">) => ({
      target: input.labelableId,
      members: input.labelIds,
    }),
  },
  removeLabelsFromLabelable: {
    field: "labels",
    effect: "remove",
    notifiesOnEveryCall: false,
    read: (input: MetadataWriteInput<"removeLabelsFromLabelable">) => ({
      target: input.labelableId,
      members: input.labelIds,
    }),
  },
  addAssigneesToAssignable: {
    field: "assignees",
    effect: "add",
    notifiesOnEveryCall: false,
    read: (input: MetadataWriteInput<"addAssigneesToAssignable">) => ({
      target: input.assignableId,
      members: input.assigneeIds,
    }),
  },
  removeAssigneesFromAssignable: {
    field: "assignees",
    effect: "remove",
    notifiesOnEveryCall: false,
    read: (input: MetadataWriteInput<"removeAssigneesFromAssignable">) => ({
      target: input.assignableId,
      members: input.assigneeIds,
    }),
  },
  requestReviews: {
    field: "reviewers",
    effect: "add",
    notifiesOnEveryCall: true,
    read: (input: MetadataWriteInput<"requestReviews">) => ({
      target: input.pullRequestId,
      members: input.userIds,
    }),
  },
  removeRequestedReviewers: {
    field: "reviewers",
    effect: "remove",
    notifiesOnEveryCall: false,
    read: (input: MetadataWriteInput<"removeRequestedReviewers">) => ({
      target: `${input.pr.owner}/${input.pr.repo}#${input.pr.number}`,
      members: input.logins,
    }),
  },
} as const satisfies Record<MetadataWriteName, MetadataWriteModel>;

/** One metadata write, read back through its model as a set operation. */
export type MetadataOperation = {
  readonly method: MetadataWriteName;
  readonly field: MetadataField;
  readonly effect: "add" | "remove";
  /** So a row cannot silently retarget between two issues. */
  readonly target: string;
  readonly members: ReadonlyArray<string>;
};

function readOperation<Method extends MetadataWriteName>(
  method: Method,
  input: MetadataWriteInput<Method>,
): MetadataOperation {
  const model = SET_SEMANTICS_WRITES[method];
  // SAFETY: `SET_SEMANTICS_WRITES[method]` is the model FOR `method`, so its
  // `read` takes exactly this payload; `never` is only how the union declares
  // a per-entry parameter type.
  const { target, members } = model.read(input as never);
  return {
    method,
    field: model.field,
    effect: model.effect,
    target,
    members: [...members],
  };
}

/** The member sets, as comparable data rather than as three live `Set`s. */
export type MetadataMemberSets = {
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  readonly reviewers: ReadonlyArray<string>;
};

/** The same three sets, live, as `MetadataRemote` holds them. */
type MetadataLiveSets = { readonly [Field in MetadataField]: Set<string> };

/** The member sets and the notifications one pull request would carry. */
class MetadataRemote {
  readonly operations: Array<MetadataOperation> = [];
  private readonly members: MetadataLiveSets = {
    labels: new Set(),
    assignees: new Set(),
    reviewers: new Set(),
  };
  private readonly notified: Array<string> = [];

  apply(operation: MetadataOperation): void {
    this.operations.push(operation);
    const set = this.members[operation.field];
    const notifiesOnEveryCall =
      SET_SEMANTICS_WRITES[operation.method].notifiesOnEveryCall;
    for (const member of operation.members) {
      if (operation.effect === "remove") {
        set.delete(member);
        continue;
      }
      const added = !set.has(member);
      set.add(member);
      if (added || notifiesOnEveryCall)
        this.notified.push(`${operation.field}:${member}`);
    }
  }

  snapshot(): MetadataMemberSets {
    return {
      labels: [...this.members.labels].sort(),
      assignees: [...this.members.assignees].sort(),
      reviewers: [...this.members.reviewers].sort(),
    };
  }

  notificationCount(): number {
    return this.notified.length;
  }
}

const reads = {
  getPullRequest: async () =>
    ok({ ...values.snapshot.pullRequest, nodeId: "PR_node", assignees: [] }),
  resolveAuthenticatedAccount: async () => ok({ account: "fixture" }),
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
    ok({
      requested: [],
      candidates: [],
      candidatesTotalCount: 0,
      complete: true,
    }),
  listRepositoryLabels: async () => ok({ labels: [], totalCount: 0 }),
};

/**
 * Everything the three services read, plus all six writes, each typed by the
 * real `GitHubReviewWriter` signature. That typing is teeth 3 above.
 */
export type MetadataGateway = typeof reads &
  Required<Pick<GitHubReviewWriter, MetadataWriteName>>;

type WriteHandler = <Method extends MetadataWriteName>(
  method: Method,
  input: MetadataWriteInput<Method>,
) => Result<void, GitHubWriteFailure>;

function metadataGateway(onWrite: WriteHandler): MetadataGateway {
  return {
    ...reads,
    addLabelsToLabelable: async (input) =>
      onWrite("addLabelsToLabelable", input),
    removeLabelsFromLabelable: async (input) =>
      onWrite("removeLabelsFromLabelable", input),
    addAssigneesToAssignable: async (input) =>
      onWrite("addAssigneesToAssignable", input),
    removeAssigneesFromAssignable: async (input) =>
      onWrite("removeAssigneesFromAssignable", input),
    requestReviews: async (input) => onWrite("requestReviews", input),
    removeRequestedReviewers: async (input) =>
      onWrite("removeRequestedReviewers", input),
  };
}

/** How much a user's re-click costs when the first issue timed out. */
export type MetadataRetryCost = "none" | "notifies-a-human";

export type MetadataFlow = {
  readonly name: string;
  readonly retryCost: MetadataRetryCost;
  /** Why this row is exempt, or what it costs; shown in the failure message. */
  readonly reason: string;
  readonly build: (
    trace: Trace,
    github: MetadataGateway,
  ) => () => Promise<Result<unknown, unknown>>;
};

/** What one row observed when its write succeeded and was issued twice. */
export type MetadataIdempotenceRun = {
  readonly operations: ReadonlyArray<MetadataOperation>;
  readonly afterFirst: MetadataMemberSets;
  readonly afterSecond: MetadataMemberSets;
  readonly notifiedByFirst: number;
  readonly notifiedBySecond: number;
};

const sessions = { current: () => values.session };

/** Every metadata service takes the same five arguments, in the same order. */
function metadataService<Service>(
  Constructor: new (
    gate: never,
    github: never,
    coordinator: ReviewOperationCoordinator,
    clock: typeof now,
    recentWrites: { readonly append: () => Promise<Result<void, never>> },
  ) => Service,
  trace: Trace,
  github: MetadataGateway,
): Service {
  return new Constructor(
    // SAFETY: this fixture gate answers with the parsed fixture session; the
    // service reads no other gate field.
    freshGate(sessions) as never,
    // SAFETY: the recorded gateway implements exactly the reads and the one
    // write this flow performs; no other gateway method is reached.
    recorded(trace, github as never) as never,
    new ReviewOperationCoordinator(),
    now,
    recentWritesJournal(trace),
  );
}

const NO_DUPLICATE =
  "keyed set operation: a duplicate member is not representable";

export const metadataFlows: ReadonlyArray<MetadataFlow> = [
  {
    name: "labels: add",
    retryCost: "none",
    reason: NO_DUPLICATE,
    build: (trace, github) => {
      const service = metadataService(LabelService, trace, github);
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: {
            _tag: "AddLabels",
            labels: [{ id: "LA_1", name: "bug" }],
          },
        });
    },
  },
  {
    name: "labels: remove",
    retryCost: "none",
    reason: NO_DUPLICATE,
    build: (trace, github) => {
      const service = metadataService(LabelService, trace, github);
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: {
            _tag: "RemoveLabels",
            labels: [{ id: "LA_1", name: "bug" }],
          },
        });
    },
  },
  {
    name: "assignees: add",
    retryCost: "none",
    reason: NO_DUPLICATE,
    build: (trace, github) => {
      const service = metadataService(AssigneeService, trace, github);
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: {
            _tag: "AddAssignees",
            assignees: [{ id: "U_1", login: "fixture" }],
          },
        });
    },
  },
  {
    name: "assignees: remove",
    retryCost: "none",
    reason: NO_DUPLICATE,
    build: (trace, github) => {
      const service = metadataService(AssigneeService, trace, github);
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: {
            _tag: "RemoveAssignees",
            assignees: [{ id: "U_1", login: "fixture" }],
          },
        });
    },
  },
  {
    name: "assignees: self",
    retryCost: "none",
    reason: `${NO_DUPLICATE}; re-resolves the same account and re-adds the same id`,
    build: (trace, github) => {
      const service = metadataService(AssigneeService, trace, github);
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: { _tag: "AssignSelf" },
        });
    },
  },
  {
    name: "reviewers: request",
    retryCost: "notifies-a-human",
    reason:
      "keyed set-add, so the requested set is unchanged — but GitHub re-opens a request the reviewer already answered and notifies them again",
    build: (trace, github) => {
      const service = metadataService(ReviewerService, trace, github);
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: {
            _tag: "RequestReviewers",
            reviewers: [{ id: "U_1", login: "fixture" }],
          },
        });
    },
  },
  {
    name: "reviewers: remove",
    retryCost: "none",
    reason: NO_DUPLICATE,
    build: (trace, github) => {
      const service = metadataService(ReviewerService, trace, github);
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: {
            _tag: "RemoveReviewers",
            reviewers: [{ id: "U_1", login: "fixture" }],
          },
        });
    },
  },
];

/** Issues the command once against a gateway whose write times out. */
export async function issueAgainstUnavailable(
  flow: MetadataFlow,
): Promise<ReadonlyArray<string>> {
  const trace: Trace = [];
  await flow.build(
    trace,
    metadataGateway(() => err(unavailable)),
  )();
  return trace.filter((entry) => entry.startsWith("write:"));
}

/** Issues the identical command twice against a set-backed remote. */
export async function issueTwiceAgainstSetBackedRemote(
  flow: MetadataFlow,
): Promise<MetadataIdempotenceRun> {
  const trace: Trace = [];
  const remote = new MetadataRemote();
  const issue = flow.build(
    trace,
    metadataGateway((method, input) => {
      remote.apply(readOperation(method, input));
      return ok(undefined);
    }),
  );
  await issue();
  const afterFirst = remote.snapshot();
  const notifiedByFirst = remote.notificationCount();
  await issue();
  return {
    operations: [...remote.operations],
    afterFirst,
    afterSecond: remote.snapshot(),
    notifiedByFirst,
    notifiedBySecond: remote.notificationCount() - notifiedByFirst,
  };
}
