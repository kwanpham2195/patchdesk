import * as v from "valibot";

const pullRequestRefSchema = v.strictObject({
  host: v.pipe(v.string(), v.minLength(1)),
  owner: v.pipe(v.string(), v.minLength(1)),
  repo: v.pipe(v.string(), v.minLength(1)),
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

const checkSchema = v.strictObject({
  overall: v.picklist(["passing", "failing", "pending", "skipped", "unknown"]),
  checks: v.array(v.unknown()),
});

const actionSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("run_review"), label: v.literal("Run review") }),
  v.strictObject({ kind: v.literal("review_updates"), label: v.literal("Review updates"), baseSessionId: v.pipe(v.string(), v.minLength(1)) }),
  v.strictObject({ kind: v.literal("continue_review"), label: v.literal("View review progress"), sessionId: v.pipe(v.string(), v.minLength(1)) }),
  v.strictObject({ kind: v.literal("open_saved_review"), label: v.literal("Open saved review"), sessionId: v.pipe(v.string(), v.minLength(1)) }),
  v.strictObject({ kind: v.literal("inspect_checks"), label: v.literal("Inspect failing checks") }),
  v.strictObject({ kind: v.literal("open_merge_readiness"), label: v.literal("Open merge readiness"), sessionId: v.pipe(v.string(), v.minLength(1)) }),
  v.strictObject({ kind: v.literal("open_discussion"), label: v.literal("Review author response"), sessionId: v.pipe(v.string(), v.minLength(1)) }),
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
  reviewState: v.picklist(["none", "review_pending", "approved", "changes_requested", "unknown"]),
  mergeability: v.picklist(["mergeable", "conflicting", "blocked", "unknown"]),
  latestReview: v.optional(v.strictObject({
    sessionId: v.pipe(v.string(), v.minLength(1)),
    reviewedHeadSha: v.pipe(v.string(), v.minLength(7)),
    state: v.picklist(["starting", "running", "completed", "failed", "draft", "submitted", "merged"]),
    updatedAt: v.pipe(v.string(), v.isoTimestamp()),
    matchesCurrentHead: v.boolean(),
  })),
  categories: v.array(v.picklist([
    "needs_review", "updated_since_review", "waiting_for_author",
    "checks_failing", "checks_pending", "ready_to_merge", "draft",
    "authored", "running", "saved_review",
  ])),
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
    snapshot: v.optional(v.strictObject({
      state: v.picklist(["current", "partial", "failed_cached", "unavailable"]),
      refreshedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
    })),
  }),
});

export type InboxResponse = v.InferOutput<typeof inboxResponseSchema>;
export type InboxRow = InboxResponse["inbox"]["rows"][number];
export type InboxView = "my_inbox" | "updated" | "needs_review" | "waiting" | "checks_failing" | "ready_to_merge" | "all_open";

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
  actionKey: v.optional(v.picklist(["run_review", "reconnect", "start_again", "try_again", "prepare_again"])),
});

const workbenchProjectionSchema = v.variant("state", [
  v.strictObject({
    state: v.literal("review_started"),
    session: workbenchSessionSchema,
    recoveryView: v.optional(recoveryViewSchema),
    fullPatch: v.optional(v.string()),
    pullRequest: v.optional(v.unknown()),
    reviewedHeadSha: v.optional(v.pipe(v.string(), v.minLength(7))),
    currentHeadSha: v.optional(v.pipe(v.string(), v.minLength(7))),
    freshness: v.optional(v.picklist(["fresh", "stale", "unavailable", "not_refreshed"])),
    refreshedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
    checks: v.optional(v.unknown()),
  }),
  v.strictObject({
    state: v.literal("completed"),
    session: workbenchSessionSchema,
    recoveryView: v.optional(recoveryViewSchema),
    result: v.unknown(),
    draft: v.optional(v.unknown()),
    batch: v.optional(v.unknown()),
    comments: v.unknown(),
    checks: v.unknown(),
    history: v.optional(v.unknown()),
    mergeReadiness: v.unknown(),
    reviewScope: v.variant("kind", [
      v.strictObject({ kind: v.literal("full") }),
      v.strictObject({
        kind: v.literal("incremental"),
        baseSessionId: v.pipe(v.string(), v.minLength(1)),
        baseHeadSha: v.pipe(v.string(), v.minLength(7)),
        headSha: v.pipe(v.string(), v.minLength(7)),
      }),
    ]),
    fullPatch: v.optional(v.string()),
    comparison: v.optional(v.unknown()),
    comparisonPatch: v.optional(v.string()),
    lifecycle: v.optional(v.unknown()),
    comparisonAvailability: v.picklist(["available", "not_requested", "incomplete", "missing"]),
    pullRequest: v.optional(v.unknown()),
    reviewedHeadSha: v.pipe(v.string(), v.minLength(7)),
    currentHeadSha: v.optional(v.pipe(v.string(), v.minLength(7))),
    freshness: v.picklist(["fresh", "stale", "unavailable", "not_refreshed"]),
    refreshedAt: v.pipe(v.string(), v.isoTimestamp()),
  }),
]);

export type WorkbenchResponse = v.InferOutput<typeof workbenchProjectionSchema>;

/** Reject malformed local API review projections before they influence renderer state. */
export function parseWorkbenchResponse(input: unknown): WorkbenchResponse | undefined {
  const parsed = v.safeParse(workbenchProjectionSchema, input);
  return parsed.success ? parsed.output : undefined;
}

const walkthroughRepoRelativePathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(1024),
  v.regex(/^[^/\\].*$/, "Repo-relative path must not start with a separator"),
  v.regex(/^(?!\.\.\/).*$/, "Repo-relative path must not include parent traversal"),
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

export type WalkthroughProjection = v.InferOutput<typeof walkthroughProjectionSchema>;

/** Reject malformed walkthrough lifecycle projections before they influence renderer state. */
export function parseWalkthroughProjection(input: unknown): WalkthroughProjection | undefined {
  const parsed = v.safeParse(walkthroughProjectionSchema, input);
  return parsed.success ? parsed.output : undefined;
}

const modelCatalogEntrySchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
});

const modelCatalogSchema = v.strictObject({
  models: v.pipe(v.array(modelCatalogEntrySchema), v.minLength(1), v.maxLength(64)),
  defaultModel: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  defaultReasoning: v.optional(v.picklist(["low", "medium", "high"])),
  reasoning: v.optional(v.array(v.picklist(["low", "medium", "high"]))),
});

export type ModelCatalog = v.InferOutput<typeof modelCatalogSchema>;

/** Reject malformed Pi model catalog responses; renderer keeps the strict shape only. */
export function parseModelCatalog(input: unknown): ModelCatalog | undefined {
  const parsed = v.safeParse(modelCatalogSchema, input);
  return parsed.success ? parsed.output : undefined;
}
