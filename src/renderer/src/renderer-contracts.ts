import * as v from "valibot";

import {
  CALL_FLOW_LANGUAGE_NAMES,
  type CallFlowNode,
} from "../../domain/call-flow";
import type { RawJsonValue } from "../../domain/json";
import { INBOX_PAGE_SIZES } from "../../domain/maintainer-inbox";

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
    v.picklist([
      "success",
      "failure",
      "cancelled",
      "timed_out",
      "skipped",
      "neutral",
    ]),
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
    kind: v.literal("open_merged_review"),
    label: v.literal("View merged pull request"),
  }),
  v.strictObject({
    kind: v.literal("open_saved_review"),
    label: v.literal("Open Review"),
    reviewId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({
    kind: v.literal("open_merge_readiness"),
    label: v.literal("Open merge readiness"),
    reviewId: v.pipe(v.string(), v.minLength(1)),
  }),
]);

const inboxRowSchema = v.strictObject({
  remoteState: v.picklist(["open", "merged"]),
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
      reviewId: v.pipe(v.string(), v.minLength(1)),
      reviewedHeadSha: v.pipe(v.string(), v.minLength(7)),
      updatedAt: v.pipe(v.string(), v.isoTimestamp()),
      matchesCurrentHead: v.boolean(),
    }),
  ),
  labels: v.array(v.strictObject({ name: v.string(), color: v.string() })),
  labelCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  categories: v.array(v.picklist(["updated_since_review", "ready_to_merge"])),
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
  resumeAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  forbiddenReason: v.optional(
    v.picklist(["ip_allow_list", "saml", "insufficient_scopes", "unknown"]),
  ),
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
    repos: v.optional(
      v.array(
        v.object({
          host: v.pipe(v.string(), v.minLength(1)),
          owner: v.pipe(v.string(), v.minLength(1)),
          repo: v.pipe(v.string(), v.minLength(1)),
        }),
      ),
    ),
  }),
  inbox: v.object({
    scope: v.picklist(["open", "merged"]),
    pageSize: v.picklist(INBOX_PAGE_SIZES),
    nextPageToken: v.optional(v.pipe(v.string(), v.minLength(1))),
    rows: v.array(inboxRowSchema),
    repositories: v.array(repoOutcomeSchema),
    /** GitHub's repository-wide match count for the current filter, absent on a cached or failed read that cannot know it. Never the loaded page's row count. */
    matchCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    dataFreshness: v.picklist(["fresh", "cached"]),
    snapshot: v.optional(
      v.strictObject({
        state: v.picklist([
          "current",
          "partial",
          "failed_cached",
          "stale_cached",
          "unavailable",
        ]),
        refreshedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
      }),
    ),
  }),
});

export type InboxResponse = v.InferOutput<typeof inboxResponseSchema>;
export type InboxRow = InboxResponse["inbox"]["rows"][number];
export type InboxView = "my_inbox" | "updated" | "ready_to_merge" | "all_open";

/** Parses the local API's JSON-safe inbox projection before renderer state owns it. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
export function parseInboxResponse(input: unknown): InboxResponse | undefined {
  const parsed = v.safeParse(inboxResponseSchema, input);
  return parsed.success ? parsed.output : undefined;
}

/** Stable renderer key for selection, preferences, and list navigation. */
export function inboxIdentityKey(row: InboxRow): string {
  return `${row.identity.host}/${row.identity.owner}/${row.identity.repo}#${row.identity.number}`;
}

// `GET /v1/environment` carries app metadata (productName, version, ...)
// this parser does not care about, so it stays a plain `v.object` — the same
// choice `inboxResponseSchema` makes for `profile` — rather than a
// `v.strictObject` that would reject the response the moment an unrelated
// metadata field changes.
const environmentCheckResponseSchema = v.object({
  git: v.picklist(["ready", "missing"]),
  gh: v.picklist(["ready", "missing"]),
  githubAuth: v.picklist(["ready", "authentication_required", "unavailable"]),
  // The backend always returns an array (possibly empty), never omits the
  // key, so this stays required rather than `v.optional` — an unparseable
  // or missing `githubAccounts` is a real signal that the probe response
  // itself is malformed, not an absent-but-fine field.
  githubAccounts: v.array(
    v.strictObject({
      host: v.pipe(v.string(), v.minLength(1)),
      login: v.pipe(v.string(), v.minLength(1)),
      active: v.boolean(),
    }),
  ),
});

export type EnvironmentCheckResponse = v.InferOutput<
  typeof environmentCheckResponseSchema
>;
export type GithubAuthAccount =
  EnvironmentCheckResponse["githubAccounts"][number];

/** Parses the local API's local-tool/auth environment check for the setup checklist. */
export function parseEnvironmentCheckResponse(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): EnvironmentCheckResponse | undefined {
  const parsed = v.safeParse(environmentCheckResponseSchema, input);
  return parsed.success ? parsed.output : undefined;
}

// `GET /v1/watchlist/suggestions` returns a flat array of not-yet-watched
// repositories discovered under the active profile's workspace roots
// (`DashboardService.discoverWorkspaceRepos`). `localPath` is the only field
// that lets a caller attribute a suggestion back to the workspace root that
// produced it (by path prefix), so it stays required.
const discoveredRepoSchema = v.strictObject({
  host: v.pipe(v.string(), v.minLength(1)),
  owner: v.pipe(v.string(), v.minLength(1)),
  repo: v.pipe(v.string(), v.minLength(1)),
  localPath: v.pipe(v.string(), v.minLength(1)),
});

export type DiscoveredRepo = v.InferOutput<typeof discoveredRepoSchema>;

/** Parses `GET /v1/watchlist/suggestions`'s discovered-repository list. */
export function parseDiscoveredRepos(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): ReadonlyArray<DiscoveredRepo> | undefined {
  const parsed = v.safeParse(v.array(discoveredRepoSchema), input);
  return parsed.success ? parsed.output : undefined;
}

const githubAccessCheckResponseSchema = v.strictObject({
  state: v.picklist(["available", "github_auth"]),
});

export type GitHubAccessCheckResponse = v.InferOutput<
  typeof githubAccessCheckResponseSchema
>;

/** Parses the local API's GitHub access check for the setup checklist. */
export function parseGitHubAccessCheckResponse(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): GitHubAccessCheckResponse | undefined {
  const parsed = v.safeParse(githubAccessCheckResponseSchema, input);
  return parsed.success ? parsed.output : undefined;
}

// `GET /v1/reviews/labels` is a local-API payload Patchdesk owns on both
// sides (ADR "Choose a validation style by data boundary"), so it gets a
// `v.strictObject` schema parsed with `v.safeParse` — the same style
// `inboxResponseSchema` uses above — rather than the per-field `v.fallback`
// style reserved for local, user-editable preference state.
const repositoryLabelListResponseSchema = v.strictObject({
  state: v.picklist([
    "ready",
    "github_auth",
    "github_read",
    "github_rate_limited",
    "github_forbidden",
  ]),
  labels: v.optional(
    v.array(
      v.strictObject({
        id: v.pipe(v.string(), v.minLength(1)),
        name: v.pipe(v.string(), v.minLength(1)),
        color: v.pipe(v.string(), v.minLength(1)),
        description: v.optional(v.pipe(v.string(), v.minLength(1))),
      }),
    ),
  ),
  // GitHub's exact total; compare against `labels.length` to detect
  // truncation of the bounded page the local API returns.
  totalCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  // Only present on `state: "ready"` — the real, service-computed
  // three-state label-write permission (never inferred from a failed
  // write). See `LabelListOutcome` in `src/services/label-service.ts`.
  permission: v.optional(v.picklist(["permitted", "denied", "unknown"])),
  resumeAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  forbiddenReason: v.optional(
    v.picklist(["ip_allow_list", "saml", "insufficient_scopes", "unknown"]),
  ),
});

export type RepositoryLabelListResponse = v.InferOutput<
  typeof repositoryLabelListResponseSchema
>;

/** Parses the local API's repository label listing before a label picker owns it. */
export function parseRepositoryLabelListResponse(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): RepositoryLabelListResponse | undefined {
  const parsed = v.safeParse(repositoryLabelListResponseSchema, input);
  return parsed.success ? parsed.output : undefined;
}

// `GET /v1/reviews/assignees` mirrors `repositoryLabelListResponseSchema`
// exactly in structure and validation style; see its comment above. It
// fails closed the same way: a consumer applies `permission ?? "unknown"`
// (that consumer is the renderer's assignee picker, owned elsewhere).
const assignableUserListResponseSchema = v.strictObject({
  state: v.picklist([
    "ready",
    "github_auth",
    "github_read",
    "github_rate_limited",
    "github_forbidden",
  ]),
  users: v.optional(
    v.array(
      v.strictObject({
        id: v.pipe(v.string(), v.minLength(1)),
        login: v.pipe(v.string(), v.minLength(1)),
        name: v.optional(v.pipe(v.string(), v.minLength(1))),
        avatarUrl: v.optional(v.pipe(v.string(), v.minLength(1))),
        // `data:` URI resolved main-process-side from the avatar cache; the
        // only form the renderer's `img-src 'self' data:` CSP allows an
        // `<img>` to point at. See `AssignableUser.avatarDataUri`.
        avatarDataUri: v.optional(v.pipe(v.string(), v.minLength(1))),
      }),
    ),
  ),
  // GitHub's exact total; compare against `users.length` to detect
  // truncation of the bounded page the local API returns.
  totalCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  // Only present on `state: "ready"` — the real, service-computed
  // three-state assignee-write permission (never inferred from a failed
  // write). See `AssigneeListOutcome` in `src/services/assignee-service.ts`.
  permission: v.optional(v.picklist(["permitted", "denied", "unknown"])),
  resumeAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  forbiddenReason: v.optional(
    v.picklist(["ip_allow_list", "saml", "insufficient_scopes", "unknown"]),
  ),
});

export type AssignableUserListResponse = v.InferOutput<
  typeof assignableUserListResponseSchema
>;

/** Parses the local API's assignable-user listing before an assignee picker owns it. */
export function parseAssignableUserListResponse(
  input: RawJsonValue | undefined,
): AssignableUserListResponse | undefined {
  const parsed = v.safeParse(assignableUserListResponseSchema, input);
  return parsed.success ? parsed.output : undefined;
}

// `GET /v1/reviews/reviewers` mirrors `assignableUserListResponseSchema`
// exactly in structure and validation style; see its comment above. Each
// reviewer row carries its Revision-bound review verdict (absent for a
// requested-but-unanswered reviewer — see `ReviewerVerdictRow` in
// `src/domain/review-verdicts.ts`) alongside the same fail-closed
// permission discipline.
const reviewerListResponseSchema = v.strictObject({
  state: v.picklist([
    "ready",
    "github_auth",
    "github_read",
    "github_rate_limited",
    "github_forbidden",
  ]),
  reviewers: v.optional(
    v.array(
      v.strictObject({
        login: v.pipe(v.string(), v.minLength(1)),
        name: v.optional(v.pipe(v.string(), v.minLength(1))),
        avatarUrl: v.optional(v.pipe(v.string(), v.minLength(1))),
        // `data:` URI resolved main-process-side from the avatar cache; see
        // `assignableUserListResponseSchema.users.avatarDataUri` above.
        avatarDataUri: v.optional(v.pipe(v.string(), v.minLength(1))),
        verdict: v.optional(
          v.picklist([
            "approved",
            "changes_requested",
            "commented",
            "dismissed",
          ]),
        ),
        outdated: v.boolean(),
        submittedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
      }),
    ),
  ),
  suggested: v.optional(
    v.array(
      v.strictObject({
        isAuthor: v.boolean(),
        isCommenter: v.boolean(),
        reviewer: v.strictObject({
          login: v.pipe(v.string(), v.minLength(1)),
          name: v.optional(v.pipe(v.string(), v.minLength(1))),
          avatarUrl: v.optional(v.pipe(v.string(), v.minLength(1))),
          avatarDataUri: v.optional(v.pipe(v.string(), v.minLength(1))),
        }),
      }),
    ),
  ),
  candidates: v.optional(
    v.array(
      v.strictObject({
        id: v.pipe(v.string(), v.minLength(1)),
        login: v.pipe(v.string(), v.minLength(1)),
        name: v.optional(v.pipe(v.string(), v.minLength(1))),
        avatarUrl: v.optional(v.pipe(v.string(), v.minLength(1))),
        avatarDataUri: v.optional(v.pipe(v.string(), v.minLength(1))),
      }),
    ),
  ),
  // GitHub's exact candidate total; compare against `candidates.length` to
  // detect truncation of the bounded page the local API returns.
  candidatesTotalCount: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0)),
  ),
  // Only present on `state: "ready"` — the real, service-computed
  // three-state reviewer-write permission (never inferred from a failed
  // write). See `ReviewerListOutcome` in `src/services/reviewer-service.ts`.
  permission: v.optional(v.picklist(["permitted", "denied", "unknown"])),
  resumeAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  forbiddenReason: v.optional(
    v.picklist(["ip_allow_list", "saml", "insufficient_scopes", "unknown"]),
  ),
});

export type ReviewerListResponse = v.InferOutput<
  typeof reviewerListResponseSchema
>;

/** Parses the local API's reviewer listing before the reviewer rail owns it. */
export function parseReviewerListResponse(
  input: RawJsonValue | undefined,
): ReviewerListResponse | undefined {
  const parsed = v.safeParse(reviewerListResponseSchema, input);
  return parsed.success ? parsed.output : undefined;
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

const repoRelativePathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(1_024),
  v.regex(/^[^\\/]/, "Path must be repository-relative"),
  v.regex(/^(?!\\.\\.?([\\/]|$))/, "Path must not traverse parent directories"),
  v.regex(
    /^(?!.*[\\/]\\.\\.?([\\/]|$))/,
    "Path must not traverse parent directories",
  ),
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
  authorAvatarUrl: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** `data:` URI resolved server-side from the on-disk avatar cache; the renderer's CSP cannot load `authorAvatarUrl` directly. */
  authorAvatarDataUri: v.optional(v.pipe(v.string(), v.minLength(1))),
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
  nodeId: v.optional(v.string()),
  description: v.optional(v.string()),
  author: v.string(),
  headBranch: v.string(),
  baseBranch: v.string(),
  headSha: v.pipe(v.string(), v.minLength(7)),
  baseSha: v.optional(v.pipe(v.string(), v.minLength(7))),
  isDraft: v.boolean(),
  isOpen: v.boolean(),
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
  findings: v.array(
    v.strictObject({
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
      category: v.optional(
        v.picklist([
          "bug",
          "security",
          "test",
          "performance",
          "maintainability",
          "docs",
        ]),
      ),
      affectedScenario: v.optional(v.pipe(v.string(), v.minLength(1))),
      whyItMatters: v.optional(v.pipe(v.string(), v.minLength(1))),
      suggestedChange: v.optional(v.pipe(v.string(), v.minLength(1))),
      mappingStatus: v.picklist(["mapped", "unmapped", "invalid_line"]),
      disposition: v.optional(v.picklist(["open", "added", "dismissed"])),
    }),
  ),
  validationPlan: v.array(v.string()),
  assumptions: v.array(v.string()),
  coverage: v.optional(v.picklist(["high", "medium", "low"])),
  overallConfidence: v.optional(v.picklist(["high", "medium", "low"])),
  unresolvedItems: v.optional(v.array(v.string())),
  callouts: v.optional(
    v.array(
      v.strictObject({
        category: v.picklist([
          "migration",
          "dependency",
          "dependency_change",
          "authentication",
          "compatibility",
          "destructive_operation",
          "feature_flag",
          "configuration",
        ]),
        title: v.pipe(v.string(), v.minLength(1)),
        detail: v.pipe(v.string(), v.minLength(1)),
        path: v.optional(repoRelativePathSchema),
      }),
    ),
  ),
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
  chapters: v.array(
    v.strictObject({
      id: v.pipe(v.string(), v.minLength(1)),
      title: v.pipe(v.string(), v.minLength(1)),
      sections: v.array(
        v.strictObject({
          id: v.pipe(v.string(), v.minLength(1)),
          title: v.pipe(v.string(), v.minLength(1)),
          prose: v.pipe(v.string(), v.minLength(1)),
          hunkIds: v.array(v.pipe(v.string(), v.minLength(1))),
          hunks: v.array(narrativeHunkSchema),
        }),
      ),
    }),
  ),
  support: v.strictObject({
    id: v.literal("support"),
    title: v.literal("Support"),
    hunkIds: v.array(v.pipe(v.string(), v.minLength(1))),
    hunks: v.array(narrativeHunkSchema),
  }),
});

const insightFields = {
  status: v.picklist([
    "not_generated",
    "running",
    "current",
    "outdated",
    "failed",
  ]),
  artifactStatus: v.optional(v.picklist(["verified", "mismatch"])),
  activeRun: v.optional(
    v.strictObject({
      runId: v.optional(v.pipe(v.string(), v.minLength(1))),
      sessionId: v.pipe(v.string(), v.minLength(1)),
      startedAt: v.pipe(v.string(), v.isoTimestamp()),
    }),
  ),
  replacementFailure: v.optional(
    v.strictObject({
      runId: v.optional(v.pipe(v.string(), v.minLength(1))),
      category: v.optional(
        v.picklist([
          "authentication_required",
          "rate_limited",
          "runtime_unavailable",
          "timed_out",
          "execution_failed",
          "invalid_result",
          "unexpected_failure",
        ]),
      ),
      model: v.pipe(v.string(), v.minLength(1)),
      reasoning: v.picklist(["minimal", "low", "medium", "high", "xhigh"]),
      retryable: v.boolean(),
    }),
  ),
  progress: v.optional(
    v.strictObject({
      reviewedSectionIds: v.array(v.pipe(v.string(), v.minLength(1))),
      supportReviewed: v.boolean(),
      currentSectionId: v.optional(v.pipe(v.string(), v.minLength(1))),
    }),
  ),
} as const;
const insightScopeSchema = v.strictObject({
  baseShort: v.string(),
  headShort: v.string(),
  commitCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  fileCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  additions: v.pipe(v.number(), v.integer(), v.minValue(0)),
  deletions: v.pipe(v.number(), v.integer(), v.minValue(0)),
  changedFiles: v.array(
    v.strictObject({
      path: repoRelativePathSchema,
      additions: v.pipe(v.number(), v.integer(), v.minValue(0)),
      deletions: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  ),
});
const analysisInsightSchema = v.strictObject({
  ...insightFields,
  retained: v.optional(
    v.strictObject({
      runId: v.optional(v.pipe(v.string(), v.minLength(1))),
      sessionId: v.pipe(v.string(), v.minLength(1)),
      headSha: v.pipe(v.string(), v.minLength(7)),
      generatedAt: v.pipe(v.string(), v.isoTimestamp()),
      value: reviewResultSchema,
      scope: v.optional(insightScopeSchema),
    }),
  ),
});
const walkthroughInsightSchema = v.strictObject({
  ...insightFields,
  retained: v.optional(
    v.strictObject({
      runId: v.optional(v.pipe(v.string(), v.minLength(1))),
      sessionId: v.pipe(v.string(), v.minLength(1)),
      headSha: v.pipe(v.string(), v.minLength(7)),
      generatedAt: v.pipe(v.string(), v.isoTimestamp()),
      value: narrativeWalkthroughSchema,
    }),
  ),
});

const publishedReviewSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  nodeId: v.optional(v.string()),
  author: v.pipe(v.string(), v.minLength(1)),
  body: v.string(),
  event: v.picklist([
    "APPROVED",
    "COMMENTED",
    "CHANGES_REQUESTED",
    "DISMISSED",
  ]),
  submittedAt: v.pipe(v.string(), v.isoTimestamp()),
  canDismiss: v.boolean(),
});

const conversationEntrySchema = v.variant("_tag", [
  v.strictObject({ _tag: v.literal("PrDescription"), body: v.string() }),
  v.strictObject({
    _tag: v.literal("IssueComment"),
    comment: conversationIssueCommentSchema,
  }),
  v.strictObject({
    _tag: v.literal("ReviewSummary"),
    review: publishedReviewSchema,
  }),
  v.strictObject({
    _tag: v.literal("GeneralThread"),
    thread: githubThreadSchema,
  }),
]);

const conversationSchema = v.strictObject({
  prDescription: v.string(),
  entries: v.array(conversationEntrySchema),
  inline: v.optional(
    v.strictObject({
      threads: v.array(githubThreadSchema),
      complete: v.optional(v.boolean()),
      incompleteReason: v.optional(
        v.picklist(["thread_cap", "comment_cap", "pagination", "unavailable"]),
      ),
    }),
  ),
  complete: v.optional(v.boolean()),
  incompleteReason: v.optional(
    v.picklist(["thread_cap", "comment_cap", "pagination", "unavailable"]),
  ),
});
const mergeReadinessSchema = v.strictObject({
  _tag: v.picklist(["Ready", "Blocked", "NeedsAcknowledgement"]),
  blockers: v.array(v.string()),
  warnings: v.array(v.string()),
});
const mergeReasonSchema = v.strictObject({
  code: v.picklist([
    "review_required",
    "changes_requested",
    "behind",
    "conflicts",
    "checks",
    "blocked",
  ]),
  message: v.string(),
  source: v.picklist([
    "github_pr_state",
    "branch_protection",
    "ruleset_configuration",
    "checks",
  ]),
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
  v.strictObject({
    state: v.literal("recovery_required"),
    resolution: v.picklist(["check_required", "manual_resolution_required"]),
  }),
]);
const directSummaryReviewResponseSchema = v.strictObject({
  directSummary: directSummaryReviewProjectionSchema,
});
export type DirectSummaryReviewProjection = v.InferOutput<
  typeof directSummaryReviewProjectionSchema
>;
export function parseDirectSummaryReviewResponse(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): DirectSummaryReviewProjection | undefined {
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
  review: v.strictObject({
    id: v.pipe(v.string(), v.minLength(1)),
    status: v.picklist(["open", "merged", "closed"]),
  }),
  session: workbenchSessionSchema,
  localCheckout: v.optional(
    v.strictObject({
      state: v.literal("metadata_only"),
      message: v.string(),
    }),
  ),
  revision: v.strictObject({
    reviewedHeadSha: v.pipe(v.string(), v.minLength(7)),
    patchHash: v.optional(v.pipe(v.string(), v.minLength(64))),
    currentHeadSha: v.optional(v.pipe(v.string(), v.minLength(7))),
    freshness: v.picklist([
      "fresh",
      "updates_available",
      "unavailable",
      "not_refreshed",
    ]),
    refreshedAt: v.pipe(v.string(), v.isoTimestamp()),
  }),
  fullPatch: v.optional(v.string()),
  pullRequest: v.optional(pullRequestSummarySchema),
  commits: v.array(commitSchema),
  insights: v.strictObject({
    analysis: analysisInsightSchema,
    walkthrough: walkthroughInsightSchema,
  }),
  analysisReviewActions: v.optional(analysisReviewActionsSchema),
  pendingReview: v.optional(pendingReviewProjectionSchema),
  directSummary: v.optional(directSummaryReviewProjectionSchema),
  directSummaryDecision: v.optional(
    v.picklist(["allowed", "blocked_author", "unknown"]),
  ),
  conversation: conversationSchema,
  checks: checkSchema,
  mergeReadiness: mergeReadinessSchema,
  mergeReasons: v.optional(v.array(mergeReasonSchema)),
});
export type WorkbenchResponse = v.InferOutput<typeof workbenchProjectionSchema>;
export type PendingReviewProjection = v.InferOutput<
  typeof pendingReviewProjectionSchema
>;
export function parsePendingReviewProjection(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): PendingReviewProjection | undefined {
  const parsed = v.safeParse(pendingReviewProjectionSchema, input);
  return parsed.success ? parsed.output : undefined;
}

const insightRunResponseSchema = v.strictObject({
  runId: v.pipe(v.string(), v.minLength(1)),
  type: v.picklist(["analysis", "walkthrough"]),
  status: v.picklist([
    "queued",
    "running",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
  ]),
  failureReason: v.optional(
    v.picklist(["cancelled", "failed", "invalid_result", "superseded"]),
  ),
});
export type InsightRunResponse = v.InferOutput<typeof insightRunResponseSchema>;
export function parseInsightRunResponse(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): InsightRunResponse | undefined {
  const parsed = v.safeParse(insightRunResponseSchema, input);
  return parsed.success ? parsed.output : undefined;
}

/** Reject malformed local API review projections before they influence renderer state. */
export function parseWorkbenchResponse(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): WorkbenchResponse | undefined {
  const parsed = v.safeParse(workbenchProjectionSchema, input);
  if (parsed.success) return parsed.output;
  // The dot path names only the rejected field (e.g. an unrecognized or
  // missing field), never the field's value, so it is safe to log without
  // repeating the sensitive-value guard's job elsewhere in this file.
  const issuePath = v.getDotPath(parsed.issues[0]) ?? "(unknown field)";
  console.error(`Invalid workbench projection: rejected at "${issuePath}"`);
  return undefined;
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

export function parseCommitDiffResponse(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): CommitDiffResponse | undefined {
  const parsed = v.safeParse(commitDiffResponseSchema, input);
  if (!parsed.success || parsed.output.position > parsed.output.total)
    return undefined;
  return parsed.output;
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
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
export function parseModelCatalog(input: unknown): ModelCatalog | undefined {
  const parsed = v.safeParse(modelCatalogSchema, input);
  return parsed.success ? parsed.output : undefined;
}

export const insightProviderModelSchema = v.strictObject({
  provider: v.picklist(["pi", "codex-cli-account"]),
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  reasoning: v.pipe(
    v.array(v.picklist(["minimal", "low", "medium", "high", "xhigh"])),
    v.maxLength(8),
  ),
  defaultReasoning: v.optional(
    v.picklist(["minimal", "low", "medium", "high", "xhigh"]),
  ),
});

export type InsightProviderCatalogModel = v.InferOutput<
  typeof insightProviderModelSchema
>;

const insightProviderCatalogSchema = v.strictObject({
  providers: v.array(
    v.strictObject({
      id: v.picklist(["pi", "codex-cli-account"]),
      label: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
      available: v.boolean(),
      guidance: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(240),
        v.check(
          (value) => !/(?:^|\s)\/[^\s]+|[A-Za-z]:[\\/]/u.test(value),
          "unsafe provider guidance",
        ),
      ),
    }),
  ),
  models: v.array(insightProviderModelSchema),
});

export type InsightProviderCatalog = v.InferOutput<
  typeof insightProviderCatalogSchema
>;

/** Rejects malformed passive or activated Insight provider catalogs. */
export function parseInsightProviderCatalog(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): InsightProviderCatalog | undefined {
  const parsed = v.safeParse(insightProviderCatalogSchema, input);
  return parsed.success ? parsed.output : undefined;
}

const callFlowNodeSchema: v.GenericSchema<CallFlowNode> = v.lazy(() =>
  v.strictObject({
    key: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
    label: v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)),
    status: v.picklist(["same", "added", "removed"]),
    kind: v.optional(v.picklist(["call", "branch"])),
    file: v.optional(repoRelativePathSchema),
    line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    endLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    children: v.pipe(v.array(callFlowNodeSchema), v.maxLength(5_000)),
  }),
);
const callFlowSnapshotSchema = v.strictObject({
  sessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  baseSha: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
  headSha: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
});
const callFlowLanguagesSchema = v.strictObject({
  analyzed: v.array(v.picklist(CALL_FLOW_LANGUAGE_NAMES)),
  available: v.literal(CALL_FLOW_LANGUAGE_NAMES.length),
  skippedChangedFiles: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
const callFlowResponseSchema = v.variant("state", [
  v.strictObject({
    state: v.literal("ready"),
    snapshot: callFlowSnapshotSchema,
    trees: v.pipe(
      v.array(
        v.strictObject({
          entry: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
          ascii: v.pipe(v.string(), v.maxLength(750_100)),
          tree: callFlowNodeSchema,
        }),
      ),
      v.maxLength(100),
    ),
    ascii: v.pipe(v.string(), v.maxLength(750_100)),
    changedSteps: v.pipe(v.number(), v.integer(), v.minValue(0)),
    contextSteps: v.pipe(v.number(), v.integer(), v.minValue(0)),
    impactedFiles: v.pipe(v.number(), v.integer(), v.minValue(0)),
    languages: callFlowLanguagesSchema,
    truncated: v.boolean(),
  }),
  v.strictObject({
    state: v.literal("unsupported"),
    snapshot: callFlowSnapshotSchema,
    languages: callFlowLanguagesSchema,
  }),
  v.strictObject({
    state: v.literal("unavailable"),
    reason: v.picklist([
      "metadata_only",
      "runtime_unavailable",
      "timed_out",
      "execution_failed",
      "too_large",
      "cancelled",
    ]),
  }),
]);

export type CallFlowResponse = v.InferOutput<typeof callFlowResponseSchema>;

/** Rejects malformed main-process Call Flow output before it reaches UI state. */
export function parseCallFlowResponse(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the renderer's strict JSON boundary parser for the Call Flow response.
  input: unknown,
): CallFlowResponse | undefined {
  const parsed = v.safeParse(callFlowResponseSchema, input);
  return parsed.success ? parsed.output : undefined;
}
