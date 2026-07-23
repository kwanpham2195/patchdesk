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
  v.strictObject({ kind: v.literal("edit_draft"), label: v.literal("Edit review draft"), sessionId: v.pipe(v.string(), v.minLength(1)) }),
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
    "authored", "running", "has_local_draft",
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

const workbenchSessionSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  key: v.strictObject({
    profileId: v.pipe(v.string(), v.minLength(1)),
    owner: v.pipe(v.string(), v.minLength(1)),
    repo: v.pipe(v.string(), v.minLength(1)),
    prNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    headSha: v.pipe(v.string(), v.minLength(7)),
  }),
  currentAttemptId: v.optional(v.pipe(v.string(), v.minLength(1))),
  draftContent: v.optional(v.unknown()),
});

const workbenchProjectionSchema = v.variant("state", [
  v.strictObject({
    state: v.literal("review_started"),
    session: workbenchSessionSchema,
    fullPatch: v.optional(v.string()),
    pullRequest: v.optional(v.unknown()),
    reviewedHeadSha: v.optional(v.pipe(v.string(), v.minLength(7))),
    currentHeadSha: v.optional(v.pipe(v.string(), v.minLength(7))),
    freshness: v.optional(v.picklist(["fresh", "stale", "unavailable"])),
    refreshedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
    checks: v.optional(v.unknown()),
  }),
  v.strictObject({
    state: v.literal("completed"),
    session: workbenchSessionSchema,
    result: v.unknown(),
    draft: v.unknown(),
    comments: v.unknown(),
    checks: v.unknown(),
    history: v.unknown(),
    mergeReadiness: v.unknown(),
    reviewScope: v.variant("kind", [
      v.strictObject({ kind: v.literal("full") }),
      v.strictObject({
        kind: v.literal("incremental"),
        baseSessionId: v.pipe(v.string(), v.minLength(1)),
        baseHeadSha: v.pipe(v.string(), v.minLength(7)),
        headSha: v.pipe(v.string(), v.minLength(7)),
        comparisonPatchPath: v.pipe(v.string(), v.minLength(1)),
        comparisonMetadataPath: v.pipe(v.string(), v.minLength(1)),
        previousFindingsPath: v.pipe(v.string(), v.minLength(1)),
        lifecyclePath: v.pipe(v.string(), v.minLength(1)),
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
    freshness: v.picklist(["fresh", "stale", "unavailable"]),
    refreshedAt: v.pipe(v.string(), v.isoTimestamp()),
  }),
]);

export type WorkbenchResponse = v.InferOutput<typeof workbenchProjectionSchema>;

/** Reject malformed local API review projections before they influence renderer state. */
export function parseWorkbenchResponse(input: unknown): WorkbenchResponse | undefined {
  const parsed = v.safeParse(workbenchProjectionSchema, input);
  return parsed.success ? parsed.output : undefined;
}
