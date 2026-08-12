import * as v from "valibot";

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
    label: v.literal("Open Review"),
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
    repos: v.optional(v.array(v.object({
      host: v.pipe(v.string(), v.minLength(1)),
      owner: v.pipe(v.string(), v.minLength(1)),
      repo: v.pipe(v.string(), v.minLength(1)),
    }))),
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
  nodeId: v.optional(v.string()),
  author: v.pipe(v.string(), v.minLength(1)),
  body: v.string(),
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
  updatedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  url: v.optional(v.pipe(v.string(), v.minLength(1))),
  location: v.optional(diffLocationSchema),
  viewerDidAuthor: v.optional(v.boolean()),
});

/** Timeline issue comments may be review-attached, so they carry the same optional review and editability fields the published-feedback boundary exposes. */
const conversationIssueCommentSchema = v.strictObject({
  ...githubCommentSchema.entries,
  reviewId: v.optional(v.pipe(v.string(), v.minLength(1))),
  canEdit: v.optional(v.boolean()),
  canDelete: v.optional(v.boolean()),
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
    disposition: v.optional(v.picklist(["open", "added", "dismissed"])),
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
  citationVersion: v.optional(v.literal(2)),
  citationStatus: v.picklist(["verified", "partially_verified", "unverified"]),
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
  artifactStatus: v.optional(v.picklist(["verified", "mismatch"])),
  activeRun: v.optional(v.strictObject({
    runId: v.optional(v.pipe(v.string(), v.minLength(1))),
    sessionId: v.pipe(v.string(), v.minLength(1)),
    startedAt: v.pipe(v.string(), v.isoTimestamp()),
  })),
  replacementFailure: v.optional(v.strictObject({
    runId: v.optional(v.pipe(v.string(), v.minLength(1))),
    category: v.optional(v.picklist(["authentication_required", "rate_limited", "runtime_unavailable", "timed_out", "execution_failed", "invalid_result", "unexpected_failure"])),
    model: v.optional(v.pipe(v.string(), v.minLength(1))),
    reasoning: v.optional(v.picklist(["minimal", "low", "medium", "high", "xhigh"])),
    incidentId: v.optional(v.pipe(v.string(), v.minLength(1))),
    retryable: v.boolean(),
  })),
  progress: v.optional(v.strictObject({ reviewedSectionIds: v.array(v.pipe(v.string(), v.minLength(1))), supportReviewed: v.boolean(), currentSectionId: v.optional(v.pipe(v.string(), v.minLength(1))) })),
} as const;
const insightScopeSchema = v.strictObject({
  baseShort: v.string(),
  headShort: v.string(),
  commitCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  fileCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  additions: v.pipe(v.number(), v.integer(), v.minValue(0)),
  deletions: v.pipe(v.number(), v.integer(), v.minValue(0)),
  changedFiles: v.array(v.strictObject({ path: repoRelativePathSchema, additions: v.pipe(v.number(), v.integer(), v.minValue(0)), deletions: v.pipe(v.number(), v.integer(), v.minValue(0)) })),
});
const analysisInsightSchema = v.strictObject({
  ...insightFields,
  retained: v.optional(v.strictObject({
    runId: v.optional(v.pipe(v.string(), v.minLength(1))),
    sessionId: v.pipe(v.string(), v.minLength(1)),
    headSha: v.pipe(v.string(), v.minLength(7)),
    generatedAt: v.pipe(v.string(), v.isoTimestamp()),
    value: reviewResultSchema,
    scope: v.optional(insightScopeSchema),
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
  v.strictObject({ _tag: v.literal("SubmitPendingReview"), reviewId: v.pipe(v.string(), v.minLength(1)), event: v.picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]) }),
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

const publishedReviewSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  nodeId: v.optional(v.string()),
  author: v.pipe(v.string(), v.minLength(1)),
  body: v.string(),
  event: v.picklist(["APPROVED", "COMMENTED", "CHANGES_REQUESTED", "DISMISSED"]),
  submittedAt: v.pipe(v.string(), v.isoTimestamp()),
  canDismiss: v.boolean(),
});

const conversationEntrySchema = v.variant("_tag", [
  v.strictObject({ _tag: v.literal("PrDescription"), body: v.string() }),
  v.strictObject({ _tag: v.literal("IssueComment"), comment: conversationIssueCommentSchema }),
  v.strictObject({ _tag: v.literal("ReviewSummary"), review: publishedReviewSchema }),
  v.strictObject({ _tag: v.literal("GeneralThread"), thread: githubThreadSchema }),
]);

const conversationSchema = v.strictObject({
  prDescription: v.string(),
  entries: v.array(conversationEntrySchema),
  inline: v.optional(v.strictObject({
    threads: v.array(githubThreadSchema),
    complete: v.optional(v.boolean()),
    incompleteReason: v.optional(v.picklist(["thread_cap", "comment_cap", "pagination", "unavailable"])),
  })),
  complete: v.optional(v.boolean()),
  incompleteReason: v.optional(v.picklist(["thread_cap", "comment_cap", "pagination", "unavailable"])),
});
const mergeReadinessSchema = v.strictObject({
  _tag: v.picklist(["Ready", "Blocked", "NeedsAcknowledgement"]),
  blockers: v.array(v.string()),
  warnings: v.array(v.string()),
});
const mergeReasonSchema = v.strictObject({
  code: v.picklist(["review_required", "changes_requested", "behind", "conflicts", "checks", "blocked"]),
  message: v.string(),
  source: v.picklist(["github_pr_state", "branch_protection", "ruleset_configuration", "checks"]),
  availability: v.picklist(["available", "partial", "unavailable"]),
  openOnGitHub: v.boolean(),
});
const pendingReviewCommentSchema = v.strictObject({
  threadId: v.pipe(v.string(), v.minLength(1)),
  body: v.string(),
  path: v.pipe(v.string(), v.minLength(1)),
  startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  side: v.picklist(["new", "old"]),
});
const pendingReviewProjectionSchema = v.variant("state", [
  v.strictObject({ state: v.literal("none") }),
  v.strictObject({
    state: v.literal("unavailable"),
    action: v.picklist(["refresh", "check_github_again"]),
  }),
  v.strictObject({
    state: v.literal("pending"),
    count: v.pipe(v.number(), v.integer(), v.minValue(0)),
    review: v.strictObject({
      nodeId: v.pipe(v.string(), v.minLength(1)),
      headSha: v.pipe(v.string(), v.minLength(7)),
      comments: v.array(pendingReviewCommentSchema),
    }),
  }),
  v.strictObject({
    state: v.literal("recovery_required"),
    action: v.picklist(["start", "add_thread", "submit", "discard"]),
  }),
]);
const directSummaryReviewProjectionSchema = v.variant("state", [
  v.strictObject({ state: v.literal("idle") }),
  v.strictObject({
    state: v.literal("confirmed"),
    receipt: v.strictObject({
      reviewId: v.pipe(v.string(), v.minLength(1)),
      event: v.picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
    }),
  }),
  v.strictObject({ state: v.literal("recovery_required"), resolution: v.picklist(["check_required", "manual_resolution_required"]) }),
]);
const directSummaryReviewResponseSchema = v.strictObject({
  directSummary: directSummaryReviewProjectionSchema,
});
export type DirectSummaryReviewProjection = v.InferOutput<typeof directSummaryReviewProjectionSchema>;
export function parseDirectSummaryReviewResponse(input: unknown): DirectSummaryReviewProjection | undefined {
  const parsed = v.safeParse(directSummaryReviewResponseSchema, input);
  return parsed.success ? parsed.output.directSummary : undefined;
}

const analysisFindingReviewStatusSchema = v.variant("state", [
  v.strictObject({ state: v.literal("actionable") }),
  v.strictObject({ state: v.literal("pending_review") }),
  v.strictObject({ state: v.literal("published") }),
  v.strictObject({ state: v.literal("locked") }),
]);
const analysisReviewActionsSchema = v.strictObject({
  findings: v.record(v.string(), analysisFindingReviewStatusSchema),
  canFinishWithAnalysisSummary: v.boolean(),
});

const workbenchProjectionSchema = v.strictObject({
  state: v.literal("review"),
  review: v.strictObject({ id: v.pipe(v.string(), v.minLength(1)), status: v.picklist(["open", "merged", "closed"]) }),
  session: workbenchSessionSchema,
  revision: v.strictObject({
    reviewedHeadSha: v.pipe(v.string(), v.minLength(7)), patchHash: v.optional(v.pipe(v.string(), v.minLength(64))), currentHeadSha: v.optional(v.pipe(v.string(), v.minLength(7))), freshness: v.picklist(["fresh", "updates_available", "unavailable", "not_refreshed"]), refreshedAt: v.pipe(v.string(), v.isoTimestamp()),
  }),
  fullPatch: v.optional(v.string()), pullRequest: v.optional(pullRequestSummarySchema), commits: v.array(commitSchema),
  insights: v.strictObject({ analysis: analysisInsightSchema, walkthrough: walkthroughInsightSchema }),
  analysisReviewActions: v.optional(analysisReviewActionsSchema),
  draft: v.optional(reviewBatchSchema), pendingReview: v.optional(pendingReviewProjectionSchema), directSummary: v.optional(directSummaryReviewProjectionSchema), directSummaryDecision: v.optional(v.picklist(["allowed", "blocked_author", "unknown"])), conversation: conversationSchema, checks: checkSchema, mergeReadiness: mergeReadinessSchema, mergeReasons: v.optional(v.array(mergeReasonSchema)), recoveryView: v.optional(recoveryViewSchema),
});
export type WorkbenchResponse = v.InferOutput<typeof workbenchProjectionSchema>;
export type PendingReviewProjection = v.InferOutput<typeof pendingReviewProjectionSchema>;
export function parsePendingReviewProjection(input: unknown): PendingReviewProjection | undefined {
  const parsed = v.safeParse(pendingReviewProjectionSchema, input);
  return parsed.success ? parsed.output : undefined;
}
export function parseReviewBatchProjection(input: unknown): WorkbenchResponse["draft"] | undefined {
  const parsed = v.safeParse(reviewBatchSchema, input);
  return parsed.success ? parsed.output : undefined;
}

const insightRunResponseSchema = v.strictObject({
  runId: v.pipe(v.string(), v.minLength(1)),
  type: v.picklist(["analysis", "walkthrough"]),
  status: v.picklist(["queued", "running", "cancelling", "completed", "failed", "cancelled"]),
  failureReason: v.optional(v.picklist(["cancelled", "failed", "invalid_result", "superseded"])),
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
  fileCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  additions: v.pipe(v.number(), v.integer(), v.minValue(0)),
  deletions: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type CommitDiffResponse = v.InferOutput<typeof commitDiffResponseSchema>;

export function parseCommitDiffResponse(input: unknown): CommitDiffResponse | undefined {
  const parsed = v.safeParse(commitDiffResponseSchema, input);
  if (!parsed.success || parsed.output.position > parsed.output.total) return undefined;
  return parsed.output;
}

const publicationPreviewSchema = v.strictObject({
  reviewId: v.pipe(v.string(), v.minLength(1)), sessionId: v.pipe(v.string(), v.minLength(1)), headSha: v.pipe(v.string(), v.minLength(7)), draftRevision: v.pipe(v.string(), v.isoTimestamp()), event: v.picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]), body: v.string(),
  inlineComments: v.array(v.strictObject({ itemId: v.pipe(v.string(), v.minLength(1)), path: v.string(), startLine: v.number(), line: v.number(), side: v.picklist(["new", "old"]), body: v.string() })),
  threadActions: v.array(v.strictObject({ itemId: v.pipe(v.string(), v.minLength(1)), action: v.picklist(["reply", "resolve", "reopen"]), body: v.optional(v.string()) })),
  warnings: v.array(v.picklist(["no_inline_comments", "github_decision_changed"])),
});
export type PublicationPreviewResponse = v.InferOutput<typeof publicationPreviewSchema>;
export function parsePublicationPreview(input: unknown): PublicationPreviewResponse | undefined {
  const parsed = v.safeParse(publicationPreviewSchema, input);
  return parsed.success ? parsed.output : undefined;
}
const remoteReviewContextSchema = v.strictObject({
  pullRequest: v.optional(pullRequestSummarySchema), currentHeadSha: v.optional(v.pipe(v.string(), v.minLength(7))), freshness: v.picklist(["fresh", "stale", "updates_available", "unavailable", "not_refreshed"]), refreshedAt: v.pipe(v.string(), v.isoTimestamp()), conversation: conversationSchema, checks: checkSchema, mergeReadiness: v.optional(mergeReadinessSchema), mergeReasons: v.optional(v.array(mergeReasonSchema)),
});
export type RemoteReviewContextResponse = v.InferOutput<typeof remoteReviewContextSchema>;
/** Reject malformed current GitHub context before merging it into saved work. */
export function parseRemoteReviewContext(input: unknown): RemoteReviewContextResponse | undefined {
  const parsed = v.safeParse(remoteReviewContextSchema, input);
  return parsed.success ? parsed.output : undefined;
}

const modelCatalogEntrySchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
});

const providerStatusSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  configured: v.boolean(),
  source: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
  guidance: v.pipe(v.string(), v.minLength(1), v.maxLength(240)),
});

const modelCatalogSchema = v.strictObject({
  // The backend advertises the complete universal non-OAuth catalog. It may be
  // empty when no eligible provider is configured and can exceed any small
  // arbitrary count; each entry remains individually bounded above.
  models: v.array(modelCatalogEntrySchema),
  providers: v.optional(v.pipe(v.array(providerStatusSchema), v.maxLength(64))),
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

const insightProviderModelSchema = v.strictObject({
  provider: v.picklist(["pi", "codex-cli-account"]),
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  reasoning: v.pipe(v.array(v.picklist(["minimal", "low", "medium", "high", "xhigh"])), v.maxLength(8)),
  defaultReasoning: v.optional(v.picklist(["minimal", "low", "medium", "high", "xhigh"])),
});

const insightProviderCatalogSchema = v.strictObject({
  providers: v.array(v.strictObject({
    id: v.picklist(["pi", "codex-cli-account"]),
    label: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    available: v.boolean(),
    guidance: v.pipe(v.string(), v.minLength(1), v.maxLength(240), v.check((value) => !/(?:^|\s)\/[^\s]+|[A-Za-z]:[\\/]/u.test(value), "unsafe provider guidance")),
  })),
  models: v.array(insightProviderModelSchema),
});

export type InsightProviderCatalog = v.InferOutput<typeof insightProviderCatalogSchema>;

/** Rejects malformed passive or activated Insight provider catalogs. */
export function parseInsightProviderCatalog(input: unknown): InsightProviderCatalog | undefined {
  const parsed = v.safeParse(insightProviderCatalogSchema, input);
  return parsed.success ? parsed.output : undefined;
}
