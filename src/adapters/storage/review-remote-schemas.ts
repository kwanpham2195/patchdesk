import * as v from "valibot";

import { checksSchema } from "./check-summary-schema";

/**
 * The durable on-disk shapes of a cached review snapshot, kept beside the
 * store that reads and writes them so neither file grows past being readable.
 */

/** GitHub's camo substitutions for one body's images; see `GitHubComment.imageRewrites`. Optional so snapshots written before it existed still load. */
const imageRewritesSchema = v.optional(v.record(v.string(), v.string()));

export const commentSchema = v.strictObject({
  id: v.string(),
  author: v.string(),
  authorAvatarUrl: v.optional(v.string()),
  body: v.string(),
  createdAt: v.string(),
  updatedAt: v.optional(v.string()),
  url: v.optional(v.string()),
  viewerDidAuthor: v.optional(v.boolean()),
  imageRewrites: imageRewritesSchema,
  location: v.optional(
    v.strictObject({
      path: v.string(),
      line: v.optional(v.number()),
      lineEnd: v.optional(v.number()),
      diffSide: v.optional(v.picklist(["new", "old"])),
    }),
  ),
});
/** A plain conversation comment: never diff-anchored and never review-attached, so it accepts neither `location` nor `reviewId`. */
export const issueCommentSchema = v.strictObject({
  id: v.string(),
  author: v.string(),
  authorAvatarUrl: v.optional(v.string()),
  body: v.string(),
  createdAt: v.string(),
  updatedAt: v.optional(v.string()),
  url: v.optional(v.string()),
  viewerDidAuthor: v.optional(v.boolean()),
  imageRewrites: imageRewritesSchema,
  nodeId: v.optional(v.string()),
  canEdit: v.boolean(),
  canDelete: v.boolean(),
});
const conversationThreadSchema = v.strictObject({
  id: v.string(),
  state: v.picklist(["open", "resolved", "outdated", "unknown"]),
  comments: v.array(commentSchema),
  complete: v.optional(v.boolean()),
  incompleteReason: v.optional(
    v.picklist(["thread_cap", "comment_cap", "pagination", "unavailable"]),
  ),
  location: v.optional(
    v.strictObject({
      path: v.string(),
      line: v.optional(v.number()),
      lineEnd: v.optional(v.number()),
      diffSide: v.optional(v.picklist(["new", "old"])),
    }),
  ),
});
export const commentsSchema = v.strictObject({
  threads: v.array(conversationThreadSchema),
  complete: v.optional(v.boolean()),
  incompleteReason: v.optional(
    v.picklist(["thread_cap", "comment_cap", "pagination", "unavailable"]),
  ),
});
export const pullRequestSchema = v.strictObject({
  headSha: v.string(),
  baseSha: v.optional(v.string()),
  isDraft: v.boolean(),
  isOpen: v.boolean(),
  ref: v.strictObject({
    host: v.string(),
    owner: v.string(),
    repo: v.string(),
    number: v.number(),
  }),
  title: v.string(),
  nodeId: v.optional(v.string()),
  description: v.optional(v.string()),
  author: v.string(),
  headBranch: v.string(),
  baseBranch: v.string(),
  reviewState: v.picklist([
    "none",
    "review_pending",
    "approved",
    "changes_requested",
    "unknown",
  ]),
  mergeability: v.picklist(["mergeable", "conflicting", "blocked", "unknown"]),
  labels: v.array(v.strictObject({ name: v.string(), color: v.string() })),
  requestedReviewers: v.optional(v.array(v.string())),
  assignees: v.optional(v.array(v.string())),
  updatedAt: v.string(),
  changedFileCount: v.optional(v.number()),
  additions: v.optional(v.number()),
  deletions: v.optional(v.number()),
});
export const mergePolicySchema = v.strictObject({
  pr: v.strictObject({
    host: v.string(),
    owner: v.string(),
    repo: v.string(),
    number: v.number(),
  }),
  headSha: v.string(),
  baseSha: v.optional(v.string()),
  isOpen: v.boolean(),
  isDraft: v.boolean(),
  mergeability: v.picklist(["mergeable", "conflicting", "blocked", "unknown"]),
  mergeStateStatus: v.optional(
    v.picklist([
      "blocked",
      "behind",
      "dirty",
      "draft",
      "has_hooks",
      "unstable",
      "clean",
      "unknown",
      "unavailable",
    ]),
  ),
  reviewDecision: v.picklist([
    "approved",
    "changes_requested",
    "review_required",
    "unknown",
  ]),
  checks: checksSchema,
  complete: v.boolean(),
  incompleteReason: v.optional(
    v.picklist([
      "head_mismatch",
      "pagination",
      "permission",
      "unavailable",
      "mapping",
    ]),
  ),
});
const optionalEvidenceUnavailableSchema = v.strictObject({
  state: v.literal("unavailable"),
  reason: v.picklist(["forbidden", "not_found", "unsupported"]),
});
export const storedPullRequestParametersSchema = v.strictObject({
  requiredApprovingReviewCount: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100)),
  ),
  requireLastPushApproval: v.optional(v.boolean()),
  requiredReviewThreadResolution: v.optional(v.boolean()),
  dismissStaleReviewsOnPush: v.optional(v.boolean()),
  requireCodeOwnerReview: v.optional(v.boolean()),
});
const mergePolicyEvidenceSchema = v.strictObject({
  branchProtection: v.union([
    v.strictObject({
      state: v.literal("available"),
      value: v.strictObject({
        requiredApprovingReviewCount: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100)),
        ),
        dismissStaleReviews: v.optional(v.boolean()),
        requireCodeOwnerReviews: v.optional(v.boolean()),
      }),
    }),
    optionalEvidenceUnavailableSchema,
  ]),
  appliedRuleset: v.union([
    v.strictObject({
      state: v.literal("available"),
      value: v.strictObject({
        rules: v.array(
          v.strictObject({
            type: v.string(),
            name: v.optional(v.string()),
            pullRequestParameters: v.optional(
              storedPullRequestParametersSchema,
            ),
            requiredStatusCheckContexts: v.optional(v.array(v.string())),
          }),
        ),
      }),
    }),
    optionalEvidenceUnavailableSchema,
  ]),
});
export const mergeEvidenceSchema = v.strictObject({
  mergeable: v.picklist(["mergeable", "conflicting", "blocked", "unknown"]),
  mergeStateStatus: v.picklist([
    "blocked",
    "behind",
    "dirty",
    "draft",
    "has_hooks",
    "unstable",
    "clean",
    "unknown",
    "unavailable",
  ]),
  reviewDecision: v.picklist([
    "approved",
    "changes_requested",
    "review_required",
    "unknown",
  ]),
  policy: v.optional(mergePolicyEvidenceSchema),
});
const commitSchema = v.strictObject({
  sha: v.string(),
  message: v.string(),
  author: v.string(),
  authoredAt: v.string(),
  url: v.optional(v.string()),
  isHead: v.boolean(),
});
export const publishedFeedbackSchema = v.strictObject({
  reviews: v.array(
    v.strictObject({
      id: v.string(),
      nodeId: v.optional(v.string()),
      author: v.string(),
      body: v.string(),
      event: v.picklist([
        "APPROVED",
        "COMMENTED",
        "CHANGES_REQUESTED",
        "DISMISSED",
      ]),
      submittedAt: v.string(),
      canDismiss: v.boolean(),
      imageRewrites: imageRewritesSchema,
    }),
  ),
  comments: v.array(
    v.strictObject({
      ...commentSchema.entries,
      reviewId: v.optional(v.string()),
      nodeId: v.optional(v.string()),
      canEdit: v.boolean(),
      canDelete: v.boolean(),
    }),
  ),
  issueComments: v.array(issueCommentSchema),
  complete: v.optional(v.boolean()),
  incompleteReason: v.optional(v.picklist(["pagination", "unavailable"])),
});
const conversationReviewCommentSchema = v.strictObject({
  ...commentSchema.entries,
  reviewId: v.optional(v.string()),
  nodeId: v.optional(v.string()),
  canEdit: v.optional(v.boolean()),
  canDelete: v.optional(v.boolean()),
});
const conversationReviewSchema = v.strictObject({
  id: v.string(),
  nodeId: v.optional(v.string()),
  author: v.string(),
  body: v.string(),
  event: v.picklist([
    "APPROVED",
    "COMMENTED",
    "CHANGES_REQUESTED",
    "DISMISSED",
  ]),
  submittedAt: v.string(),
  canDismiss: v.boolean(),
  imageRewrites: imageRewritesSchema,
});
export const conversationSchema = v.strictObject({
  prDescription: v.string(),
  entries: v.array(
    v.variant("_tag", [
      v.strictObject({ _tag: v.literal("PrDescription"), body: v.string() }),
      v.strictObject({
        _tag: v.literal("IssueComment"),
        comment: issueCommentSchema,
      }),
      v.strictObject({
        _tag: v.literal("ReviewComment"),
        comment: conversationReviewCommentSchema,
      }),
      v.strictObject({
        _tag: v.literal("ReviewSummary"),
        review: conversationReviewSchema,
      }),
      v.strictObject({
        _tag: v.literal("GeneralThread"),
        thread: conversationThreadSchema,
      }),
    ]),
  ),
  inline: v.optional(commentsSchema),
  complete: v.optional(v.boolean()),
  incompleteReason: v.optional(
    v.picklist(["thread_cap", "comment_cap", "pagination", "unavailable"]),
  ),
});
export const snapshotSchema = v.strictObject({
  schemaVersion: v.literal(1),
  pullRequest: pullRequestSchema,
  comments: commentsSchema,
  commits: v.array(commitSchema),
  checks: checksSchema,
  publishedFeedback: v.optional(publishedFeedbackSchema),
  conversation: conversationSchema,
  mergePolicy: v.optional(mergePolicySchema),
  mergeEvidence: v.optional(mergeEvidenceSchema),
});
