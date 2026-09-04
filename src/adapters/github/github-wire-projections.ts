import { createHash } from "node:crypto";
import * as v from "valibot";

import type { CommandFailure } from "./command-runner";
import type {
  AssignableUser,
  CheckRunSummary,
  CheckSummary,
  ConversationEntry,
  GitHubAppliedRulesetEvidence,
  GitHubAppliedRulesetPullRequestParameters,
  GitHubClassicBranchProtectionEvidence,
  GitHubComment,
  GitHubComments,
  GitHubMergePolicyEvidence,
  GitHubMergeStateStatus,
  GitHubPublishedFeedback,
  MergePolicySnapshot,
  PullRequestReviewEntry,
  PullRequestReviewerListing,
  PullRequestSummary,
  RepositoryLabel,
  RequestedReviewer,
  SuggestedPullRequestReviewer,
} from "../../domain/github-context";
import {
  parseGitSha,
  parseGitHubReviewRestId,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseRepoRelativePath,
  type GitHubHost,
  type GitHubOwner,
  type GitHubRepoName,
} from "../../domain/ids";
import { definedProps } from "../../domain/defined-props";
import type { PullRequestRef } from "../../domain/pull-request";
import { err, ok, type Result } from "../../domain/result";
import type { PendingReviewAnchor } from "../../domain/pending-review";
import type { GitHubReviewEvent } from "../../domain/pending-review";
import type { DirectSummaryReviewReceipt } from "../../domain/direct-summary-review";
import {
  type GitHubReadFailure,
  type GitHubReadOperation,
  type MergeOutcome,
  type PendingReviewComment,
} from "./github-adapter";
import {
  invalid,
  optionalPolicyUnavailableReason,
} from "./github-write-failures";
import {
  appliedRulesetSchema,
  type assignableUsersResponseSchema,
  type checkRunsSchema,
  type commitStatusesSchema,
  type directSummaryReceiptSchema,
  mergeEvidenceBranchProtectionSchema,
  type mergeOutcomeSchema,
  type MergePolicyContext,
  type MergePolicyPage,
  type mergePolicyResponseSchema,
  type pullRequestIdentitySchema,
  type pullRequestReviewersResponseSchema,
  type pullRequestSchema,
  type repositoryLabelsResponseSchema,
  type requiredStatusChecksSchema,
  reviewIdSchema,
  type ReviewReceipt,
  type threadResponseSchema,
} from "./github-wire-schemas";

export function parseRepositoryLabel(
  input: v.InferOutput<
    typeof repositoryLabelsResponseSchema
  >["data"]["repository"]["labels"]["nodes"][number],
): RepositoryLabel {
  const label = { id: input.id, name: input.name, color: input.color };
  return input.description !== null &&
    input.description !== undefined &&
    input.description.length > 0
    ? { ...label, description: input.description }
    : label;
}

export function parseAssignableUser(
  input: v.InferOutput<
    typeof assignableUsersResponseSchema
  >["data"]["repository"]["assignableUsers"]["nodes"][number],
): AssignableUser {
  const user = { id: input.id, login: input.login };
  const withName =
    input.name !== null && input.name !== undefined && input.name.length > 0
      ? { ...user, name: input.name }
      : user;
  return input.avatarUrl !== null &&
    input.avatarUrl !== undefined &&
    input.avatarUrl.length > 0
    ? { ...withName, avatarUrl: input.avatarUrl }
    : withName;
}

export function parsePullRequestReviewerListing(
  input: v.InferOutput<
    typeof pullRequestReviewersResponseSchema
  >["data"]["repository"]["pullRequest"],
): PullRequestReviewerListing {
  return {
    requested: parseRequestedReviewers(input.reviewRequests.nodes),
    latestReviews: parsePullRequestReviewEntries(input.latestReviews.nodes),
    reviews: parsePullRequestReviewEntries(input.reviews.nodes),
    suggested: parseSuggestedReviewers(input.suggestedReviewers),
  };
}

function parseRequestedReviewers(
  nodes: v.InferOutput<
    typeof pullRequestReviewersResponseSchema
  >["data"]["repository"]["pullRequest"]["reviewRequests"]["nodes"],
): ReadonlyArray<RequestedReviewer> {
  // Mirrors `parseMaintainerPullRequest`'s own `reviewRequests` handling:
  // a team or bot reviewer's `... on User` fragment does not match, so its
  // `login` is absent on the wire rather than the whole node being `null`.
  return nodes.flatMap((node) => {
    const login = node.requestedReviewer?.login;
    if (login === undefined || login.length === 0) return [];
    let reviewer: RequestedReviewer = { login };
    const name = node.requestedReviewer?.name ?? undefined;
    if (name !== undefined && name.length > 0) reviewer = { ...reviewer, name };
    const avatarUrl = node.requestedReviewer?.avatarUrl ?? undefined;
    if (avatarUrl !== undefined && avatarUrl.length > 0)
      reviewer = { ...reviewer, avatarUrl };
    return [reviewer];
  });
}

function parsePullRequestReviewEntries(
  nodes: v.InferOutput<
    typeof pullRequestReviewersResponseSchema
  >["data"]["repository"]["pullRequest"]["latestReviews"]["nodes"],
): ReadonlyArray<PullRequestReviewEntry> {
  // A node with no author (a deleted/ghost account) is dropped rather than
  // falling back to a shared "ghost" login the way `parseComment` does for
  // comment authorship: a verdict keyed by a shared placeholder login would
  // silently merge unrelated ghosted reviewers into one row. A node whose
  // `submittedAt` is present but fails to parse is dropped the same way,
  // rather than invalidating the whole read over one malformed instant.
  return nodes.flatMap((node) => {
    const login = node.author?.login;
    if (login === undefined || login.length === 0) return [];
    let entry: PullRequestReviewEntry = { login, state: node.state };
    const avatarUrl = node.author?.avatarUrl ?? undefined;
    if (avatarUrl !== undefined && avatarUrl.length > 0)
      entry = { ...entry, avatarUrl };
    if (node.submittedAt !== null && node.submittedAt !== undefined) {
      const submittedAt = parseGitHubTimestamp(node.submittedAt);
      if (submittedAt._tag === "err") return [];
      entry = { ...entry, submittedAt: submittedAt.value };
    }
    const rawOid = node.commit?.oid;
    if (rawOid !== undefined && rawOid.length > 0) {
      const commitOid = parseGitSha(rawOid);
      if (commitOid._tag === "ok")
        entry = { ...entry, commitOid: commitOid.value };
    }
    return [entry];
  });
}

function parseSuggestedReviewers(
  nodes: v.InferOutput<
    typeof pullRequestReviewersResponseSchema
  >["data"]["repository"]["pullRequest"]["suggestedReviewers"],
): ReadonlyArray<SuggestedPullRequestReviewer> {
  return nodes.flatMap((node) => {
    if (node.reviewer.login.length === 0) return [];
    let reviewer: RequestedReviewer = { login: node.reviewer.login };
    const name = node.reviewer.name ?? undefined;
    if (name !== undefined && name.length > 0) reviewer = { ...reviewer, name };
    const avatarUrl = node.reviewer.avatarUrl ?? undefined;
    if (avatarUrl !== undefined && avatarUrl.length > 0)
      reviewer = { ...reviewer, avatarUrl };
    return [
      { isAuthor: node.isAuthor, isCommenter: node.isCommenter, reviewer },
    ];
  });
}

export function parseMergeOutcome(
  raw: v.InferOutput<typeof mergeOutcomeSchema>,
): Result<MergeOutcome, GitHubReadFailure> {
  if (raw.state === "open") return ok({ state: "open" });
  if (raw.state !== "closed") return invalid("get_pr");
  const mergedAt = raw.merged_at;
  if (mergedAt === null || mergedAt === undefined)
    return ok({ state: "closed_unmerged" });
  const parsedMergedAt = parseGitHubTimestamp(mergedAt);
  const mergeCommitSha = raw.merge_commit_sha;
  const parsedCommit =
    mergeCommitSha === null || mergeCommitSha === undefined
      ? undefined
      : parseGitSha(mergeCommitSha);
  if (
    parsedMergedAt._tag === "err" ||
    (parsedCommit !== undefined && parsedCommit._tag === "err")
  )
    return invalid("get_pr");
  const merged = { state: "merged" as const, mergedAt: parsedMergedAt.value };
  return ok(
    parsedCommit === undefined
      ? merged
      : { ...merged, mergeCommitSha: parsedCommit.value },
  );
}

/**
 * Compares a node's pull-request identity with the active Review's pull
 * request. Thread nodes expose PR identity through their first comment; the
 * adapter resolves the comparison so a foreign target is never disclosed.
 */
export function matchesPullRequest(
  identity: v.InferOutput<typeof pullRequestIdentitySchema>,
  pr: PullRequestRef,
): boolean {
  return (
    identity.repository.owner.login === pr.owner &&
    identity.repository.name === pr.repo &&
    identity.number === pr.number
  );
}

/** Fixture counterpart of `matchesPullRequest`: identical membership semantics. */
export function samePullRequest(a: PullRequestRef, b: PullRequestRef): boolean {
  return a.owner === b.owner && a.repo === b.repo && a.number === b.number;
}

export function parseMergePolicyPage(
  raw: v.InferOutput<typeof mergePolicyResponseSchema>,
): MergePolicyPage | undefined {
  const pullRequest = raw.data.repository.pullRequest;
  const headSha = parseGitSha(pullRequest.headRefOid);
  const baseSha = parseGitSha(pullRequest.baseRefOid);
  if (headSha._tag === "err" || baseSha._tag === "err") return undefined;
  // GitHub reports a null rollup for a head commit no check run or status ever
  // touched. That is a complete answer -- the commit has no contexts -- not
  // malformed data, so it reads as an empty final page instead of failing the
  // whole merge-policy read.
  const rollup =
    pullRequest.commits.nodes[0]?.commit.statusCheckRollup ?? undefined;
  const contexts: Array<CheckRunSummary> = [];
  for (const context of rollup?.contexts.nodes ?? []) {
    const summary = parsePolicyContext(context);
    if (summary === undefined) return undefined;
    contexts.push(summary);
  }
  const page = {
    headSha: headSha.value,
    baseSha: baseSha.value,
    baseBranch: pullRequest.baseRefName,
    isOpen: pullRequest.state === "OPEN",
    isDraft: pullRequest.isDraft,
    mergeability: mapMergeability(pullRequest.mergeable),
    mergeStateStatus: mapMergeStateStatus(pullRequest.mergeStateStatus),
    reviewDecision: mapMergePolicyReviewDecision(pullRequest.reviewDecision),
    contexts,
    hasNextPage: rollup?.contexts.pageInfo.hasNextPage ?? false,
  };
  const endCursor = rollup?.contexts.pageInfo.endCursor ?? undefined;
  return endCursor === undefined ? page : { ...page, endCursor };
}

function parsePolicyContext(
  input: MergePolicyContext,
): CheckRunSummary | undefined {
  const { name, status } = input;
  if (
    input.__typename === "CheckRun" &&
    name !== undefined &&
    status !== undefined
  ) {
    const conclusion = mapCheckConclusion(input.conclusion?.toLowerCase());
    const check = {
      name,
      required: "unknown" as const,
      status: mapCheckStatus(status.toLowerCase()),
    };
    const concluded =
      conclusion === undefined ? check : { ...check, conclusion };
    const url = input.detailsUrl ?? undefined;
    return url === undefined ? concluded : { ...concluded, url };
  }
  const { context, state: rawState } = input;
  if (
    input.__typename === "StatusContext" &&
    context !== undefined &&
    rawState !== undefined
  ) {
    const state = rawState.toLowerCase();
    const statusContext = {
      name: context,
      required: "unknown" as const,
      status:
        state === "pending" || state === "expected"
          ? ("in_progress" as const)
          : ("completed" as const),
    };
    const conclusion =
      state === "success"
        ? ("success" as const)
        : state === "failure" || state === "error"
          ? ("failure" as const)
          : undefined;
    const concluded =
      conclusion === undefined
        ? statusContext
        : { ...statusContext, conclusion };
    const url = input.targetUrl ?? undefined;
    return url === undefined ? concluded : { ...concluded, url };
  }
  return undefined;
}

export function parseRequiredContexts(
  raw: v.InferOutput<typeof requiredStatusChecksSchema>,
): ReadonlySet<string> {
  return new Set([
    ...(raw.contexts ?? []),
    ...(raw.checks ?? []).map((check) => check.context),
  ]);
}

export function completeMergePolicy(
  pr: PullRequestRef,
  page: MergePolicyPage,
  contexts: ReadonlyArray<CheckRunSummary>,
  requiredContexts: ReadonlySet<string>,
): MergePolicySnapshot {
  const matched = contexts.map((check) => ({
    ...check,
    required: requiredContexts.has(check.name),
  }));
  const seen = new Set(matched.map((check) => check.name));
  for (const name of requiredContexts) {
    if (!seen.has(name))
      matched.push({ name, required: true, status: "unknown" });
  }
  return {
    pr,
    headSha: page.headSha,
    baseSha: page.baseSha,
    isOpen: page.isOpen,
    isDraft: page.isDraft,
    mergeability: page.mergeability,
    mergeStateStatus: page.mergeStateStatus,
    reviewDecision: page.reviewDecision,
    checks: { overall: overallCheckStatus(matched), checks: matched },
    complete: true,
  };
}

export function incompleteMergePolicy(
  pr: PullRequestRef,
  page: MergePolicyPage,
  contexts: ReadonlyArray<CheckRunSummary>,
  incompleteReason: Exclude<MergePolicySnapshot["incompleteReason"], undefined>,
): MergePolicySnapshot {
  return {
    pr,
    headSha: page.headSha,
    baseSha: page.baseSha,
    isOpen: page.isOpen,
    isDraft: page.isDraft,
    mergeability: page.mergeability,
    mergeStateStatus: page.mergeStateStatus,
    reviewDecision: page.reviewDecision,
    checks: {
      overall: overallCheckStatus(contexts),
      checks: contexts.map((check) => ({ ...check, required: "unknown" })),
    },
    complete: false,
    incompleteReason,
  };
}

function mapMergePolicyReviewDecision(
  value: string | null | undefined,
): MergePolicySnapshot["reviewDecision"] {
  if (value === "APPROVED") return "approved";
  if (value === "CHANGES_REQUESTED") return "changes_requested";
  if (value === "REVIEW_REQUIRED") return "review_required";
  return "unknown";
}

function mapMergeStateStatus(
  value: string | null | undefined,
): GitHubMergeStateStatus {
  switch (value) {
    case "BLOCKED":
      return "blocked";
    case "BEHIND":
      return "behind";
    case "DIRTY":
      return "dirty";
    case "DRAFT":
      return "draft";
    case "HAS_HOOKS":
      return "has_hooks";
    case "UNSTABLE":
      return "unstable";
    case "CLEAN":
      return "clean";
    case undefined:
    case null:
      return "unavailable";
    default:
      return "unknown";
  }
}

export function parsePullRequest(
  raw: v.InferOutput<typeof pullRequestSchema>,
  host: GitHubHost,
  owner: GitHubOwner,
  repo: GitHubRepoName,
):
  | Result<PullRequestSummary, never>
  | Result<never, { readonly _tag: "Invalid" }> {
  const parsed = { output: raw };
  const number = parsePullRequestNumber(parsed.output.number);
  const headSha = parseGitSha(parsed.output.head.sha);
  const baseSha =
    parsed.output.base.sha === undefined
      ? undefined
      : parseGitSha(parsed.output.base.sha);
  const updatedAt = parseGitHubTimestamp(parsed.output.updated_at);
  if (
    number._tag === "err" ||
    headSha._tag === "err" ||
    (baseSha !== undefined && baseSha._tag === "err") ||
    updatedAt._tag === "err"
  )
    return err({ _tag: "Invalid" });

  let summary: PullRequestSummary = {
    ref: { host, owner, repo, number: number.value },
    title: parsed.output.title,
    author: parsed.output.user.login,
    headBranch: parsed.output.head.ref,
    baseBranch: parsed.output.base.ref,
    headSha: headSha.value,
    isDraft: parsed.output.draft,
    isOpen: parsed.output.state === "open",
    reviewState: "unknown",
    mergeability: mapMergeability(parsed.output.mergeable_state),
    labels: (parsed.output.labels ?? []).map((label) => ({
      name: label.name,
      color: label.color,
    })),
    updatedAt: updatedAt.value,
  };
  if (parsed.output.node_id !== undefined)
    summary = { ...summary, nodeId: parsed.output.node_id };
  const description = parsed.output.body ?? undefined;
  if (description !== undefined) summary = { ...summary, description };
  if (baseSha !== undefined) summary = { ...summary, baseSha: baseSha.value };
  const requestedReviewers = parsed.output.requested_reviewers;
  if (requestedReviewers !== undefined)
    summary = {
      ...summary,
      requestedReviewers: requestedReviewers.map((reviewer) => reviewer.login),
    };
  const assignees = parsed.output.assignees;
  if (assignees !== undefined)
    summary = {
      ...summary,
      assignees: assignees.map((assignee) => assignee.login),
    };
  if (parsed.output.changed_files !== undefined)
    summary = { ...summary, changedFileCount: parsed.output.changed_files };
  if (parsed.output.additions !== undefined)
    summary = { ...summary, additions: parsed.output.additions };
  if (parsed.output.deletions !== undefined)
    summary = { ...summary, deletions: parsed.output.deletions };
  return ok(summary);
}

export function parseComment(
  input: v.InferOutput<
    typeof threadResponseSchema
  >["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"][number]["comments"]["nodes"][number],
): Result<GitHubComment, { readonly _tag: "Invalid" }> {
  const createdAt = parseGitHubTimestamp(input.createdAt);
  const updatedAt =
    input.updatedAt === null || input.updatedAt === undefined
      ? undefined
      : parseGitHubTimestamp(input.updatedAt);
  if (
    createdAt._tag === "err" ||
    (updatedAt !== undefined && updatedAt._tag === "err")
  )
    return err({ _tag: "Invalid" });

  const location = parseLocation(
    input.path,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
  let comment: GitHubComment = {
    id: input.id,
    author: input.author?.login ?? "ghost",
    body: input.body,
    createdAt: createdAt.value,
  };
  const authorAvatarUrl = input.author?.avatarUrl ?? undefined;
  if (authorAvatarUrl !== undefined) comment = { ...comment, authorAvatarUrl };
  if (updatedAt !== undefined)
    comment = { ...comment, updatedAt: updatedAt.value };
  const url = input.url ?? undefined;
  if (url !== undefined) comment = { ...comment, url };
  if (location !== undefined) comment = { ...comment, location };
  if (input.viewerDidAuthor !== undefined)
    comment = { ...comment, viewerDidAuthor: input.viewerDidAuthor };
  return ok(comment);
}

export function parseLocation(
  path: string | null | undefined,
  line: number | null | undefined,
  originalLine: number | null | undefined,
  startLine: number | null | undefined,
  diffSide: string | null | undefined,
  startSide: string | null | undefined,
): GitHubComment["location"] {
  if (path === null || path === undefined) return undefined;
  const parsedPath = parseRepoRelativePath(path);
  if (parsedPath._tag === "err") return undefined;
  const selectedLine =
    line === null || line === undefined
      ? originalLine === null || originalLine === undefined
        ? undefined
        : originalLine
      : line;
  // GitHub reports single-line LEFT-side threads with a phantom startLine of
  // line + 1 (the range is degenerate, not inverted); normalizing it keeps the
  // thread anchored to the single old-side line it was created on.
  let location: GitHubComment["location"] = { path: parsedPath.value };
  if (selectedLine !== undefined) {
    location =
      startLine === null || startLine === undefined || startLine > selectedLine
        ? { ...location, line: selectedLine }
        : { ...location, line: startLine, lineEnd: selectedLine };
  }
  const side =
    diffSide === "RIGHT" || (diffSide !== "LEFT" && startSide === "RIGHT")
      ? ("new" as const)
      : diffSide === "LEFT" || startSide === "LEFT"
        ? ("old" as const)
        : undefined;
  return side === undefined ? location : { ...location, diffSide: side };
}

export function toCheckRunSummary(
  input: v.InferOutput<typeof checkRunsSchema>["check_runs"][number],
): CheckRunSummary {
  const conclusion = mapCheckConclusion(input.conclusion);
  const check = {
    name: input.name,
    required: "unknown" as const,
    status: mapCheckStatus(input.status),
  };
  const concluded = conclusion === undefined ? check : { ...check, conclusion };
  const url = input.details_url ?? undefined;
  return url === undefined ? concluded : { ...concluded, url };
}

export function toCommitStatusSummary(
  input: v.InferOutput<typeof commitStatusesSchema>["statuses"][number],
): CheckRunSummary {
  const state = input.state.toLowerCase();
  const status = {
    name: input.context,
    required: "unknown" as const,
    status:
      state === "pending" || state === "expected"
        ? ("in_progress" as const)
        : ("completed" as const),
  };
  const conclusion =
    state === "success"
      ? ("success" as const)
      : state === "failure" || state === "error"
        ? ("failure" as const)
        : undefined;
  const concluded =
    conclusion === undefined ? status : { ...status, conclusion };
  const url = input.target_url ?? undefined;
  return url === undefined ? concluded : { ...concluded, url };
}

export function mapMergeability(
  value: string | undefined,
): PullRequestSummary["mergeability"] {
  if (value === "clean" || value === "MERGEABLE") return "mergeable";
  if (value === "dirty" || value === "CONFLICTING") return "conflicting";
  if (value === "blocked" || value === "BLOCKED") return "blocked";
  return "unknown";
}

function mapCheckStatus(value: string): CheckRunSummary["status"] {
  if (value === "queued" || value === "in_progress" || value === "completed")
    return value;
  return "unknown";
}

function mapCheckConclusion(
  value: string | null | undefined,
): CheckRunSummary["conclusion"] {
  if (
    value === "success" ||
    value === "failure" ||
    value === "cancelled" ||
    value === "timed_out" ||
    value === "skipped" ||
    value === "neutral"
  )
    return value;
  return undefined;
}

export function overallCheckStatus(
  checks: ReadonlyArray<CheckRunSummary>,
): CheckSummary["overall"] {
  if (checks.length === 0) return "unknown";
  if (checks.some((check) => check.status !== "completed")) return "pending";
  if (
    checks.some(
      (check) =>
        check.conclusion === "failure" ||
        check.conclusion === "cancelled" ||
        check.conclusion === "timed_out",
    )
  )
    return "failing";
  if (checks.every((check) => check.conclusion === "skipped")) return "skipped";
  if (
    checks.every(
      (check) =>
        check.conclusion === "success" ||
        check.conclusion === "neutral" ||
        check.conclusion === "skipped",
    )
  )
    return "passing";
  return "unknown";
}

export function parseGitHubTimestamp(
  input: string,
): ReturnType<typeof parseIsoTimestamp> {
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(input)
    ? `${input.slice(0, -1)}.000Z`
    : input;
  return parseIsoTimestamp(normalized);
}

/** Classifies a failed CommandFailure into a GitHubReadFailure; bound to the caller's profile host. */
export type CommandFailureClassifier = (
  operation: GitHubReadOperation,
  failure: CommandFailure,
) => Result<never, GitHubReadFailure>;

export function parseOptionalPolicyResponse(
  response: Result<unknown, CommandFailure>,
  kind: "branchProtection",
  classify: CommandFailureClassifier,
): Result<GitHubMergePolicyEvidence["branchProtection"], GitHubReadFailure>;
export function parseOptionalPolicyResponse(
  response: Result<unknown, CommandFailure>,
  kind: "appliedRuleset",
  classify: CommandFailureClassifier,
): Result<GitHubMergePolicyEvidence["appliedRuleset"], GitHubReadFailure>;
export function parseOptionalPolicyResponse(
  response: Result<unknown, CommandFailure>,
  kind: "branchProtection" | "appliedRuleset",
  classify: CommandFailureClassifier,
): Result<
  | GitHubMergePolicyEvidence["branchProtection"]
  | GitHubMergePolicyEvidence["appliedRuleset"],
  GitHubReadFailure
> {
  if (response._tag === "err") {
    const reason = optionalPolicyUnavailableReason(response.error);
    return reason === undefined
      ? classify("get_merge_policy_evidence", response.error)
      : ok({ state: "unavailable", reason });
  }
  if (kind === "branchProtection") {
    const parsed = v.safeParse(
      mergeEvidenceBranchProtectionSchema,
      response.value,
    );
    if (!parsed.success) return invalid("get_merge_policy_evidence");
    const reviews = parsed.output.required_pull_request_reviews;
    let value: GitHubClassicBranchProtectionEvidence = {};
    if (reviews !== null) {
      value = {
        dismissStaleReviews: reviews.dismiss_stale_reviews,
        requireCodeOwnerReviews: reviews.require_code_owner_reviews,
      };
      // GitHub reports zero when no approval policy is configured. It is not
      // usable evidence for an approval requirement.
      if (reviews.required_approving_review_count > 0)
        value = {
          ...value,
          requiredApprovingReviewCount: reviews.required_approving_review_count,
        };
    }
    return ok({ state: "available", value });
  }
  const parsed = v.safeParse(appliedRulesetSchema, response.value);
  if (!parsed.success) return invalid("get_merge_policy_evidence");
  const value: GitHubAppliedRulesetEvidence = {
    rules: parsed.output.map(buildAppliedRule),
  };
  return ok({ state: "available", value });
}

type AppliedRulesetRule = v.InferOutput<typeof appliedRulesetSchema>[number];
type AppliedRulesetRuleParameters = NonNullable<
  AppliedRulesetRule["parameters"]
>;

function buildAppliedRule(
  rule: AppliedRulesetRule,
): GitHubAppliedRulesetEvidence["rules"][number] {
  return {
    type: rule.type,
    ...definedProps({
      name: rule.name,
      pullRequestParameters:
        rule.type === "pull_request"
          ? buildPullRequestParameters(rule.parameters)
          : undefined,
      requiredStatusCheckContexts:
        rule.type === "required_status_checks"
          ? rule.parameters?.required_status_checks?.map(
              (check) => check.context,
            )
          : undefined,
    }),
  };
}

function buildPullRequestParameters(
  parameters: AppliedRulesetRuleParameters | undefined,
): GitHubAppliedRulesetPullRequestParameters | undefined {
  if (parameters === undefined) return undefined;
  const built = definedProps({
    requiredApprovingReviewCount: parameters.required_approving_review_count,
    requireLastPushApproval: parameters.require_last_push_approval,
    requiredReviewThreadResolution:
      parameters.required_review_thread_resolution,
    dismissStaleReviewsOnPush: parameters.dismiss_stale_reviews_on_push,
    requireCodeOwnerReview: parameters.require_code_owner_review,
  });
  return Object.keys(built).length === 0 ? undefined : built;
}

/** REST review-comment payload GitHub accepts when creating pending-review comments. */
type GitHubReviewCommentPayload = {
  readonly path: string;
  readonly line: number;
  readonly side: "RIGHT" | "LEFT";
  readonly body: string;
  readonly start_line?: number;
  readonly start_side?: "RIGHT" | "LEFT";
};

export function toGitHubReviewComment(
  comment: PendingReviewComment,
): GitHubReviewCommentPayload {
  const side =
    comment.diffSide === "new" ? ("RIGHT" as const) : ("LEFT" as const);
  const payload = {
    path: comment.path,
    line: comment.lineEnd ?? comment.line,
    side,
    body: comment.body,
  };
  return comment.lineEnd === undefined
    ? payload
    : { ...payload, start_line: comment.line, start_side: side };
}

export function samePendingReviewAnchor(
  left: PendingReviewAnchor,
  right: PendingReviewAnchor,
): boolean {
  return (
    left.path === right.path &&
    left.startLine === right.startLine &&
    left.line === right.line &&
    left.side === right.side
  );
}

/** REST create-review comment shape for one pending-review start. */
export function pendingReviewComment(
  anchor: PendingReviewAnchor,
  body: string,
): GitHubReviewCommentPayload {
  const side = anchor.side === "new" ? ("RIGHT" as const) : ("LEFT" as const);
  const payload = { path: anchor.path, line: anchor.line, side, body };
  return anchor.startLine === anchor.line
    ? payload
    : { ...payload, start_line: anchor.startLine, start_side: side };
}

/** Domain anchor from a spike-proven thread shape, normalizing the LEFT single-line quirk. */
export function pendingReviewAnchor(thread: {
  readonly path?: string | null | undefined;
  readonly line?: number | null | undefined;
  readonly startLine?: number | null | undefined;
  readonly diffSide?: string | null | undefined;
}): PendingReviewAnchor | undefined {
  const path =
    thread.path === undefined || thread.path === null
      ? err({ _tag: "InvalidDomainValue" as const, field: "threadPath" })
      : parseRepoRelativePath(thread.path);
  if (path._tag === "err" || thread.line === undefined || thread.line === null)
    return undefined;
  const side =
    thread.diffSide === "LEFT"
      ? "old"
      : thread.diffSide === "RIGHT"
        ? "new"
        : undefined;
  if (side === undefined) return undefined;
  // GitHub reports LEFT single-line threads as an inverted range; the adapter
  // normalizes startLine > line to a single-line anchor.
  const startLine =
    thread.startLine === undefined ||
    thread.startLine === null ||
    thread.startLine > thread.line
      ? thread.line
      : thread.startLine;
  return { path: path.value, startLine, line: thread.line, side };
}

/** A review id GitHub sends as a string or a safe integer; anything else is unusable. */
export function parseReviewId(id: string | number): string | undefined {
  const parsed = v.safeParse(reviewIdSchema, id);
  return parsed.success ? String(parsed.output) : undefined;
}

export function parsePendingReview(
  receipt: ReviewReceipt,
): { readonly reviewId: string; readonly state: "PENDING" } | undefined {
  const reviewId = parseReviewId(receipt.id);
  return reviewId === undefined || receipt.state !== "PENDING"
    ? undefined
    : { reviewId, state: "PENDING" };
}

export function isManagedFetchedRef(value: string): boolean {
  return (
    /^refs\/patchdesk\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//")
  );
}

export function directSummaryEvent(
  state: string,
): GitHubReviewEvent | undefined {
  if (state === "COMMENTED") return "COMMENT";
  if (state === "APPROVED") return "APPROVE";
  if (state === "CHANGES_REQUESTED") return "REQUEST_CHANGES";
  return undefined;
}

export function digestReviewBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function parseDirectSummaryReceipt(
  raw: v.InferOutput<typeof directSummaryReceiptSchema>,
  expectedEvent: GitHubReviewEvent,
): DirectSummaryReviewReceipt | undefined {
  if (
    raw.commit_id === undefined ||
    raw.commit_id === null ||
    raw.submitted_at === undefined ||
    raw.submitted_at === null ||
    directSummaryEvent(raw.state) !== expectedEvent
  )
    return undefined;
  const reviewId = parseGitHubReviewRestId(String(raw.id));
  const headSha = parseGitSha(raw.commit_id);
  const submittedAt = parseGitHubTimestamp(raw.submitted_at);
  return reviewId._tag === "err" ||
    headSha._tag === "err" ||
    submittedAt._tag === "err"
    ? undefined
    : {
        reviewId: reviewId.value,
        event: expectedEvent,
        headSha: headSha.value,
        submittedAt: submittedAt.value,
      };
}

/**
 * Orders one Conversation timeline: every published review summary, every
 * published review comment, every plain issue comment, and the review threads
 * GitHub returned with no code anchor. Threads that DO carry a `location` are deliberately absent —
 * they belong to `Conversation.inline` and are placed against the diff
 * instead (ADR 0028, "Show only conversation threads the diff can place"), so
 * the caller owns that split and this function owns the timeline.
 *
 * The real adapter and `FakeGitHubAdapter` share this ordering so a fixture
 * timeline cannot drift from the one GitHub produces.
 */
export function assembleConversationEntries(
  feedback: GitHubPublishedFeedback,
  comments: GitHubComments,
): ReadonlyArray<ConversationEntry> {
  const entries: ConversationEntry[] = [
    ...feedback.reviews.map((review) => ({
      _tag: "ReviewSummary" as const,
      review,
    })),
    ...feedback.comments.map((comment) => ({
      _tag: "ReviewComment" as const,
      comment,
    })),
    ...feedback.issueComments.map((comment) => ({
      _tag: "IssueComment" as const,
      comment,
    })),
    ...comments.threads
      .filter((thread) => thread.location === undefined)
      .map((thread) => ({ _tag: "GeneralThread" as const, thread })),
  ];
  return entries.sort((a, b) =>
    conversationEntryOrder(a).localeCompare(conversationEntryOrder(b)),
  );
}

/**
 * The timestamp each entry kind is stamped with. A `GeneralThread` with no
 * comments, and the `PrDescription` entry this assembly never produces, both
 * sort as `""` — ahead of everything dated.
 */
function conversationEntryOrder(entry: ConversationEntry): string {
  switch (entry._tag) {
    case "ReviewSummary":
      return entry.review.submittedAt;
    case "IssueComment":
    case "ReviewComment":
      return entry.comment.createdAt;
    case "GeneralThread":
      return entry.thread.comments[0]?.createdAt ?? "";
    default:
      return "";
  }
}
