import * as v from "valibot";

import type {
  CheckRunSummary,
  GitHubMergeStateStatus,
  MergePolicySnapshot,
} from "../../domain/github-context";
import type { GitSha } from "../../domain/ids";

export const publishedReviewSchema = v.array(
  v.looseObject({
    id: v.union([v.string(), v.number()]),
    node_id: v.optional(v.string()),
    user: v.nullish(v.looseObject({ login: v.string() })),
    body: v.nullish(v.string()),
    state: v.string(),
    commit_id: v.nullish(v.string()),
    // GitHub omits submitted_at on PENDING reviews (started but not submitted);
    // they are skipped as feedback below, never failures.
    submitted_at: v.nullish(v.string()),
  }),
);
export const publishedCommentSchema = v.array(
  v.looseObject({
    id: v.union([v.string(), v.number()]),
    node_id: v.optional(v.string()),
    user: v.nullish(
      v.looseObject({
        login: v.string(),
        avatar_url: v.optional(v.nullable(v.string())),
      }),
    ),
    body: v.string(),
    created_at: v.string(),
    updated_at: v.optional(v.nullable(v.string())),
    html_url: v.optional(v.string()),
    path: v.optional(v.nullable(v.string())),
    line: v.optional(v.nullable(v.number())),
    start_line: v.optional(v.nullable(v.number())),
    side: v.optional(v.nullable(v.string())),
    pull_request_review_id: v.optional(
      v.nullable(v.union([v.string(), v.number()])),
    ),
  }),
);

/** The pull-request identity a thread or comment node carries. */
export const pullRequestIdentitySchema = v.looseObject({
  number: v.number(),
  repository: v.looseObject({
    name: v.string(),
    owner: v.looseObject({ login: v.string() }),
  }),
});
export const reviewThreadTargetSchema = v.looseObject({
  data: v.looseObject({
    node: v.nullish(
      v.looseObject({
        id: v.string(),
        comments: v.looseObject({
          nodes: v.array(
            v.looseObject({ pullRequest: pullRequestIdentitySchema }),
          ),
        }),
      }),
    ),
  }),
});
export const reviewCommentTargetSchema = v.looseObject({
  data: v.looseObject({
    node: v.nullish(
      v.looseObject({
        id: v.string(),
        viewerDidAuthor: v.boolean(),
        pullRequest: pullRequestIdentitySchema,
      }),
    ),
  }),
});
/** Receipt of a REST write whose GraphQL node id the write journal records. */
export const writtenNodeSchema = v.looseObject({ node_id: v.string() });
/** REST inline-comment receipt: the comment plus the COMMENTED review it submitted. */
export const createdInlineCommentSchema = v.looseObject({
  node_id: v.string(),
  pull_request_review_id: v.nullish(v.union([v.string(), v.number()])),
});
export const addedReviewThreadSchema = v.looseObject({
  data: v.looseObject({
    addPullRequestReviewThread: v.looseObject({
      thread: v.looseObject({
        id: v.string(),
        comments: v.looseObject({
          nodes: v.array(v.looseObject({ id: v.string() })),
        }),
      }),
    }),
  }),
});
export const addedThreadReplySchema = v.looseObject({
  data: v.looseObject({
    addPullRequestReviewThreadReply: v.looseObject({
      comment: v.looseObject({
        id: v.string(),
        pullRequestReview: v.nullish(v.looseObject({ id: v.string() })),
      }),
    }),
  }),
});

// GitHub's collaborator-permission REST endpoint also returns a top-level
// `permission` field, but that field only ever carries the legacy four-value
// vocabulary (admin/write/read/none) — it collapses maintain into write and
// triage into read, so it cannot distinguish triage, which is the entire
// reason canManageLabels exists. `role_name` carries the granular vocabulary
// (admin/maintain/write/triage/read/none) and, for orgs with GitHub custom
// repository roles, an arbitrary role name this codebase has never seen.
// It is parsed as an open string rather than a picklist so an unrecognized
// custom role degrades to a safe "unknown" state in github-adapter.ts
// instead of failing the whole read closed.
export const repositoryPermissionSchema = v.looseObject({
  role_name: v.string(),
});
export const branchProtectionSchema = v.looseObject({
  required_pull_request_reviews: v.optional(
    v.nullable(
      v.looseObject({
        dismissal_restrictions: v.optional(
          v.nullable(
            v.looseObject({
              users: v.optional(v.array(v.looseObject({ login: v.string() }))),
              teams: v.optional(v.array(v.looseObject({ slug: v.string() }))),
              apps: v.optional(v.array(v.looseObject({ slug: v.string() }))),
            }),
          ),
        ),
      }),
    ),
  ),
});
export const mergeEvidenceBranchProtectionSchema = v.looseObject({
  required_pull_request_reviews: v.nullable(
    v.looseObject({
      required_approving_review_count: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(0),
        v.maxValue(100),
      ),
      dismiss_stale_reviews: v.boolean(),
      require_code_owner_reviews: v.boolean(),
    }),
  ),
});
// Bounded per the ADR "Choose a validation style by data boundary": only the
// specific `pull_request` and `required_status_checks` fields Patchdesk
// displays are named here, not the full parameters payload GitHub returns.
export const appliedRulesetRuleParametersSchema = v.looseObject({
  required_approving_review_count: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100)),
  ),
  require_last_push_approval: v.optional(v.boolean()),
  required_review_thread_resolution: v.optional(v.boolean()),
  dismiss_stale_reviews_on_push: v.optional(v.boolean()),
  require_code_owner_review: v.optional(v.boolean()),
  required_status_checks: v.optional(
    v.pipe(
      v.array(
        v.looseObject({
          context: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
        }),
      ),
      v.maxLength(100),
    ),
  ),
});
export const appliedRulesetSchema = v.pipe(
  v.array(
    v.looseObject({
      type: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
      name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
      parameters: v.optional(appliedRulesetRuleParametersSchema),
    }),
  ),
  v.maxLength(50),
);

export const pullRequestCommitSchema = v.looseObject({
  sha: v.string(),
  html_url: v.optional(v.string()),
  commit: v.looseObject({
    message: v.string(),
    author: v.nullable(v.looseObject({ name: v.string(), date: v.string() })),
  }),
});

export const pullRequestSchema = v.looseObject({
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
  node_id: v.optional(v.string()),
  title: v.string(),
  body: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(65_536)))),
  state: v.picklist(["open", "closed"]),
  draft: v.boolean(),
  head: v.looseObject({ ref: v.string(), sha: v.string() }),
  base: v.looseObject({ ref: v.string(), sha: v.optional(v.string()) }),
  user: v.looseObject({ login: v.string() }),
  updated_at: v.string(),
  mergeable_state: v.optional(v.string()),
  labels: v.optional(
    v.array(v.looseObject({ name: v.string(), color: v.string() })),
  ),
  requested_reviewers: v.optional(
    v.array(v.looseObject({ login: v.string() })),
  ),
  assignees: v.optional(v.array(v.looseObject({ login: v.string() }))),
  additions: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  deletions: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  changed_files: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

export const checkRunsSchema = v.looseObject({
  check_runs: v.array(
    v.looseObject({
      name: v.string(),
      status: v.string(),
      conclusion: v.optional(v.nullable(v.string())),
      details_url: v.optional(v.nullable(v.string())),
    }),
  ),
});

export const commitStatusesSchema = v.looseObject({
  state: v.string(),
  statuses: v.array(
    v.looseObject({
      context: v.string(),
      state: v.string(),
      target_url: v.optional(v.nullable(v.string())),
    }),
  ),
});

export const repositoryFileSchema = v.looseObject({
  type: v.string(),
  encoding: v.optional(v.string()),
  content: v.optional(v.string()),
  size: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

export const threadResponseSchema = v.looseObject({
  data: v.looseObject({
    repository: v.looseObject({
      pullRequest: v.looseObject({
        reviewThreads: v.looseObject({
          nodes: v.array(
            v.looseObject({
              id: v.string(),
              isResolved: v.boolean(),
              isOutdated: v.boolean(),
              path: v.optional(v.nullable(v.string())),
              line: v.optional(
                v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
              ),
              originalLine: v.optional(
                v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
              ),
              startLine: v.optional(
                v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
              ),
              diffSide: v.optional(v.nullable(v.string())),
              startDiffSide: v.optional(v.nullable(v.string())),
              comments: v.looseObject({
                nodes: v.array(
                  v.looseObject({
                    id: v.string(),
                    body: v.string(),
                    createdAt: v.string(),
                    updatedAt: v.optional(v.nullable(v.string())),
                    url: v.optional(v.nullable(v.string())),
                    viewerDidAuthor: v.optional(v.boolean()),
                    author: v.nullish(
                      v.looseObject({
                        login: v.string(),
                        avatarUrl: v.optional(v.nullable(v.string())),
                      }),
                    ),
                    path: v.optional(v.nullable(v.string())),
                  }),
                ),
                pageInfo: v.optional(
                  v.looseObject({
                    hasNextPage: v.boolean(),
                    endCursor: v.nullish(v.string()),
                  }),
                ),
              }),
            }),
          ),
          pageInfo: v.optional(
            v.looseObject({
              hasNextPage: v.boolean(),
              endCursor: v.nullish(v.string()),
            }),
          ),
        }),
      }),
    }),
  }),
});

export const pendingReviewThreadsResponseSchema = v.looseObject({
  data: v.looseObject({
    repository: v.looseObject({
      pullRequest: v.looseObject({
        reviewThreads: v.looseObject({
          nodes: v.array(
            v.looseObject({
              id: v.string(),
              isOutdated: v.boolean(),
              path: v.optional(v.nullable(v.string())),
              line: v.optional(
                v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
              ),
              startLine: v.optional(
                v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
              ),
              diffSide: v.optional(v.nullable(v.string())),
              startDiffSide: v.optional(v.nullable(v.string())),
              comments: v.looseObject({
                nodes: v.array(
                  v.looseObject({
                    id: v.string(),
                    body: v.string(),
                    createdAt: v.string(),
                    author: v.nullish(v.looseObject({ login: v.string() })),
                    pullRequestReview: v.optional(
                      v.looseObject({ id: v.string(), state: v.string() }),
                    ),
                  }),
                ),
                pageInfo: v.optional(
                  v.looseObject({
                    hasNextPage: v.boolean(),
                    endCursor: v.nullish(v.string()),
                  }),
                ),
              }),
            }),
          ),
          pageInfo: v.optional(
            v.looseObject({
              hasNextPage: v.boolean(),
              endCursor: v.nullish(v.string()),
            }),
          ),
        }),
      }),
    }),
  }),
});

export const threadCommentsResponseSchema = v.looseObject({
  data: v.looseObject({
    node: v.looseObject({
      comments: v.looseObject({
        nodes: v.array(
          v.looseObject({
            id: v.string(),
            body: v.string(),
            createdAt: v.string(),
            updatedAt: v.optional(v.nullable(v.string())),
            url: v.optional(v.nullable(v.string())),
            viewerDidAuthor: v.optional(v.boolean()),
            author: v.nullish(
              v.looseObject({
                login: v.string(),
                avatarUrl: v.optional(v.nullable(v.string())),
              }),
            ),
            path: v.optional(v.nullable(v.string())),
          }),
        ),
        pageInfo: v.looseObject({
          hasNextPage: v.boolean(),
          endCursor: v.nullish(v.string()),
        }),
      }),
    }),
  }),
});

export const maintainerInboxResponseSchema = v.looseObject({
  data: v.looseObject({
    rateLimit: v.optional(
      v.looseObject({
        remaining: v.pipe(v.number(), v.integer(), v.minValue(0)),
        resetAt: v.string(),
      }),
    ),
    repository: v.looseObject({
      pullRequests: v.looseObject({
        edges: v.array(
          v.looseObject({
            cursor: v.pipe(v.string(), v.minLength(1)),
            node: v.looseObject({
              number: v.pipe(v.number(), v.integer(), v.minValue(1)),
              title: v.string(),
              isDraft: v.boolean(),
              headRefName: v.string(),
              headRefOid: v.string(),
              baseRefName: v.string(),
              baseRefOid: v.optional(v.string()),
              author: v.nullish(v.looseObject({ login: v.string() })),
              updatedAt: v.string(),
              mergeable: v.string(),
              reviewDecision: v.nullish(v.string()),
              additions: v.pipe(v.number(), v.integer(), v.minValue(0)),
              deletions: v.pipe(v.number(), v.integer(), v.minValue(0)),
              changedFiles: v.pipe(v.number(), v.integer(), v.minValue(0)),
              labels: v.looseObject({
                totalCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
                nodes: v.array(
                  v.looseObject({ name: v.string(), color: v.string() }),
                ),
                pageInfo: v.looseObject({ hasNextPage: v.boolean() }),
              }),
              reviewRequests: v.looseObject({
                nodes: v.array(
                  v.looseObject({
                    requestedReviewer: v.nullish(
                      v.looseObject({ login: v.optional(v.string()) }),
                    ),
                  }),
                ),
              }),
              assignees: v.looseObject({
                nodes: v.array(v.looseObject({ login: v.string() })),
              }),
              commits: v.looseObject({
                nodes: v.array(
                  v.looseObject({
                    commit: v.looseObject({
                      statusCheckRollup: v.nullish(
                        v.looseObject({ state: v.string() }),
                      ),
                    }),
                  }),
                ),
              }),
            }),
          }),
        ),
        pageInfo: v.looseObject({
          hasNextPage: v.boolean(),
          endCursor: v.nullish(v.string()),
        }),
      }),
    }),
  }),
});

/** One rollup entry: a CheckRun or a StatusContext, discriminated by `__typename`. */
export const mergePolicyContextSchema = v.looseObject({
  __typename: v.string(),
  name: v.optional(v.string()),
  status: v.optional(v.string()),
  conclusion: v.optional(v.nullish(v.string())),
  detailsUrl: v.optional(v.nullish(v.string())),
  context: v.optional(v.string()),
  state: v.optional(v.string()),
  targetUrl: v.optional(v.nullish(v.string())),
});
export type MergePolicyContext = v.InferOutput<typeof mergePolicyContextSchema>;

export const repositoryLabelsResponseSchema = v.looseObject({
  data: v.looseObject({
    repository: v.looseObject({
      labels: v.looseObject({
        totalCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
        nodes: v.array(
          v.looseObject({
            id: v.string(),
            name: v.string(),
            color: v.string(),
            description: v.optional(v.nullable(v.string())),
          }),
        ),
      }),
    }),
  }),
});

export const assignableUsersResponseSchema = v.looseObject({
  data: v.looseObject({
    repository: v.looseObject({
      assignableUsers: v.looseObject({
        totalCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
        nodes: v.array(
          v.looseObject({
            id: v.string(),
            login: v.string(),
            name: v.optional(v.nullable(v.string())),
            avatarUrl: v.optional(v.nullable(v.string())),
          }),
        ),
      }),
    }),
  }),
});

/** One `latestReviews`/`reviews` node: a review's author, state, submission time, and the commit it targeted. `commit` is nullable in GitHub's own schema (a rare data anomaly), so absence here is not treated as a parse failure. */
const pullRequestReviewEntryWireSchema = v.looseObject({
  author: v.nullish(
    v.looseObject({
      login: v.optional(v.string()),
      avatarUrl: v.optional(v.nullable(v.string())),
    }),
  ),
  state: v.picklist([
    "PENDING",
    "COMMENTED",
    "APPROVED",
    "CHANGES_REQUESTED",
    "DISMISSED",
  ]),
  submittedAt: v.nullish(v.string()),
  commit: v.nullish(v.looseObject({ oid: v.optional(v.string()) })),
});

const requestedReviewerWireSchema = v.looseObject({
  login: v.optional(v.string()),
  name: v.optional(v.nullable(v.string())),
  avatarUrl: v.optional(v.nullable(v.string())),
});

export const pullRequestReviewersResponseSchema = v.looseObject({
  data: v.looseObject({
    repository: v.looseObject({
      pullRequest: v.looseObject({
        reviewRequests: v.looseObject({
          nodes: v.array(
            v.looseObject({
              // `... on User` on the query side means a team/bot reviewer
              // parses to `{}` here, not `null` — the wrapper stays
              // `v.nullish` for the (nullable) union field itself, while the
              // inner `login` staying optional is what lets that empty
              // object parse successfully.
              requestedReviewer: v.nullish(requestedReviewerWireSchema),
            }),
          ),
        }),
        latestReviews: v.looseObject({
          nodes: v.array(pullRequestReviewEntryWireSchema),
        }),
        reviews: v.looseObject({
          nodes: v.array(pullRequestReviewEntryWireSchema),
        }),
        suggestedReviewers: v.array(
          v.looseObject({
            isAuthor: v.boolean(),
            isCommenter: v.boolean(),
            // Always `User!` in GitHub's schema, never a union — no `... on
            // User` fragment on the query side, so `login` is required here.
            reviewer: v.looseObject({
              login: v.string(),
              name: v.optional(v.nullable(v.string())),
              avatarUrl: v.optional(v.nullable(v.string())),
            }),
          }),
        ),
      }),
    }),
  }),
});

export const mergePolicyResponseSchema = v.looseObject({
  data: v.looseObject({
    repository: v.looseObject({
      pullRequest: v.looseObject({
        state: v.string(),
        isDraft: v.boolean(),
        headRefOid: v.string(),
        baseRefOid: v.string(),
        baseRefName: v.string(),
        mergeable: v.string(),
        mergeStateStatus: v.nullish(v.string()),
        reviewDecision: v.nullish(v.string()),
        commits: v.looseObject({
          nodes: v.array(
            v.looseObject({
              commit: v.looseObject({
                statusCheckRollup: v.nullish(
                  v.looseObject({
                    contexts: v.looseObject({
                      nodes: v.array(mergePolicyContextSchema),
                      pageInfo: v.looseObject({
                        hasNextPage: v.boolean(),
                        endCursor: v.nullish(v.string()),
                      }),
                    }),
                  }),
                ),
              }),
            }),
          ),
        }),
      }),
    }),
  }),
});

/** A REST review identifier: GitHub sends either a string or a safe integer. */
export const reviewIdSchema = v.union([
  v.string(),
  v.pipe(v.number(), v.safeInteger()),
]);
/** REST receipt returned by review create and submit calls. */
export const reviewReceiptSchema = v.looseObject({
  id: reviewIdSchema,
  state: v.optional(v.string()),
});
export type ReviewReceipt = v.InferOutput<typeof reviewReceiptSchema>;
/** REST pull-request payload read only for its merge outcome. */
export const mergeOutcomeSchema = v.looseObject({
  state: v.string(),
  merged_at: v.nullish(v.string()),
  merge_commit_sha: v.nullish(v.string()),
});
/** REST merge receipt: GitHub confirms the merge and names its commit. */
export const mergeResultSchema = v.looseObject({
  merged: v.boolean(),
  sha: v.nullish(v.string()),
});
/** REST receipt of a submitted summary review. */
export const directSummaryReceiptSchema = v.looseObject({
  id: reviewIdSchema,
  state: v.string(),
  commit_id: v.nullish(v.string()),
  submitted_at: v.nullish(v.string()),
});

export const requiredStatusChecksSchema = v.looseObject({
  contexts: v.optional(v.array(v.string())),
  checks: v.optional(v.array(v.looseObject({ context: v.string() }))),
});

export type MergePolicyPage = {
  readonly headSha: GitSha;
  readonly baseSha: GitSha;
  readonly baseBranch: string;
  readonly isOpen: boolean;
  readonly isDraft: boolean;
  readonly mergeability: MergePolicySnapshot["mergeability"];
  readonly mergeStateStatus: GitHubMergeStateStatus;
  readonly reviewDecision: MergePolicySnapshot["reviewDecision"];
  readonly contexts: ReadonlyArray<CheckRunSummary>;
  readonly hasNextPage: boolean;
  readonly endCursor?: string;
};
