import { createHash } from "node:crypto";
import { join } from "node:path";

import * as v from "valibot";

import type {
  CheckSummary,
  Conversation,
  GitHubAppliedRulesetPullRequestParameters,
  GitHubComment,
  GitHubComments,
  GitHubMergeEvidence,
  GitHubPublishedFeedback,
  MergePolicySnapshot,
  PublishedIssueComment,
  PullRequestCommit,
  PullRequestSummary,
} from "../../domain/github-context";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseGitHubThreadId,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseRepoRelativePath,
  type ContentHash,
  type ReviewId,
  type WorkspaceProfileId,
} from "../../domain/ids";
import { definedProps } from "../../domain/defined-props";
import { err, ok, type Result } from "../../domain/result";
import { projectChecks } from "./check-summary-schema";
import {
  readJsonFile,
  type StorageFailure,
  writeAtomicJson,
} from "./json-file";
import {
  snapshotSchema,
  type commentSchema,
  type commentsSchema,
  type conversationSchema,
  type issueCommentSchema,
  type mergeEvidenceSchema,
  type mergePolicySchema,
  type publishedFeedbackSchema,
  type pullRequestSchema,
  type storedPullRequestParametersSchema,
} from "./review-remote-schemas";
import type { PatchdeskPaths } from "./patchdesk-paths";

export type ReviewRemoteSnapshot = {
  readonly schemaVersion: 1;
  readonly pullRequest: PullRequestSummary;
  readonly comments: GitHubComments;
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly checks: CheckSummary;
  readonly publishedFeedback?: GitHubPublishedFeedback;
  readonly conversation: Conversation;
  readonly mergePolicy?: MergePolicySnapshot;
  /** Separate typed aggregate evidence used for display; mergePolicy remains the write-gate input. */
  readonly mergeEvidence?: GitHubMergeEvidence;
};

/**
 * Diagnostic-only widening of StorageFailure: when the top-level schema
 * rejects a stored or candidate snapshot, the first valibot issue's dot
 * path is attached so callers can log which field failed without changing
 * the wire "storage" reason this store already returns.
 */
export type ReviewRemoteStoreFailure = StorageFailure & {
  readonly issuePath?: string;
};

/** Content-addressed storage for the complete remote snapshot represented by a Review. */
export class ReviewRemoteStore {
  constructor(private readonly paths: PatchdeskPaths) {}

  async saveCandidate(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly snapshot: ReviewRemoteSnapshot;
  }): Promise<
    Result<{ readonly snapshotHash: ContentHash }, ReviewRemoteStoreFailure>
  > {
    const parsed = parseSnapshot(input.snapshot);
    if (parsed._tag === "err") return parsed;
    const snapshotHash = hashSnapshot(parsed.value);
    const saved = await writeAtomicJson(
      remoteSnapshotPath(
        this.paths,
        input.profileId,
        input.reviewId,
        snapshotHash,
      ),
      parsed.value,
    );
    return saved._tag === "err" ? saved : ok({ snapshotHash });
  }

  async load(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly snapshotHash: ContentHash;
  }): Promise<Result<ReviewRemoteSnapshot, ReviewRemoteStoreFailure>> {
    const snapshotHash = input.snapshotHash;
    const stored = await readJsonFile(
      remoteSnapshotPath(
        this.paths,
        input.profileId,
        input.reviewId,
        snapshotHash,
      ),
    );
    if (stored._tag === "err") return stored;
    const parsed = parseSnapshot(stored.value);
    if (parsed._tag === "err") return parsed;
    if (hashSnapshot(parsed.value) !== snapshotHash) return invalidRead();
    return parsed;
  }
}

export function parseReviewRemoteSnapshot(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON snapshot I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): Result<ReviewRemoteSnapshot, ReviewRemoteStoreFailure> {
  const parsed = v.safeParse(snapshotSchema, input);
  if (!parsed.success) {
    // The dot path names only the rejected field (e.g. a value shape or an
    // unrecognized enum member), never the field's value, so it is safe to
    // carry into the log without repeating the sensitive-value guard's job.
    const issuePath = v.getDotPath(parsed.issues[0]) ?? undefined;
    return invalidRead(issuePath);
  }
  const pr = parsePullRequest(parsed.output.pullRequest);
  const comments = parseComments(parsed.output.comments);
  const checks = projectChecks(parsed.output.checks);
  const commits = parseCommits(
    parsed.output.commits,
    pr._tag === "ok" ? pr.value.headSha : undefined,
  );
  const mergePolicy =
    parsed.output.mergePolicy === undefined
      ? ok(undefined)
      : parseMergePolicy(parsed.output.mergePolicy);
  const mergeEvidence =
    parsed.output.mergeEvidence === undefined
      ? ok(undefined)
      : parseMergeEvidence(parsed.output.mergeEvidence);
  const publishedFeedback =
    parsed.output.publishedFeedback === undefined
      ? ok(undefined)
      : parsePublishedFeedback(parsed.output.publishedFeedback);
  const conversation = parseConversation(parsed.output.conversation);
  if (
    pr._tag === "err" ||
    comments._tag === "err" ||
    commits._tag === "err" ||
    publishedFeedback._tag === "err" ||
    conversation._tag === "err" ||
    mergePolicy._tag === "err" ||
    mergeEvidence._tag === "err"
  )
    return invalidRead();
  const publishedFeedbackField =
    publishedFeedback.value === undefined
      ? {}
      : { publishedFeedback: publishedFeedback.value };
  const mergePolicyField =
    mergePolicy.value === undefined ? {} : { mergePolicy: mergePolicy.value };
  const mergeEvidenceField =
    mergeEvidence.value === undefined
      ? {}
      : { mergeEvidence: mergeEvidence.value };
  return ok({
    schemaVersion: 1,
    pullRequest: pr.value,
    comments: comments.value,
    commits: commits.value,
    checks,
    ...publishedFeedbackField,
    conversation: conversation.value,
    ...mergePolicyField,
    ...mergeEvidenceField,
  });
}

export function hashSnapshot(snapshot: ReviewRemoteSnapshot): ContentHash {
  const mergePolicyField =
    snapshot.mergePolicy === undefined
      ? {}
      : {
          mergePolicy: {
            ...snapshot.mergePolicy,
            checks: withoutCheckUrls(snapshot.mergePolicy.checks),
          },
        };
  const canonical = canonicalJson({
    ...snapshot,
    checks: withoutCheckUrls(snapshot.checks),
    ...mergePolicyField,
  });
  // SAFETY: a sha256 hex digest is always a well-formed content hash string; this is the one place that computes it, so branding it here is sound.
  return createHash("sha256").update(canonical).digest("hex") as ContentHash;
}

function parseSnapshot(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- delegates straight to parseReviewRemoteSnapshot, itself the JSON snapshot I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): Result<ReviewRemoteSnapshot, ReviewRemoteStoreFailure> {
  return parseReviewRemoteSnapshot(input);
}

function parsePullRequest(
  input: v.InferOutput<typeof pullRequestSchema>,
): Result<PullRequestSummary, StorageFailure> {
  const refHost = parseGitHubHost(input.ref.host),
    owner = parseGitHubOwner(input.ref.owner),
    repo = parseGitHubRepoName(input.ref.repo),
    number = parsePullRequestNumber(input.ref.number),
    head = parseGitSha(input.headSha),
    base =
      input.baseSha === undefined ? ok(undefined) : parseGitSha(input.baseSha),
    updatedAt = parseIsoTimestamp(input.updatedAt);
  if (
    refHost._tag === "err" ||
    owner._tag === "err" ||
    repo._tag === "err" ||
    number._tag === "err" ||
    head._tag === "err" ||
    base._tag === "err" ||
    updatedAt._tag === "err"
  )
    return invalidRead();
  const baseShaField = base.value === undefined ? {} : { baseSha: base.value };
  const nodeIdField =
    input.nodeId === undefined ? {} : { nodeId: input.nodeId };
  const descriptionField =
    input.description === undefined ? {} : { description: input.description };
  const requestedReviewersField =
    input.requestedReviewers === undefined
      ? {}
      : { requestedReviewers: input.requestedReviewers };
  const assigneesField =
    input.assignees === undefined ? {} : { assignees: input.assignees };
  const changedFileCountField =
    input.changedFileCount === undefined
      ? {}
      : { changedFileCount: input.changedFileCount };
  const additionsField =
    input.additions === undefined ? {} : { additions: input.additions };
  const deletionsField =
    input.deletions === undefined ? {} : { deletions: input.deletions };
  return ok({
    headSha: head.value,
    ...baseShaField,
    isDraft: input.isDraft,
    isOpen: input.isOpen,
    ref: {
      host: refHost.value,
      owner: owner.value,
      repo: repo.value,
      number: number.value,
    },
    title: input.title,
    ...nodeIdField,
    ...descriptionField,
    author: input.author,
    headBranch: input.headBranch,
    baseBranch: input.baseBranch,
    reviewState: input.reviewState,
    mergeability: input.mergeability,
    labels: input.labels,
    ...requestedReviewersField,
    ...assigneesField,
    updatedAt: updatedAt.value,
    ...changedFileCountField,
    ...additionsField,
    ...deletionsField,
  });
}

function parseCommits(
  input: v.InferOutput<typeof snapshotSchema>["commits"],
  expectedHeadSha?: ReturnType<typeof parseGitSha> extends Result<
    infer T,
    unknown
  >
    ? T
    : undefined,
): Result<ReadonlyArray<PullRequestCommit>, StorageFailure> {
  const commits: PullRequestCommit[] = [];
  for (const commit of input) {
    const sha = parseGitSha(commit.sha);
    const authoredAt = parseIsoTimestamp(commit.authoredAt);
    if (sha._tag === "err" || authoredAt._tag === "err") return invalidRead();
    const urlField = commit.url === undefined ? {} : { url: commit.url };
    commits.push({
      sha: sha.value,
      message: commit.message,
      author: commit.author,
      authoredAt: authoredAt.value,
      ...urlField,
      isHead: commit.isHead,
    });
  }
  const heads = commits.filter((commit) => commit.isHead);
  if (
    commits.length > 250 ||
    (commits.length > 0 &&
      (heads.length !== 1 ||
        expectedHeadSha === undefined ||
        heads[0]?.sha !== expectedHeadSha))
  )
    return invalidRead();
  return ok(commits);
}

function parsePublishedFeedback(
  input: v.InferOutput<typeof publishedFeedbackSchema>,
): Result<GitHubPublishedFeedback, StorageFailure> {
  const reviews: Array<GitHubPublishedFeedback["reviews"][number]> = [];
  for (const review of input.reviews) {
    const submittedAt = parseIsoTimestamp(review.submittedAt);
    if (submittedAt._tag === "err") return invalidRead();
    const nodeIdField =
      review.nodeId === undefined ? {} : { nodeId: review.nodeId };
    reviews.push({
      id: review.id,
      ...nodeIdField,
      author: review.author,
      body: review.body,
      event: review.event,
      submittedAt: submittedAt.value,
      canDismiss: review.canDismiss,
      ...definedProps({ imageRewrites: review.imageRewrites }),
    });
  }
  const comments: Array<GitHubPublishedFeedback["comments"][number]> = [];
  for (const comment of input.comments) {
    const base = parseTimelineComment(comment);
    const location =
      comment.location === undefined
        ? undefined
        : parseLocation(comment.location);
    if (base._tag === "err" || location?._tag === "err") return invalidRead();
    comments.push({
      ...base.value,
      ...definedProps({
        nodeId: comment.nodeId,
        location: location?.value,
        reviewId: comment.reviewId,
      }),
      canEdit: comment.canEdit,
      canDelete: comment.canDelete,
    });
  }
  const issueComments = parseIssueComments(input.issueComments);
  if (issueComments._tag === "err") return invalidRead();
  const completeField =
    input.complete === undefined ? {} : { complete: input.complete };
  const incompleteReasonField =
    input.incompleteReason === undefined
      ? {}
      : { incompleteReason: input.incompleteReason };
  return ok({
    reviews,
    comments,
    issueComments: issueComments.value,
    ...completeField,
    ...incompleteReasonField,
  });
}

/**
 * The `GitHubComment` fields shared by every stored comment. The diff-anchored
 * extras (`location`, `reviewId`) stay with their own callers: an issue
 * comment has neither.
 */
function parseTimelineComment(
  input: v.InferOutput<typeof commentSchema>,
): Result<Omit<GitHubComment, "location">, StorageFailure> {
  const createdAt = parseIsoTimestamp(input.createdAt);
  const updatedAt =
    input.updatedAt === undefined
      ? undefined
      : parseIsoTimestamp(input.updatedAt);
  if (createdAt._tag === "err" || updatedAt?._tag === "err")
    return invalidRead();
  return ok({
    id: input.id,
    author: input.author,
    body: input.body,
    createdAt: createdAt.value,
    ...definedProps({
      authorAvatarUrl: input.authorAvatarUrl,
      updatedAt: updatedAt?.value,
      url: input.url,
      viewerDidAuthor: input.viewerDidAuthor,
      imageRewrites: input.imageRewrites,
    }),
  });
}

function parseIssueComments(
  input: ReadonlyArray<v.InferOutput<typeof issueCommentSchema>>,
): Result<ReadonlyArray<PublishedIssueComment>, StorageFailure> {
  const comments: PublishedIssueComment[] = [];
  for (const comment of input) {
    const base = parseTimelineComment(comment);
    if (base._tag === "err") return invalidRead();
    comments.push({
      ...base.value,
      ...definedProps({ nodeId: comment.nodeId }),
      canEdit: comment.canEdit,
      canDelete: comment.canDelete,
    });
  }
  return ok(comments);
}

function parseConversation(
  input: v.InferOutput<typeof conversationSchema>,
): Result<Conversation, StorageFailure> {
  const entries: Conversation["entries"][number][] = [];
  for (const entry of input.entries) {
    if (entry._tag === "PrDescription") {
      entries.push({ _tag: "PrDescription", body: entry.body });
      continue;
    }
    if (entry._tag === "ReviewSummary") {
      const review = parsePublishedFeedback({
        reviews: [entry.review],
        comments: [],
        issueComments: [],
      });
      const parsedReview =
        review._tag === "ok" ? review.value.reviews[0] : undefined;
      if (parsedReview === undefined) return invalidRead();
      entries.push({ _tag: "ReviewSummary", review: parsedReview });
      continue;
    }
    if (entry._tag === "GeneralThread") {
      const thread = parseComments({ threads: [entry.thread] });
      const parsedThread =
        thread._tag === "ok" ? thread.value.threads[0] : undefined;
      if (parsedThread === undefined) return invalidRead();
      entries.push({ _tag: "GeneralThread", thread: parsedThread });
      continue;
    }
    if (entry._tag === "IssueComment") {
      const comment = parseIssueComments([entry.comment]);
      const parsedComment =
        comment._tag === "ok" ? comment.value[0] : undefined;
      if (parsedComment === undefined) return invalidRead();
      entries.push({ _tag: "IssueComment", comment: parsedComment });
      continue;
    }
    const base = parseTimelineComment(entry.comment);
    const location =
      entry.comment.location === undefined
        ? undefined
        : parseLocation(entry.comment.location);
    if (base._tag === "err" || location?._tag === "err") return invalidRead();
    entries.push({
      _tag: "ReviewComment",
      comment: {
        ...base.value,
        ...definedProps({
          location: location?.value,
          reviewId: entry.comment.reviewId,
          nodeId: entry.comment.nodeId,
          canEdit: entry.comment.canEdit,
          canDelete: entry.comment.canDelete,
        }),
      },
    });
  }
  const inline =
    input.inline === undefined ? ok(undefined) : parseComments(input.inline);
  if (inline._tag === "err") return invalidRead();
  const inlineField =
    inline.value === undefined ? {} : { inline: inline.value };
  const completeField =
    input.complete === undefined ? {} : { complete: input.complete };
  const incompleteReasonField =
    input.incompleteReason === undefined
      ? {}
      : { incompleteReason: input.incompleteReason };
  return ok({
    prDescription: input.prDescription,
    entries,
    ...inlineField,
    ...completeField,
    ...incompleteReasonField,
  });
}

function parseComments(
  input: v.InferOutput<typeof commentsSchema>,
): Result<GitHubComments, StorageFailure> {
  const threads: GitHubComments["threads"][number][] = [];
  for (const thread of input.threads) {
    const id = parseGitHubThreadId(thread.id);
    if (id._tag === "err") return invalidRead();
    const comments: GitHubComment[] = [];
    for (const comment of thread.comments) {
      const base = parseTimelineComment(comment);
      const location =
        comment.location === undefined
          ? undefined
          : parseLocation(comment.location);
      if (base._tag === "err" || location?._tag === "err") return invalidRead();
      comments.push({
        ...base.value,
        ...definedProps({ location: location?.value }),
      });
    }
    const location =
      thread.location === undefined
        ? undefined
        : parseLocation(thread.location);
    if (location?._tag === "err") return invalidRead();
    const completeField =
      thread.complete === undefined ? {} : { complete: thread.complete };
    const incompleteReasonField =
      thread.incompleteReason === undefined
        ? {}
        : { incompleteReason: thread.incompleteReason };
    const locationField =
      location === undefined ? {} : { location: location.value };
    threads.push({
      id: id.value,
      state: thread.state,
      comments,
      ...completeField,
      ...incompleteReasonField,
      ...locationField,
    });
  }
  const completeField =
    input.complete === undefined ? {} : { complete: input.complete };
  const incompleteReasonField =
    input.incompleteReason === undefined
      ? {}
      : { incompleteReason: input.incompleteReason };
  return ok({
    threads,
    ...completeField,
    ...incompleteReasonField,
  });
}

function parseLocation(input: {
  path: string;
  line?: number | undefined;
  lineEnd?: number | undefined;
  diffSide?: "new" | "old" | undefined;
}): Result<
  {
    readonly path: ReturnType<typeof parseRepoRelativePath> extends Result<
      infer T,
      unknown
    >
      ? T
      : never;
    readonly line?: number;
    readonly lineEnd?: number;
    readonly diffSide?: "new" | "old";
  },
  StorageFailure
> {
  const path = parseRepoRelativePath(input.path);
  if (path._tag === "err") return invalidRead();
  const lineField = input.line === undefined ? {} : { line: input.line };
  const lineEndField =
    input.lineEnd === undefined ? {} : { lineEnd: input.lineEnd };
  const diffSideField =
    input.diffSide === undefined ? {} : { diffSide: input.diffSide };
  return ok({
    path: path.value,
    ...lineField,
    ...lineEndField,
    ...diffSideField,
  });
}

function parseMergePolicy(
  input: v.InferOutput<typeof mergePolicySchema>,
): Result<MergePolicySnapshot, StorageFailure> {
  const host = parseGitHubHost(input.pr.host),
    owner = parseGitHubOwner(input.pr.owner),
    repo = parseGitHubRepoName(input.pr.repo),
    number = parsePullRequestNumber(input.pr.number),
    head = parseGitSha(input.headSha),
    base = input.baseSha === undefined ? undefined : parseGitSha(input.baseSha);
  const checks = projectChecks(input.checks);
  if (
    host._tag === "err" ||
    owner._tag === "err" ||
    repo._tag === "err" ||
    number._tag === "err" ||
    head._tag === "err" ||
    base?._tag === "err"
  )
    return invalidRead();
  const baseShaField = base === undefined ? {} : { baseSha: base.value };
  const mergeStateStatusField =
    input.mergeStateStatus === undefined
      ? {}
      : { mergeStateStatus: input.mergeStateStatus };
  const incompleteReasonField =
    input.incompleteReason === undefined
      ? {}
      : { incompleteReason: input.incompleteReason };
  return ok({
    pr: {
      host: host.value,
      owner: owner.value,
      repo: repo.value,
      number: number.value,
    },
    headSha: head.value,
    ...baseShaField,
    isOpen: input.isOpen,
    isDraft: input.isDraft,
    mergeability: input.mergeability,
    ...mergeStateStatusField,
    reviewDecision: input.reviewDecision,
    checks,
    complete: input.complete,
    ...incompleteReasonField,
  });
}

function parseMergeEvidence(
  input: v.InferOutput<typeof mergeEvidenceSchema>,
): Result<GitHubMergeEvidence, StorageFailure> {
  if (input.policy === undefined)
    return ok({
      mergeable: input.mergeable,
      mergeStateStatus: input.mergeStateStatus,
      reviewDecision: input.reviewDecision,
    });
  const requiredApprovingReviewCountField =
    input.policy.branchProtection.state === "unavailable" ||
    input.policy.branchProtection.value.requiredApprovingReviewCount ===
      undefined
      ? {}
      : {
          requiredApprovingReviewCount:
            input.policy.branchProtection.value.requiredApprovingReviewCount,
        };
  const dismissStaleReviewsField =
    input.policy.branchProtection.state === "unavailable" ||
    input.policy.branchProtection.value.dismissStaleReviews === undefined
      ? {}
      : {
          dismissStaleReviews:
            input.policy.branchProtection.value.dismissStaleReviews,
        };
  const requireCodeOwnerReviewsField =
    input.policy.branchProtection.state === "unavailable" ||
    input.policy.branchProtection.value.requireCodeOwnerReviews === undefined
      ? {}
      : {
          requireCodeOwnerReviews:
            input.policy.branchProtection.value.requireCodeOwnerReviews,
        };
  const branchProtection =
    input.policy.branchProtection.state === "unavailable"
      ? input.policy.branchProtection
      : {
          state: "available" as const,
          value: {
            ...requiredApprovingReviewCountField,
            ...dismissStaleReviewsField,
            ...requireCodeOwnerReviewsField,
          },
        };
  const appliedRuleset =
    input.policy.appliedRuleset.state === "unavailable"
      ? input.policy.appliedRuleset
      : {
          state: "available" as const,
          value: {
            rules: input.policy.appliedRuleset.value.rules.map((rule) => {
              const nameField =
                rule.name === undefined ? {} : { name: rule.name };
              const storedPullRequestParameters =
                buildStoredPullRequestParameters(rule.pullRequestParameters);
              const pullRequestParametersField =
                storedPullRequestParameters === undefined
                  ? {}
                  : { pullRequestParameters: storedPullRequestParameters };
              const requiredStatusCheckContextsField =
                rule.requiredStatusCheckContexts === undefined
                  ? {}
                  : {
                      requiredStatusCheckContexts:
                        rule.requiredStatusCheckContexts,
                    };
              return {
                type: rule.type,
                ...nameField,
                ...pullRequestParametersField,
                ...requiredStatusCheckContextsField,
              };
            }),
          },
        };
  return ok({
    mergeable: input.mergeable,
    mergeStateStatus: input.mergeStateStatus,
    reviewDecision: input.reviewDecision,
    policy: { branchProtection, appliedRuleset },
  });
}

function buildStoredPullRequestParameters(
  input: v.InferOutput<typeof storedPullRequestParametersSchema> | undefined,
): GitHubAppliedRulesetPullRequestParameters | undefined {
  if (input === undefined) return undefined;
  const built = definedProps({
    requiredApprovingReviewCount: input.requiredApprovingReviewCount,
    requireLastPushApproval: input.requireLastPushApproval,
    requiredReviewThreadResolution: input.requiredReviewThreadResolution,
    dismissStaleReviewsOnPush: input.dismissStaleReviewsOnPush,
    requireCodeOwnerReview: input.requireCodeOwnerReview,
  });
  return Object.keys(built).length === 0 ? undefined : built;
}

function withoutCheckUrls(checks: CheckSummary): CheckSummary {
  return {
    overall: checks.overall,
    checks: checks.checks.map((check) => {
      const conclusionField =
        check.conclusion === undefined ? {} : { conclusion: check.conclusion };
      return {
        name: check.name,
        required: check.required,
        status: check.status,
        ...conclusionField,
      };
    }),
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- canonicalizes an arbitrary already-validated snapshot value for content hashing; every JSON-compatible shape is valid input, so there is no narrower schema to parse against.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- distinguishes a plain object from a primitive for canonicalization purposes only, not decoding external input against a contract.
  if (value !== null && typeof value === "object") {
    // SAFETY: the `typeof value === "object"` check above, with `Array.isArray` already excluded, establishes `value` is a non-null, non-array object, so reading its own keys is sound.
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- generic recursive canonicalizer; the whole point is that no narrower key/value contract exists for an arbitrary snapshot value.
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function remoteSnapshotPath(
  paths: PatchdeskPaths,
  profileId: WorkspaceProfileId,
  reviewId: ReviewId,
  snapshotHash: ContentHash,
): string {
  return join(
    paths.reviewDirectory(profileId, reviewId),
    "remote",
    `${snapshotHash}.json`,
  );
}

function invalidRead(
  issuePath?: string,
): Result<never, ReviewRemoteStoreFailure> {
  const failure: ReviewRemoteStoreFailure = {
    _tag: "StorageFailure",
    operation: "read",
    reason: "invalid_stored_value",
  };
  return err(issuePath === undefined ? failure : { ...failure, issuePath });
}
