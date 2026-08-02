import * as v from "valibot";
import { MAX_NARRATIVE_FILE_PREFIX_LENGTH } from "../../domain/narrative-walkthrough";

const pullRequestRefSchema = v.strictObject({
  host: v.pipe(v.string(), v.minLength(1)),
  owner: v.pipe(v.string(), v.minLength(1)),
  repo: v.pipe(v.string(), v.minLength(1)),
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

const checkRunSchema = v.strictObject({
  name: v.pipe(v.string(), v.minLength(1)),
  required: v.union([v.boolean(), v.literal("unknown")]),
  status: v.picklist(["queued", "in_progress", "completed", "unknown"]),
  conclusion: v.optional(
    v.picklist(["success", "failure", "cancelled", "timed_out", "skipped", "neutral"]),
  ),
  url: v.optional(v.pipe(v.string(), v.minLength(1))),
});

const checkSchema = v.strictObject({
  overall: v.picklist(["passing", "failing", "pending", "skipped", "unknown"]),
  checks: v.array(checkRunSchema),
});

const actionSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("run_review"),
    label: v.literal("Run review"),
  }),
  v.strictObject({
    kind: v.literal("review_updates"),
    label: v.literal("Review updates"),
    baseSessionId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({
    kind: v.literal("continue_review"),
    label: v.literal("View review progress"),
    sessionId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({
    kind: v.literal("open_saved_review"),
    label: v.literal("Open saved review"),
    sessionId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({
    kind: v.literal("open_merge_readiness"),
    label: v.literal("Open merge readiness"),
    sessionId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({
    kind: v.literal("open_discussion"),
    label: v.literal("Review author response"),
    sessionId: v.pipe(v.string(), v.minLength(1)),
  }),
]);

const inboxRowSchema = v.strictObject({
  identity: pullRequestRefSchema,
  title: v.pipe(v.string(), v.minLength(1)),
  author: v.pipe(v.string(), v.minLength(1)),
  baseBranch: v.pipe(v.string(), v.minLength(1)),
  headBranch: v.pipe(v.string(), v.minLength(1)),
  currentHeadSha: v.pipe(v.string(), v.minLength(7)),
  isDraft: v.boolean(),
  updatedAt: v.pipe(v.string(), v.isoTimestamp()),
  changeStats: v.strictObject({
    additions: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    deletions: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    changedFiles: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  }),
  checks: checkSchema,
  reviewState: v.picklist([
    "none",
    "review_pending",
    "approved",
    "changes_requested",
    "unknown",
  ]),
  mergeability: v.picklist(["mergeable", "conflicting", "blocked", "unknown"]),
  latestReview: v.optional(
    v.strictObject({
      sessionId: v.pipe(v.string(), v.minLength(1)),
      reviewedHeadSha: v.pipe(v.string(), v.minLength(7)),
      state: v.picklist([
        "starting",
        "running",
        "completed",
        "failed",
        "draft",
        "submitted",
        "merged",
      ]),
      updatedAt: v.pipe(v.string(), v.isoTimestamp()),
      matchesCurrentHead: v.boolean(),
    }),
  ),
  categories: v.array(
    v.picklist([
      "needs_review",
      "updated_since_review",
      "waiting_for_author",
      "checks_failing",
      "checks_pending",
      "ready_to_merge",
      "draft",
      "authored",
      "running",
      "saved_review",
    ]),
  ),
  recommendedAction: actionSchema,
  dataFreshness: v.picklist(["fresh", "cached"]),
});

const repoOutcomeSchema = v.object({
  repo: v.object({
    host: v.pipe(v.string(), v.minLength(1)),
    owner: v.pipe(v.string(), v.minLength(1)),
    repo: v.pipe(v.string(), v.minLength(1)),
    archived: v.optional(v.boolean()),
  }),
  state: v.pipe(v.string(), v.minLength(1)),
});

const inboxResponseSchema = v.strictObject({
  // The main process owns the full workspace profile. The renderer deliberately
  // projects only the fields it needs, so future profile settings do not make a
  // safe inbox response disappear at the JSON boundary.
  profile: v.object({
    id: v.pipe(v.string(), v.minLength(1)),
    label: v.pipe(v.string(), v.minLength(1)),
    githubHost: v.pipe(v.string(), v.minLength(1)),
    ghAccount: v.pipe(v.string(), v.minLength(1)),
    workspaceRoots: v.optional(v.array(v.string())),
    ownerFilters: v.optional(v.array(v.string())),
    rulePaths: v.optional(v.array(v.string())),
  }),
  inbox: v.object({
    rows: v.array(inboxRowSchema),
    repositories: v.array(repoOutcomeSchema),
    dataFreshness: v.picklist(["fresh", "cached"]),
    snapshot: v.optional(
      v.strictObject({
        state: v.picklist([
          "current",
          "partial",
          "failed_cached",
          "unavailable",
        ]),
        refreshedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
      }),
    ),
  }),
});

export type InboxResponse = v.InferOutput<typeof inboxResponseSchema>;
export type InboxRow = InboxResponse["inbox"]["rows"][number];
export type InboxView =
  | "my_inbox"
  | "updated"
  | "needs_review"
  | "waiting"
  | "checks_failing"
  | "ready_to_merge"
  | "all_open";

/** Parses the local API's JSON-safe inbox projection before renderer state owns it. */
export function parseInboxResponse(input: unknown): InboxResponse | undefined {
  const parsed = v.safeParse(inboxResponseSchema, input);
  return parsed.success ? parsed.output : undefined;
}

/** Stable renderer key for selection, preferences, and list navigation. */
export function inboxIdentityKey(row: InboxRow): string {
  return `${row.identity.host}/${row.identity.owner}/${row.identity.repo}#${row.identity.number}`;
}

// The main process projects a renderer-safe Session identity only. Patch,
// worktree, and comparison artifact paths never cross this boundary; the strict
// objects below reject any response that still carries them.
const workbenchSessionSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  key: v.strictObject({
    profileId: v.pipe(v.string(), v.minLength(1)),
    host: v.pipe(v.string(), v.minLength(1)),
    owner: v.pipe(v.string(), v.minLength(1)),
    repo: v.pipe(v.string(), v.minLength(1)),
    prNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    headSha: v.pipe(v.string(), v.minLength(7)),
  }),
});

const recoveryViewSchema = v.strictObject({
  noticeKey: v.picklist([
    "preparing",
    "ready_to_review",
    "review_in_progress",
    "review_interrupted",
    "review_failed",
    "needs_preparation",
  ]),
  tone: v.picklist(["neutral", "positive", "warning", "destructive"]),
  actionKey: v.optional(
    v.picklist([
      "run_review",
      "reconnect",
      "start_again",
      "try_again",
      "prepare_again",
    ]),
  ),
});

const repoRelativePathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(1_024),
  v.regex(/^[^\\/]/, "Path must be repository-relative"),
  v.regex(/^(?!\\.\\.?([\\/]|$))/, "Path must not traverse parent directories"),
  v.regex(/^(?!.*[\\/]\\.\\.?([\\/]|$))/, "Path must not traverse parent directories"),
  v.regex(/^(?![A-Za-z]:[\\/])/, "Path must not be absolute"),
);

const diffLocationSchema = v.strictObject({
  path: repoRelativePathSchema,
  line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  lineEnd: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  diffSide: v.optional(v.picklist(["new", "old"])),
});

const githubCommentSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  author: v.pipe(v.string(), v.minLength(1)),
  body: v.string(),
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
  updatedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  url: v.optional(v.pipe(v.string(), v.minLength(1))),
  location: v.optional(diffLocationSchema),
});

const githubThreadSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  state: v.picklist(["open", "resolved", "outdated", "unknown"]),
  comments: v.array(githubCommentSchema),
  complete: v.optional(v.boolean()),
  location: v.optional(diffLocationSchema),
});

const pullRequestSummarySchema = v.strictObject({
  ref: pullRequestRefSchema,
  title: v.string(),
  description: v.optional(v.string()),
  author: v.string(),
  headBranch: v.string(),
  baseBranch: v.string(),
  headSha: v.pipe(v.string(), v.minLength(7)),
  baseSha: v.optional(v.pipe(v.string(), v.minLength(7))),
  isDraft: v.boolean(),
  isOpen: v.boolean(),
  reviewState: v.picklist(["none", "review_pending", "approved", "changes_requested", "unknown"]),
  mergeability: v.picklist(["mergeable", "conflicting", "blocked", "unknown"]),
  labels: v.array(v.string()),
  requestedReviewers: v.optional(v.array(v.string())),
  assignees: v.optional(v.array(v.string())),
  updatedAt: v.pipe(v.string(), v.isoTimestamp()),
  changedFileCount: v.optional(v.number()),
  additions: v.optional(v.number()),
  deletions: v.optional(v.number()),
});

const commitSchema = v.strictObject({
  sha: v.pipe(v.string(), v.minLength(7)),
  message: v.string(),
  author: v.string(),
  authoredAt: v.pipe(v.string(), v.isoTimestamp()),
  url: v.optional(v.pipe(v.string(), v.minLength(1))),
  isHead: v.boolean(),
});

const reviewResultSchema = v.strictObject({
  changeSummary: v.pipe(v.string(), v.minLength(1)),
  verdict: v.picklist(["approve", "comment", "request_changes"]),
  summary: v.pipe(v.string(), v.minLength(1)),
  findings: v.array(v.strictObject({
    id: v.pipe(v.string(), v.minLength(1)),
    severity: v.picklist(["P0", "P1", "P2", "P3"]),
    title: v.pipe(v.string(), v.minLength(1)),
    file: v.optional(repoRelativePathSchema),
    lineStart: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    lineEnd: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    diffSide: v.optional(v.picklist(["new", "old"])),
    explanation: v.pipe(v.string(), v.minLength(1)),
    suggestedComment: v.optional(v.pipe(v.string(), v.minLength(1))),
    confidence: v.picklist(["high", "medium", "low"]),
    category: v.optional(v.picklist(["bug", "security", "test", "performance", "maintainability", "docs"])),
    affectedScenario: v.optional(v.pipe(v.string(), v.minLength(1))),
    whyItMatters: v.optional(v.pipe(v.string(), v.minLength(1))),
    suggestedChange: v.optional(v.pipe(v.string(), v.minLength(1))),
    mappingStatus: v.picklist(["mapped", "unmapped", "invalid_line"]),
  })),
  validationPlan: v.array(v.string()),
  assumptions: v.array(v.string()),
  coverage: v.optional(v.picklist(["high", "medium", "low"])),
  overallConfidence: v.optional(v.picklist(["high", "medium", "low"])),
  unresolvedItems: v.optional(v.array(v.string())),
  callouts: v.optional(v.array(v.strictObject({
    category: v.picklist(["migration", "dependency", "dependency_change", "authentication", "compatibility", "destructive_operation", "feature_flag", "configuration"]),
    title: v.pipe(v.string(), v.minLength(1)),
    detail: v.pipe(v.string(), v.minLength(1)),
    path: v.optional(repoRelativePathSchema),
  }))),
});

const narrativeHunkSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  path: repoRelativePathSchema,
  header: v.pipe(v.string(), v.minLength(1)),
  raw: v.pipe(v.string(), v.minLength(1)),
  filePrefix: v.optional(v.pipe(v.string(), v.minLength(1))),
  oldStart: v.pipe(v.number(), v.integer(), v.minValue(0)),
  oldLines: v.pipe(v.number(), v.integer(), v.minValue(0)),
  newStart: v.pipe(v.number(), v.integer(), v.minValue(0)),
  newLines: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
const narrativeWalkthroughSchema = v.strictObject({
  snapshot: v.strictObject({
    profileId: v.pipe(v.string(), v.minLength(1)),
    sessionId: v.pipe(v.string(), v.minLength(1)),
    headSha: v.pipe(v.string(), v.minLength(7)),
    patchHash: v.pipe(v.string(), v.minLength(1)),
  }),
  title: v.pipe(v.string(), v.minLength(1)),
  focus: v.pipe(v.string(), v.minLength(1)),
  chapters: v.array(v.strictObject({
    id: v.pipe(v.string(), v.minLength(1)),
    title: v.pipe(v.string(), v.minLength(1)),
    sections: v.array(v.strictObject({
      id: v.pipe(v.string(), v.minLength(1)),
      title: v.pipe(v.string(), v.minLength(1)),
      prose: v.pipe(v.string(), v.minLength(1)),
      hunkIds: v.array(v.pipe(v.string(), v.minLength(1))),
      hunks: v.array(narrativeHunkSchema),
    })),
  })),
  support: v.strictObject({
    id: v.literal("support"),
    title: v.literal("Support"),
    hunkIds: v.array(v.pipe(v.string(), v.minLength(1))),
    hunks: v.array(narrativeHunkSchema),
  }),
});

const insightFields = {
  status: v.picklist(["not_generated", "running", "current", "outdated", "failed"]),
  activeRun: v.optional(v.strictObject({
    sessionId: v.pipe(v.string(), v.minLength(1)),
    startedAt: v.pipe(v.string(), v.isoTimestamp()),
  })),
  replacementFailure: v.optional(v.strictObject({
    incidentId: v.optional(v.pipe(v.string(), v.minLength(1))),
    retryable: v.boolean(),
  })),
} as const;
const analysisInsightSchema = v.strictObject({
  ...insightFields,
  retained: v.optional(v.strictObject({
    runId: v.optional(v.pipe(v.string(), v.minLength(1))),
    sessionId: v.pipe(v.string(), v.minLength(1)),
    headSha: v.pipe(v.string(), v.minLength(7)),
    generatedAt: v.pipe(v.string(), v.isoTimestamp()),
    value: reviewResultSchema,
  })),
});
const walkthroughInsightSchema = v.strictObject({
  ...insightFields,
  retained: v.optional(v.strictObject({
    runId: v.optional(v.pipe(v.string(), v.minLength(1))),
    sessionId: v.pipe(v.string(), v.minLength(1)),
    headSha: v.pipe(v.string(), v.minLength(7)),
    generatedAt: v.pipe(v.string(), v.isoTimestamp()),
    value: narrativeWalkthroughSchema,
  })),
});

const carriedFromSchema = v.strictObject({
  sourceSessionId: v.pipe(v.string(), v.minLength(1)),
  sourceHeadSha: v.pipe(v.string(), v.minLength(7)),
});
const provenanceSchema = v.variant("_tag", [
  v.strictObject({ _tag: v.literal("human") }),
  v.strictObject({ _tag: v.literal("model"), attemptId: v.pipe(v.string(), v.minLength(1)) }),
  v.strictObject({ _tag: v.literal("insight"), runId: v.pipe(v.string(), v.minLength(1)) }),
]);
const anchorSchema = v.strictObject({
  path: repoRelativePathSchema,
  startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  side: v.picklist(["new", "old"]),
});
const fingerprintSchema = v.strictObject({
  path: repoRelativePathSchema,
  side: v.picklist(["new", "old"]),
  startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  selectedLines: v.array(v.string()),
  before: v.array(v.string()),
  after: v.array(v.string()),
});
const attentionSchema = v.strictObject({
  reason: v.picklist(["missing", "ambiguous", "fingerprint_missing"]),
  originalAnchor: anchorSchema,
  originalFingerprint: v.optional(fingerprintSchema),
});
const operationSchema = v.variant("_tag", [
  v.strictObject({ _tag: v.literal("CreatePendingReview"), itemIds: v.array(v.pipe(v.string(), v.minLength(1))) }),
  v.strictObject({ _tag: v.literal("Reply"), itemId: v.pipe(v.string(), v.minLength(1)) }),
  v.strictObject({ _tag: v.literal("ThreadState"), itemId: v.pipe(v.string(), v.minLength(1)) }),
]);
const writeFailureSchema = v.strictObject({
  _tag: v.literal("SafeWriteFailure"),
  category: v.picklist(["auth", "rejected", "unavailable", "outcome_unknown"]),
  message: v.pipe(v.string(), v.minLength(1)),
});
const batchStateSchema = v.variant("_tag", [
  v.strictObject({ _tag: v.literal("Local") }),
  v.strictObject({ _tag: v.literal("Applying"), operation: operationSchema }),
  v.strictObject({ _tag: v.literal("PartialFailure"), operation: operationSchema, failure: writeFailureSchema }),
  v.strictObject({ _tag: v.literal("PendingReview"), reviewId: v.pipe(v.string(), v.minLength(1)) }),
  v.strictObject({ _tag: v.literal("Submitted"), reviewId: v.pipe(v.string(), v.minLength(1)), event: v.picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]) }),
  v.strictObject({ _tag: v.literal("Completed") }),
]);
const itemSchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("InlineComment"), id: v.pipe(v.string(), v.minLength(1)), provenance: v.optional(provenanceSchema), source: v.picklist(["finding", "manual"]), findingId: v.optional(v.pipe(v.string(), v.minLength(1))), anchor: anchorSchema, fingerprint: v.optional(fingerprintSchema), body: v.string(), include: v.boolean(), postability: v.picklist(["postable", "already_reported", "invalid_line", "stale_sha", "api_rejected", "needs_attention"]), attention: v.optional(attentionSchema), carriedFrom: v.optional(carriedFromSchema),
  }),
  v.strictObject({ _tag: v.literal("GeneralComment"), id: v.pipe(v.string(), v.minLength(1)), provenance: v.optional(provenanceSchema), source: v.picklist(["finding", "manual"]), findingId: v.optional(v.pipe(v.string(), v.minLength(1))), body: v.string(), include: v.boolean(), carriedFrom: v.optional(carriedFromSchema) }),
  v.strictObject({ _tag: v.literal("ThreadReply"), id: v.pipe(v.string(), v.minLength(1)), provenance: v.optional(provenanceSchema), threadId: v.pipe(v.string(), v.minLength(1)), body: v.string(), include: v.boolean(), carriedFrom: v.optional(carriedFromSchema) }),
  v.strictObject({ _tag: v.literal("ThreadState"), id: v.pipe(v.string(), v.minLength(1)), provenance: v.optional(provenanceSchema), threadId: v.pipe(v.string(), v.minLength(1)), action: v.picklist(["resolve", "reopen"]), include: v.boolean(), carriedFrom: v.optional(carriedFromSchema) }),
]);
const receiptSchema = v.variant("_tag", [
  v.strictObject({ _tag: v.literal("PendingReviewCreated"), reviewId: v.pipe(v.string(), v.minLength(1)), itemIds: v.array(v.pipe(v.string(), v.minLength(1))) }),
  v.strictObject({ _tag: v.literal("ReplyCreated"), itemId: v.pipe(v.string(), v.minLength(1)), commentId: v.pipe(v.string(), v.minLength(1)) }),
  v.strictObject({ _tag: v.literal("ThreadStateChanged"), itemId: v.pipe(v.string(), v.minLength(1)), state: v.picklist(["resolved", "open"]) }),
]);
const reviewBatchSchema = v.strictObject({
  sessionId: v.pipe(v.string(), v.minLength(1)),
  attemptId: v.optional(v.pipe(v.string(), v.minLength(1))),
  state: batchStateSchema,
  summaryBody: v.string(),
  suggestedEvent: v.picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
  items: v.array(itemSchema),
  receipts: v.array(receiptSchema),
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
  updatedAt: v.pipe(v.string(), v.isoTimestamp()),
});

const publishedFeedbackSchema = v.strictObject({
  reviews: v.array(v.strictObject({
    id: v.pipe(v.string(), v.minLength(1)), author: v.pipe(v.string(), v.minLength(1)), body: v.string(), event: v.picklist(["APPROVED", "COMMENTED", "CHANGES_REQUESTED", "DISMISSED"]), submittedAt: v.pipe(v.string(), v.isoTimestamp()), canDismiss: v.boolean(),
  })),
  comments: v.array(v.strictObject({
    ...githubCommentSchema.entries,
    reviewId: v.optional(v.pipe(v.string(), v.minLength(1))), canEdit: v.boolean(), canDelete: v.boolean(),
  })),
});
const githubCommentsSchema = v.strictObject({
  threads: v.array(githubThreadSchema),
  complete: v.optional(v.boolean()),
  incompleteReason: v.optional(v.picklist(["thread_cap", "comment_cap", "pagination", "unavailable"])),
});
const mergeReadinessSchema = v.strictObject({
  _tag: v.picklist(["Ready", "Blocked", "NeedsAcknowledgement"]),
  blockers: v.array(v.string()),
  warnings: v.array(v.string()),
});
const workbenchProjectionSchema = v.strictObject({
  state: v.literal("review"),
  review: v.strictObject({ id: v.pipe(v.string(), v.minLength(1)), status: v.picklist(["open", "merged", "closed"]) }),
  session: workbenchSessionSchema,
  revision: v.strictObject({
    reviewedHeadSha: v.pipe(v.string(), v.minLength(7)), currentHeadSha: v.optional(v.pipe(v.string(), v.minLength(7))), freshness: v.picklist(["fresh", "updates_available", "unavailable", "not_refreshed"]), refreshedAt: v.pipe(v.string(), v.isoTimestamp()),
  }),
  fullPatch: v.optional(v.string()), pullRequest: v.optional(pullRequestSummarySchema), commits: v.array(commitSchema),
  insights: v.strictObject({ analysis: analysisInsightSchema, walkthrough: walkthroughInsightSchema }),
  draft: v.optional(reviewBatchSchema), publishedFeedback: publishedFeedbackSchema, comments: githubCommentsSchema, checks: checkSchema, mergeReadiness: mergeReadinessSchema, recoveryView: v.optional(recoveryViewSchema),
});
export type WorkbenchResponse = v.InferOutput<typeof workbenchProjectionSchema>;
export function parseReviewBatchProjection(input: unknown): WorkbenchResponse["draft"] | undefined {
  const parsed = v.safeParse(reviewBatchSchema, input);
  return parsed.success ? parsed.output : undefined;
}

const insightRunResponseSchema = v.strictObject({
  runId: v.pipe(v.string(), v.minLength(1)),
  type: v.picklist(["analysis", "walkthrough"]),
  status: v.picklist(["queued", "running", "cancelling", "completed", "failed", "cancelled"]),
});
export type InsightRunResponse = v.InferOutput<typeof insightRunResponseSchema>;
export function parseInsightRunResponse(input: unknown): InsightRunResponse | undefined {
  const parsed = v.safeParse(insightRunResponseSchema, input);
  return parsed.success ? parsed.output : undefined;
}

/** Reject malformed local API review projections before they influence renderer state. */
export function parseWorkbenchResponse(input: unknown): WorkbenchResponse | undefined {
  const parsed = v.safeParse(workbenchProjectionSchema, input);
  return parsed.success ? parsed.output : undefined;
}

const commitDiffResponseSchema = v.strictObject({
  commit: commitSchema,
  position: v.pipe(v.number(), v.integer(), v.minValue(1)),
  total: v.pipe(v.number(), v.integer(), v.minValue(1)),
  patch: v.pipe(v.string(), v.maxLength(1_500_000)),
});
export type CommitDiffResponse = v.InferOutput<typeof commitDiffResponseSchema>;

export function parseCommitDiffResponse(input: unknown): CommitDiffResponse | undefined {
  const parsed = v.safeParse(commitDiffResponseSchema, input);
  if (!parsed.success || parsed.output.position > parsed.output.total) return undefined;
  return parsed.output;
}
const remoteReviewContextSchema = v.strictObject({
  pullRequest: v.optional(pullRequestSummarySchema), currentHeadSha: v.optional(v.pipe(v.string(), v.minLength(7))), freshness: v.picklist(["fresh", "stale", "updates_available", "unavailable", "not_refreshed"]), refreshedAt: v.pipe(v.string(), v.isoTimestamp()), comments: githubCommentsSchema, checks: checkSchema, mergeReadiness: v.optional(mergeReadinessSchema),
});
export type RemoteReviewContextResponse = v.InferOutput<typeof remoteReviewContextSchema>;
/** Reject malformed current GitHub context before merging it into saved work. */
export function parseRemoteReviewContext(input: unknown): RemoteReviewContextResponse | undefined {
  const parsed = v.safeParse(remoteReviewContextSchema, input);
  return parsed.success ? parsed.output : undefined;
}

const walkthroughRepoRelativePathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(1024),
  v.regex(/^[^/\\].*$/, "Repo-relative path must not start with a separator"),
  v.regex(
    /^(?!\.\.\/).*$/,
    "Repo-relative path must not include parent traversal",
  ),
);
const walkthroughHunkIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(64),
  v.regex(/^[A-Za-z0-9_-]+$/, "Walkthrough hunk id must be alphanumeric"),
);
const walkthroughLineNumberSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(1_000_000),
);

const walkthroughHunkSchema = v.strictObject({
  id: walkthroughHunkIdSchema,
  path: walkthroughRepoRelativePathSchema,
  header: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  raw: v.pipe(v.string(), v.minLength(1), v.maxLength(200_000)),
  filePrefix: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(MAX_NARRATIVE_FILE_PREFIX_LENGTH),
    ),
  ),
  oldStart: walkthroughLineNumberSchema,
  oldLines: walkthroughLineNumberSchema,
  newStart: walkthroughLineNumberSchema,
  newLines: walkthroughLineNumberSchema,
});

const walkthroughSnapshotSchema = v.strictObject({
  profileId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  sessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  headSha: v.pipe(v.string(), v.minLength(40), v.maxLength(128)),
  patchHash: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
});

const walkthroughSectionSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
  prose: v.pipe(v.string(), v.minLength(1), v.maxLength(4_000)),
  hunkIds: v.pipe(v.array(walkthroughHunkIdSchema), v.maxLength(32)),
  hunks: v.array(walkthroughHunkSchema),
});

const walkthroughChapterSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  sections: v.pipe(v.array(walkthroughSectionSchema), v.maxLength(32)),
});

const walkthroughSupportSchema = v.strictObject({
  id: v.literal("support"),
  title: v.literal("Support"),
  hunkIds: v.pipe(v.array(walkthroughHunkIdSchema), v.maxLength(128)),
  hunks: v.array(walkthroughHunkSchema),
});

const walkthroughIdleSchema = v.strictObject({
  lifecycle: v.literal("idle"),
  noticeKey: v.literal("walkthrough-idle"),
});
const walkthroughGeneratingSchema = v.strictObject({
  lifecycle: v.literal("generating"),
  noticeKey: v.literal("walkthrough-generating"),
});
const walkthroughReadySchema = v.strictObject({
  lifecycle: v.literal("ready"),
  noticeKey: v.literal("walkthrough-ready"),
  walkthrough: v.strictObject({
    snapshot: walkthroughSnapshotSchema,
    title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    focus: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
    chapters: v.pipe(v.array(walkthroughChapterSchema), v.maxLength(12)),
    support: walkthroughSupportSchema,
  }),
});
const walkthroughFailedSchema = v.strictObject({
  lifecycle: v.literal("failed"),
  noticeKey: v.literal("walkthrough-failed"),
  actionKey: v.literal("walkthrough-retry"),
});
const walkthroughFailedWithIncidentSchema = v.strictObject({
  lifecycle: v.literal("failed"),
  noticeKey: v.literal("walkthrough-failed"),
  actionKey: v.literal("walkthrough-retry"),
  incidentId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
});
const walkthroughStaleSchema = v.strictObject({
  lifecycle: v.literal("stale"),
  noticeKey: v.literal("walkthrough-stale"),
  actionKey: v.literal("walkthrough-regenerate"),
});

const walkthroughProjectionSchema = v.variant("lifecycle", [
  walkthroughIdleSchema,
  walkthroughGeneratingSchema,
  walkthroughReadySchema,
  walkthroughFailedSchema,
  walkthroughFailedWithIncidentSchema,
  walkthroughStaleSchema,
]);

export type WalkthroughProjection = v.InferOutput<
  typeof walkthroughProjectionSchema
>;

/** Reject malformed walkthrough lifecycle projections before they influence renderer state. */
export function parseWalkthroughProjection(
  input: unknown,
): WalkthroughProjection | undefined {
  const parsed = v.safeParse(walkthroughProjectionSchema, input);
  return parsed.success ? parsed.output : undefined;
}

const modelCatalogEntrySchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
});

const modelCatalogSchema = v.strictObject({
  models: v.pipe(
    v.array(modelCatalogEntrySchema),
    v.minLength(1),
    v.maxLength(64),
  ),
  defaultModel: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  ),
  defaultReasoning: v.optional(v.picklist(["low", "medium", "high"])),
  reasoning: v.optional(v.array(v.picklist(["low", "medium", "high"]))),
});

export type ModelCatalog = v.InferOutput<typeof modelCatalogSchema>;

/** Reject malformed Pi model catalog responses; renderer keeps the strict shape only. */
export function parseModelCatalog(input: unknown): ModelCatalog | undefined {
  const parsed = v.safeParse(modelCatalogSchema, input);
  return parsed.success ? parsed.output : undefined;
}
