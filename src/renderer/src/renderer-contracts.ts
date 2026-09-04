import * as v from "valibot";
import {
  mergeReadinessSchema,
  parseMergeReceipt,
  remoteWriteRecoverySchema,
  type MergeReceipt,
  viewerLoginSchema,
} from "./review-write-receipts";
import { briefInsightSchema } from "./brief-contracts";
import { insightFields, retainedInsightFields } from "./insight-contracts";
import { inboxRecommendedActionSchema } from "./inbox-action-contract";
import { inboxInsightReadinessSchema } from "./inbox-insight-contract";
import { changeScopeSchema } from "../../domain/change-scope";
import { FORBIDDEN_REASONS } from "../../domain/github-forbidden-reason";
import type { RawJsonValue } from "../../domain/json";
import { FINDING_MAPPING_STATUSES } from "../../domain/review-result";
import {
  INBOX_DATA_FRESHNESS,
  INBOX_PAGE_SIZES,
  INBOX_REPOSITORY_OUTCOMES,
  INBOX_SNAPSHOT_STATES,
  INBOX_STATE_FILTER_VALUES,
} from "../../domain/maintainer-inbox";
import { GITHUB_REVIEW_EVENTS } from "../../domain/pending-review";
/** The one renderer-side spelling of the domain's closed forbidden-reason set. */
const forbiddenReasonSchema = v.optional(v.picklist(FORBIDDEN_REASONS));

/** The one renderer-side spelling of the repository identity triple. */
const repositoryIdentityFields = {
  host: v.pipe(v.string(), v.minLength(1)),
  owner: v.pipe(v.string(), v.minLength(1)),
  repo: v.pipe(v.string(), v.minLength(1)),
} as const;

const pullRequestRefSchema = v.strictObject({
  ...repositoryIdentityFields,
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
/** GitHub's aggregate review verdict; one spelling for the inbox row and the pull-request summary. */
const reviewStateSchema = v.picklist([
  "none",
  "review_pending",
  "approved",
  "changes_requested",
  "unknown",
]);

const inboxRowSchema = v.strictObject({
  remoteState: v.picklist(INBOX_STATE_FILTER_VALUES),
  identity: pullRequestRefSchema,
  title: v.pipe(v.string(), v.minLength(1)),
  author: v.pipe(v.string(), v.minLength(1)),
  // The author's GitHub avatar URL, kept only so the row can say which cached
  // avatar it means; the renderer never points an `<img>` at it.
  authorAvatarUrl: v.optional(v.pipe(v.string(), v.minLength(1))),
  // `data:` URI resolved main-process-side from the avatar cache; the only
  // form the renderer's `img-src 'self' data:` CSP allows an `<img>` to point
  // at. See `MaintainerInboxRow.authorAvatarDataUri`.
  authorAvatarDataUri: v.optional(v.pipe(v.string(), v.minLength(1))),
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
  reviewState: reviewStateSchema,
  mergeability: v.picklist(["mergeable", "conflicting", "blocked", "unknown"]),
  /** Present only for a row whose retained Review session still matches the current head; see `MaintainerInboxRow.scope`. */
  scope: v.optional(changeScopeSchema),
  /** Present only when the row's Review retains at least one Insight; see `MaintainerInboxRow.insights`. */
  insights: v.optional(inboxInsightReadinessSchema),
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
  recommendedAction: inboxRecommendedActionSchema,
  dataFreshness: v.picklist(INBOX_DATA_FRESHNESS),
});

const repoOutcomeSchema = v.object({
  repo: v.object(repositoryIdentityFields),
  state: v.picklist(INBOX_REPOSITORY_OUTCOMES),
  resumeAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  forbiddenReason: forbiddenReasonSchema,
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
    rulePaths: v.optional(v.array(v.string())),
    repos: v.optional(
      v.array(
        v.object({
          ...repositoryIdentityFields,
          // Absent on a watched repository with no local checkout configured
          // (the main process omits the key rather than sending `null`; see
          // `parseWatchedRepo` in `src/domain/workspace-profile.ts`). Without
          // this field the Settings watchlist grouping
          // (`groupWatchlistEntries` in `settings-workspace-repositories.tsx`)
          // could never match a repo to its saved workspace root.
          localPath: v.optional(v.pipe(v.string(), v.minLength(1))),
        }),
      ),
    ),
  }),
  inbox: v.object({
    state: v.picklist(INBOX_STATE_FILTER_VALUES),
    pageSize: v.picklist(INBOX_PAGE_SIZES),
    nextPageToken: v.optional(v.pipe(v.string(), v.minLength(1))),
    rows: v.array(inboxRowSchema),
    repositories: v.array(repoOutcomeSchema),
    /** GitHub's repository-wide match count for the current filter, absent on a cached or failed read that cannot know it. Never the loaded page's row count. */
    matchCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    dataFreshness: v.picklist(INBOX_DATA_FRESHNESS),
    snapshot: v.optional(
      v.strictObject({
        state: v.picklist(INBOX_SNAPSHOT_STATES),
        refreshedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
      }),
    ),
  }),
});

export type InboxResponse = v.InferOutput<typeof inboxResponseSchema>;
export type InboxRow = InboxResponse["inbox"]["rows"][number];

/** Parses the local API's JSON-safe inbox projection before renderer state owns it. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
export function parseInboxResponse(input: unknown): InboxResponse | undefined {
  const parsed = v.safeParse(inboxResponseSchema, input);
  return parsed.success ? parsed.output : undefined;
}

/** Stable renderer key for selection, preferences, and list navigation. */
export function inboxIdentityKey(row: InboxRow): string {
  return pullRequestIdentityKey(row.identity);
}

/**
 * The one key a pull request is named by in renderer state. Openings are keyed
 * by it too, so a pull request reached without a listed row — a pasted link —
 * lands on the same key as the row that names it.
 */
export function pullRequestIdentityKey(identity: {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}): string {
  return `${identity.host}/${identity.owner}/${identity.repo}#${identity.number}`;
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

/** Parses the local API's local-tool/auth environment check. */
export function parseEnvironmentCheckResponse(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): EnvironmentCheckResponse | undefined {
  const parsed = v.safeParse(environmentCheckResponseSchema, input);
  return parsed.success ? parsed.output : undefined;
}
// `POST /v1/profiles` answers with the whole stored profile, of which the
// renderer needs only the id the service derived, so this stays a plain
// `v.object` rather than a `v.strictObject` over every profile field.
const createdProfileSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
});

/** Parses the id `POST /v1/profiles` reports for the workspace it created. */
export function parseCreatedProfileId(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): string | undefined {
  const parsed = v.safeParse(createdProfileSchema, input);
  return parsed.success ? parsed.output.id : undefined;
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
  forbiddenReason: forbiddenReasonSchema,
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
  forbiddenReason: forbiddenReasonSchema,
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
  forbiddenReason: forbiddenReasonSchema,
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
    ...repositoryIdentityFields,
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

/** Both timeline comment kinds parse through this one schema: the entry `_tag`, not a comment field, says which endpoint it came from, and the renderer reads none of the extras. The storage boundary is where the two shapes are told apart strictly. */
const conversationCommentSchema = v.strictObject({
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
  reviewState: reviewStateSchema,
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
      mappingStatus: v.picklist(FINDING_MAPPING_STATUSES),
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
      ...retainedInsightFields,
      value: reviewResultSchema,
      scope: v.optional(insightScopeSchema),
    }),
  ),
});
const walkthroughInsightSchema = v.strictObject({
  ...insightFields,
  retained: v.optional(
    v.strictObject({
      ...retainedInsightFields,
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
    comment: conversationCommentSchema,
  }),
  v.strictObject({
    _tag: v.literal("ReviewComment"),
    comment: conversationCommentSchema,
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
      event: v.picklist(GITHUB_REVIEW_EVENTS),
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
  viewerLogin: viewerLoginSchema,
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
  scope: v.optional(changeScopeSchema),
  pullRequest: v.optional(pullRequestSummarySchema),
  commits: v.array(commitSchema),
  insights: v.strictObject({
    analysis: analysisInsightSchema,
    walkthrough: walkthroughInsightSchema,
    /** Optional for the same reason `mergeReasons` is: the projection always sends one, and a response without it reads as a Brief that was never generated. */
    brief: v.optional(briefInsightSchema),
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
  remoteWriteRecovery: v.optional(remoteWriteRecoverySchema),
});
export type WorkbenchResponse = v.InferOutput<typeof workbenchProjectionSchema>;
export type RemoteWriteRecovery = v.InferOutput<
  typeof remoteWriteRecoverySchema
>;
export { parseMergeReceipt, type MergeReceipt };
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
  type: v.picklist(["analysis", "walkthrough", "brief"]),
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
