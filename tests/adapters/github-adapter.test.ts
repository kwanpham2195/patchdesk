import { StubCredentials } from "./stub-github-credentials";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
  type CommandRequest,
} from "../../src/adapters/github/command-runner";
import type { GitHubServedTransport } from "../../src/adapters/github/gh-request-runner";
import {
  ghInvocationFor,
  type GhInvocation,
} from "../../src/adapters/github/github-request";
import {
  noChildProcesses,
  orderedTransport,
  type HttpTransportDouble,
} from "./github-transport-doubles";
import {
  createFetchedDiffRefs,
  FakeGitHubAdapter,
  GitHubAdapter,
  pullRequestWritePermission,
  repositoryLabelPermission,
  type GitHubReadFailure,
} from "../../src/adapters/github/github-adapter";
import {
  maintainerInboxQuery,
  maintainerInboxSearchQuery,
} from "../../src/adapters/github/github-graphql-queries";
import {
  GitHubCliCredentials,
  type GitHubCredentials,
} from "../../src/adapters/github/github-credentials";
import { GitHubHttpClient } from "../../src/adapters/github/github-http-client";
import {
  parseGitHubHost,
  parseGitHubLogin,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitHubReviewNodeId,
  parseGitHubReviewRestId,
  parseGitHubThreadId,
  parseAbsolutePath,
  parseGitSha,
  parsePullRequestNumber,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import { type PullRequestRef } from "../../src/domain/pull-request";
import { err, ok } from "../../src/domain/result";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";

const fixtureRoot = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "github",
  "argv",
);
const payloadRoot = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "github",
  "payloads",
);
const headSha = "abcdef1234567890abcdef1234567890abcdef12";
const baseSha = "1234567890abcdef1234567890abcdef12345678";

function mustParse<T, E>(
  result:
    | { readonly _tag: "ok"; readonly value: T }
    | { readonly _tag: "err"; readonly error: E },
): T {
  if (result._tag === "err") throw new Error("Expected test value to parse");
  return result.value;
}

const profile = mustParse(
  parseWorkspaceProfileConfig({
    id: "acme",
    label: "ACME",
    githubHost: "github.com",
    ghAccount: "octo-dev",
    workspaceRoots: [],
    rulePaths: [],
    repos: [],
  }),
);

const pr: PullRequestRef = {
  host: mustParse(parseGitHubHost("github.com")),
  owner: mustParse(parseGitHubOwner("octo-org")),
  repo: mustParse(parseGitHubRepoName("patchdesk")),
  number: mustParse(parsePullRequestNumber(42)),
};

/** The child-process double the `CommandRunner` and local-git suites still need. */
class FakeProcessExecutor implements CommandExecutor {
  readonly requests: Array<ReadonlyArray<string>> = [];

  constructor(private readonly responses: ReadonlyArray<CommandExecution>) {}

  async execute(input: CommandRequest): Promise<CommandExecution> {
    this.requests.push(input.argv);
    const response = this.responses[this.requests.length - 1];
    if (response === undefined)
      throw new Error("Missing fake command response");
    return response;
  }
}

function testAdapter(
  http: GitHubServedTransport,
  commands: CommandRunner = noChildProcesses(),
  credentials: GitHubCredentials = new StubCredentials(),
): GitHubAdapter {
  return new GitHubAdapter(commands, credentials, http);
}

/**
 * The gh invocation one recorded request describes. The golden argv fixtures
 * still state what the adapter asks GitHub for, whatever carries it.
 */
function sent(transport: HttpTransportDouble, index: number): GhInvocation {
  const request = transport.requests[index];
  if (request === undefined)
    throw new Error(`No GitHub request at index ${index}`);
  return ghInvocationFor(request);
}

function sentArgv(
  transport: HttpTransportDouble,
): Array<ReadonlyArray<string>> {
  return transport.requests.map((request) => ghInvocationFor(request).argv);
}

async function golden(name: string): Promise<ReadonlyArray<string>> {
  const parsed = v.safeParse(
    v.array(v.string()),
    JSON.parse(await readFile(join(fixtureRoot, `${name}.json`), "utf8")),
  );
  if (!parsed.success) throw new Error(`Malformed golden argv fixture ${name}`);
  return parsed.output;
}

async function payload(name: string): Promise<string> {
  return readFile(join(payloadRoot, name), "utf8");
}

/** GraphQL response fixture for `confirmPublishedCommentThread`'s read-back. */
function confirmThreadResponse(
  nodes: ReadonlyArray<{
    readonly id: string;
    readonly comments: ReadonlyArray<{
      readonly id: string;
      readonly body: string;
    }>;
  }>,
): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: nodes.map((node) => ({
              id: node.id,
              isResolved: false,
              isOutdated: false,
              comments: {
                nodes: node.comments.map((comment) => ({
                  id: comment.id,
                  body: comment.body,
                  createdAt: "2026-08-17T00:00:00Z",
                })),
              },
            })),
          },
        },
      },
    },
  });
}

/** The REST pull-request payload shape these tests feed to the adapter. */
type PullRequestPayload = {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly draft: boolean;
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string; readonly sha?: string };
  readonly user: { readonly login: string };
  readonly updated_at: string;
  readonly body?: string | null;
  readonly mergeable_state?: string | undefined;
  readonly labels?: ReadonlyArray<{
    readonly name: string;
    readonly color: string;
  }>;
  readonly requested_reviewers?: ReadonlyArray<{ readonly login: string }>;
  readonly assignees?: ReadonlyArray<{ readonly login: string }>;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
  readonly changed_files?: number | undefined;
};

function pullRequestPayload(
  overrides: Partial<PullRequestPayload> = {},
): PullRequestPayload {
  return {
    number: 42,
    title: "Add safe GitHub reads",
    state: "open",
    draft: false,
    head: { ref: "feat/github-read", sha: headSha },
    base: { ref: "sit" },
    user: { login: "reviewer" },
    updated_at: "2026-07-16T12:00:00Z",
    mergeable_state: "clean",
    labels: [{ name: "review", color: "0e8a16" }],
    requested_reviewers: [{ login: "octo-dev" }],
    assignees: [{ login: "octo-dev" }],
    additions: 12,
    deletions: 3,
    changed_files: 2,
    ...overrides,
  };
}

describe("CommandRunner", () => {
  it("captures JSON through explicit argv without exposing stderr", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({ status: "ok" }),
        stderr: "",
      },
    ]);
    const runner = new CommandRunner(executor);
    const argv = ["gh", "auth", "status", "--json", "hosts"];

    const result = await runner.runJson({ argv, timeoutMs: 2_500 });

    expect(result).toEqual({ _tag: "ok", value: { status: "ok" } });
    expect(executor.requests).toEqual([argv]);
  });

  it("classifies timeout, invalid JSON, and authentication without command output", async () => {
    const argv = ["gh", "auth", "status"];
    const timeout = new CommandRunner(
      new FakeProcessExecutor([
        {
          _tag: "TimedOut",
          stdout: "",
          stderr: "",
        },
      ]),
    );
    const invalidJson = new CommandRunner(
      new FakeProcessExecutor([
        {
          _tag: "Exited",
          exitCode: 0,
          stdout: "not json",
          stderr: "",
        },
      ]),
    );
    const auth = new CommandRunner(
      new FakeProcessExecutor([
        {
          _tag: "Exited",
          exitCode: 1,
          stdout: "",
          stderr: "To get started with GitHub CLI, please run: gh auth login",
        },
      ]),
    );

    expect(await timeout.runJson({ argv, timeoutMs: 5 })).toEqual({
      _tag: "err",
      error: { _tag: "CommandTimedOut" },
    });
    expect(await invalidJson.runJson({ argv, timeoutMs: 5 })).toEqual({
      _tag: "err",
      error: { _tag: "CommandInvalidJson" },
    });
    expect(await auth.runJson({ argv, timeoutMs: 5 })).toEqual({
      _tag: "err",
      error: { _tag: "CommandAuthenticationRequired" },
    });
  });
});

describe("GitHubAdapter direct summary writes", () => {
  it("fails closed when the request may have dispatched without an answer", async () => {
    const adapter = testAdapter(
      orderedTransport([{ _tag: "CommandUnavailable" }]),
    );

    await expect(
      adapter.createDirectSummaryReview({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
        event: "COMMENT",
        body: "Summary",
      }),
    ).resolves.toEqual({
      _tag: "err",
      error: {
        _tag: "GitHubWriteFailure",
        category: "unavailable",
        message: "GitHub review request could not be confirmed.",
      },
    });
  });
});

describe("GitHubAdapter merge outcome", () => {
  it("reads merged, open, and closed-unmerged outcomes without a write command", async () => {
    const adapter = testAdapter(
      orderedTransport([
        JSON.stringify({
          state: "closed",
          merged_at: "2026-08-01T00:00:00Z",
          merge_commit_sha: headSha,
        }),
        JSON.stringify({ state: "open" }),
        JSON.stringify({ state: "closed", merged_at: null }),
      ]),
    );

    await expect(
      adapter.getMergeOutcome({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { state: "merged", mergeCommitSha: headSha },
    });
    await expect(adapter.getMergeOutcome({ profile, pr })).resolves.toEqual({
      _tag: "ok",
      value: { state: "open" },
    });
    await expect(adapter.getMergeOutcome({ profile, pr })).resolves.toEqual({
      _tag: "ok",
      value: { state: "closed_unmerged" },
    });
  });
});

describe("GitHubAdapter optional merge-policy evidence", () => {
  const branchProtection = {
    required_pull_request_reviews: {
      required_approving_review_count: 2,
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
    },
  };
  const rules = [
    { type: "required_pull_request_reviews", name: "Protect sit" },
    { type: "required_status_checks" },
  ];

  it("reads bounded classic review fields and applied rule types", async () => {
    const transport = orderedTransport([
      JSON.stringify(branchProtection),
      JSON.stringify(rules),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getMergePolicyEvidence({ profile, pr, branch: "sit" }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        branchProtection: {
          state: "available",
          value: {
            requiredApprovingReviewCount: 2,
            dismissStaleReviews: true,
            requireCodeOwnerReviews: true,
          },
        },
        appliedRuleset: { state: "available", value: { rules } },
      },
    });
    expect(sentArgv(transport)).toEqual([
      [
        "gh",
        "api",
        "--hostname",
        "github.com",
        "repos/octo-org/patchdesk/branches/sit/protection",
      ],
      [
        "gh",
        "api",
        "--hostname",
        "github.com",
        "repos/octo-org/patchdesk/rules/branches/sit",
      ],
    ]);
  });

  it("treats a zero approval count as unavailable policy evidence", async () => {
    const adapter = testAdapter(
      orderedTransport([
        JSON.stringify({
          required_pull_request_reviews: {
            required_approving_review_count: 0,
            dismiss_stale_reviews: false,
            require_code_owner_reviews: false,
          },
        }),
        JSON.stringify([]),
      ]),
    );
    await expect(
      adapter.getMergePolicyEvidence({ profile, pr, branch: "sit" }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        branchProtection: {
          state: "available",
          value: { dismissStaleReviews: false, requireCodeOwnerReviews: false },
        },
      },
    });
  });

  it.each([
    ["403", { _tag: "CommandForbidden", reason: "unknown" }, "forbidden"],
    ["404", { _tag: "CommandNotFound" }, "not_found"],
    ["405", { _tag: "CommandUnsupported" }, "unsupported"],
  ] as const)(
    "maps an optional endpoint HTTP %s response to unavailable evidence",
    async (_status, failure, reason) => {
      const adapter = testAdapter(
        orderedTransport([failure, JSON.stringify(rules)]),
      );
      await expect(
        adapter.getMergePolicyEvidence({ profile, pr, branch: "sit" }),
      ).resolves.toEqual({
        _tag: "ok",
        value: {
          branchProtection: { state: "unavailable", reason },
          appliedRuleset: { state: "available", value: { rules } },
        },
      });
    },
  );

  it("returns a typed adapter failure for malformed successful payloads", async () => {
    const adapter = testAdapter(
      orderedTransport([
        JSON.stringify({
          required_pull_request_reviews: {
            required_approving_review_count: "two",
          },
        }),
        JSON.stringify(rules),
      ]),
    );
    await expect(
      adapter.getMergePolicyEvidence({ profile, pr, branch: "sit" }),
    ).resolves.toEqual({
      _tag: "err",
      error: {
        _tag: "GitHubResponseInvalid",
        operation: "get_merge_policy_evidence",
      },
    });
  });

  it("returns a typed adapter failure when an optional endpoint times out", async () => {
    const adapter = testAdapter(
      orderedTransport([{ _tag: "CommandTimedOut" }, JSON.stringify(rules)]),
    );
    await expect(
      adapter.getMergePolicyEvidence({ profile, pr, branch: "sit" }),
    ).resolves.toEqual({
      _tag: "err",
      error: {
        _tag: "GitHubReadFailed",
        operation: "get_merge_policy_evidence",
      },
    });
  });

  type RuleParametersFixture = {
    // `| string` lets one test exercise the malformed-payload path deliberately.
    readonly required_approving_review_count?: number | string;
    readonly dismiss_stale_reviews_on_push?: boolean;
    readonly require_code_owner_review?: boolean;
    readonly require_last_push_approval?: boolean;
    readonly required_review_thread_resolution?: boolean;
    readonly required_status_checks?: ReadonlyArray<{
      readonly context: string;
    }>;
  };
  type RulesFixture = ReadonlyArray<{
    readonly type: string;
    readonly name?: string;
    readonly parameters?: RuleParametersFixture;
  }>;

  async function withRules(
    rulesPayload: RulesFixture,
  ): ReturnType<GitHubAdapter["getMergePolicyEvidence"]> {
    const adapter = testAdapter(
      orderedTransport([
        JSON.stringify(branchProtection),
        JSON.stringify(rulesPayload),
      ]),
    );
    return adapter.getMergePolicyEvidence({ profile, pr, branch: "sit" });
  }

  it("parses all five pull_request rule parameters through to the domain type", async () => {
    // Trimmed shape from a live probe of the ruleset endpoint.
    const result = await withRules([
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: true,
          required_review_thread_resolution: true,
        },
      },
    ]);
    expect(result).toEqual({
      _tag: "ok",
      value: expect.objectContaining({
        appliedRuleset: {
          state: "available",
          value: {
            rules: [
              {
                type: "pull_request",
                pullRequestParameters: {
                  requiredApprovingReviewCount: 1,
                  dismissStaleReviewsOnPush: false,
                  requireCodeOwnerReview: false,
                  requireLastPushApproval: true,
                  requiredReviewThreadResolution: true,
                },
              },
            ],
          },
        },
      }),
    });
  });

  it("parses required_status_checks contexts through to the expected list", async () => {
    // Trimmed shape from a live probe of the ruleset endpoint.
    const result = await withRules([
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [
            { context: "buildkite/dynamic-onboarding-service" },
          ],
        },
      },
    ]);
    expect(result).toEqual({
      _tag: "ok",
      value: expect.objectContaining({
        appliedRuleset: {
          state: "available",
          value: {
            rules: [
              {
                type: "required_status_checks",
                requiredStatusCheckContexts: [
                  "buildkite/dynamic-onboarding-service",
                ],
              },
            ],
          },
        },
      }),
    });
  });

  it("parses a rule with no parameters and an unrecognised rule type without inventing values", async () => {
    const result = await withRules([
      { type: "pull_request" },
      {
        type: "some_future_rule_type",
        parameters: { required_approving_review_count: 5 },
      },
    ]);
    expect(result).toEqual({
      _tag: "ok",
      value: expect.objectContaining({
        appliedRuleset: {
          state: "available",
          value: {
            rules: [
              { type: "pull_request" },
              { type: "some_future_rule_type" },
            ],
          },
        },
      }),
    });
  });

  it("returns a typed adapter failure for a malformed rule parameters payload", async () => {
    const result = await withRules([
      {
        type: "pull_request",
        parameters: { required_approving_review_count: "one" },
      },
    ]);
    expect(result).toEqual({
      _tag: "err",
      error: {
        _tag: "GitHubResponseInvalid",
        operation: "get_merge_policy_evidence",
      },
    });
  });
});

describe("GitHubAdapter repository label permission", () => {
  // GitHub's collaborator-permission endpoint reports the granular role
  // vocabulary in `role_name` (verified live: `gh api
  // repos/{owner}/{repo}/collaborators/{user}/permission --jq role_name`
  // returns "write" for a standard write collaborator, never the legacy
  // "push"). The top-level `permission` field only ever carries the legacy
  // four-value vocabulary and is not read for this derivation.
  it.each([
    ["admin", true],
    ["maintain", true],
    ["write", true],
    ["triage", true],
    ["read", false],
    ["none", false],
  ] as const)(
    "maps collaborator role %s to canManageLabels %s",
    async (role_name, canManageLabels) => {
      const adapter = testAdapter(
        orderedTransport([JSON.stringify({ role_name })]),
      );
      await expect(
        adapter.getRepositoryPermission({
          profile,
          pr,
          account: "octo-dev",
        }),
      ).resolves.toMatchObject({
        _tag: "ok",
        value: { permission: role_name, canManageLabels },
      });
    },
  );

  it("keeps pullRequestsWrite denied for triage even though labels are permitted", async () => {
    const adapter = testAdapter(
      orderedTransport([JSON.stringify({ role_name: "triage" })]),
    );
    await expect(
      adapter.getRepositoryPermission({ profile, pr, account: "octo-dev" }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        permission: "triage",
        pullRequestsWrite: false,
        canManageLabels: true,
      },
    });
  });

  it("degrades an unrecognized custom repository role to unknown with every capability denied", async () => {
    // An org with a GitHub custom repository role can return a role_name
    // this codebase has never seen (e.g. "security-champion"). It must
    // degrade to an explicit, safe "unknown" state rather than failing the
    // whole read closed the way a strict picklist would.
    const adapter = testAdapter(
      orderedTransport([JSON.stringify({ role_name: "security-champion" })]),
    );
    await expect(
      adapter.getRepositoryPermission({ profile, pr, account: "octo-dev" }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        permission: "unknown",
        pullRequestsWrite: false,
        canManageLabels: false,
      },
    });
  });
});

describe("repositoryLabelPermission", () => {
  const failure: GitHubReadFailure = {
    _tag: "GitHubReadFailed",
    operation: "get_repository_permission",
  };

  it("reports permitted when evidence grants label management", () => {
    expect(
      repositoryLabelPermission(
        ok({
          account: "octo-dev",
          permission: "triage",
          pullRequestsWrite: false,
          canManageLabels: true,
        }),
      ),
    ).toBe("permitted");
  });

  it("reports denied when evidence withholds label management", () => {
    expect(
      repositoryLabelPermission(
        ok({
          account: "octo-dev",
          permission: "read",
          pullRequestsWrite: false,
          canManageLabels: false,
        }),
      ),
    ).toBe("denied");
  });

  it("reports unknown when the evidence read failed", () => {
    expect(repositoryLabelPermission(err(failure))).toBe("unknown");
  });

  it("reports unknown when no evidence was fetched at all", () => {
    expect(repositoryLabelPermission(undefined)).toBe("unknown");
  });
});

describe("pullRequestWritePermission", () => {
  const failure: GitHubReadFailure = {
    _tag: "GitHubReadFailed",
    operation: "get_repository_permission",
  };

  it("reports permitted when evidence grants pull-request write, unlike label management which triage alone also grants", () => {
    expect(
      pullRequestWritePermission(
        ok({
          account: "octo-dev",
          permission: "write",
          pullRequestsWrite: true,
          canManageLabels: true,
        }),
      ),
    ).toBe("permitted");
  });

  it("reports denied for triage evidence, since triage can manage labels but cannot assign", () => {
    expect(
      pullRequestWritePermission(
        ok({
          account: "octo-dev",
          permission: "triage",
          pullRequestsWrite: false,
          canManageLabels: true,
        }),
      ),
    ).toBe("denied");
  });

  it("reports unknown when the evidence read failed", () => {
    expect(pullRequestWritePermission(err(failure))).toBe("unknown");
  });

  it("reports unknown when no evidence was fetched at all", () => {
    expect(pullRequestWritePermission(undefined)).toBe("unknown");
  });
});

describe("GitHubAdapter read boundary", () => {
  it("reads one OPEN GraphQL inbox page with edge cursors", async () => {
    const page = {
      data: {
        repository: {
          pullRequests: {
            edges: [
              {
                cursor: "edge-42",
                node: {
                  number: 42,
                  title: "Add safe GitHub reads",
                  isDraft: false,
                  headRefName: "feat/github-read",
                  headRefOid: headSha,
                  baseRefName: "sit",
                  author: { login: "reviewer" },
                  updatedAt: "2026-07-16T12:00:00Z",
                  mergeable: "MERGEABLE",
                  reviewDecision: "REVIEW_REQUIRED",
                  additions: 12,
                  deletions: 3,
                  changedFiles: 2,
                  labels: {
                    totalCount: 2,
                    nodes: [{ name: "bug", color: "d73a4a" }],
                    pageInfo: { hasNextPage: false },
                  },
                  reviewRequests: {
                    nodes: [{ requestedReviewer: { login: "octo-dev" } }],
                  },
                  assignees: { nodes: [] },
                  commits: {
                    nodes: [
                      { commit: { statusCheckRollup: { state: "SUCCESS" } } },
                    ],
                  },
                },
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: "cursor-42" },
          },
        },
      },
    };
    const transport = orderedTransport(
      Array.from({ length: 2 }, () => JSON.stringify(page)),
    );
    const adapter = testAdapter(transport);

    const result = await adapter.listMaintainerPullRequests({
      profile,
      pageSize: 25,
      repo: pr,
    });

    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        hasNextPage: true,
        endCursor: "cursor-42",
        entries: [
          {
            cursor: "edge-42",
            pullRequest: {
              summary: {
                reviewState: "review_pending",
                mergeability: "mergeable",
                labels: [{ name: "bug", color: "d73a4a" }],
                labelCount: 2,
              },
              checks: { overall: "passing", checks: [] },
            },
          },
        ],
      },
    });
    const merged = await adapter.listMaintainerPullRequests({
      profile,
      pageSize: 25,
      repo: pr,
      state: "merged",
    });
    expect(merged).toMatchObject({
      _tag: "ok",
      value: { entries: [{ pullRequest: { summary: { isOpen: false } } }] },
    });
    expect(transport.requests).toHaveLength(2);
    // Requests the default inbox page size (25) explicitly.
    expect(sent(transport, 0).argv).toContain("first=25");
    expect(sent(transport, 0).argv).toContain("state=OPEN");
    expect(sent(transport, 1).argv).toContain("state=MERGED");
  });

  it("sends the requested page size as the GraphQL first value", async () => {
    const emptyPage = {
      data: {
        repository: {
          pullRequests: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
    const transport = orderedTransport([JSON.stringify(emptyPage)]);
    const adapter = testAdapter(transport);

    await adapter.listMaintainerPullRequests({
      profile,
      repo: pr,
      pageSize: 10,
    });

    expect(transport.requests).toHaveLength(1);
    expect(sent(transport, 0).argv).toContain("first=10");
  });

  it("retains the continuation cursor for an empty non-final page", async () => {
    const adapter = testAdapter(
      orderedTransport([
        JSON.stringify({
          data: {
            repository: {
              pullRequests: {
                edges: [],
                pageInfo: { hasNextPage: true, endCursor: "cursor-empty" },
              },
            },
          },
        }),
      ]),
    );

    await expect(
      adapter.listMaintainerPullRequests({ profile, repo: pr, pageSize: 25 }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        entries: [],
        hasNextPage: true,
        endCursor: "cursor-empty",
      },
    });
  });

  it("surfaces label truncation via labelCount when a PR has more labels than the bounded fetch returns", async () => {
    const truncatedLabels = Array.from({ length: 20 }, (_, index) => ({
      name: `label-${index}`,
      color: "d73a4a",
    }));
    const page = {
      data: {
        repository: {
          pullRequests: {
            edges: [
              {
                cursor: "edge-42",
                node: {
                  number: 42,
                  title: "Add safe GitHub reads",
                  isDraft: false,
                  headRefName: "feat/github-read",
                  headRefOid: headSha,
                  baseRefName: "sit",
                  author: { login: "reviewer" },
                  updatedAt: "2026-07-16T12:00:00Z",
                  mergeable: "MERGEABLE",
                  reviewDecision: "REVIEW_REQUIRED",
                  additions: 12,
                  deletions: 3,
                  changedFiles: 2,
                  labels: {
                    totalCount: 25,
                    nodes: truncatedLabels,
                    pageInfo: { hasNextPage: true },
                  },
                  reviewRequests: { nodes: [] },
                  assignees: { nodes: [] },
                  commits: {
                    nodes: [
                      { commit: { statusCheckRollup: { state: "SUCCESS" } } },
                    ],
                  },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
    const transport = orderedTransport([JSON.stringify(page)]);
    const adapter = testAdapter(transport);

    const result = await adapter.listMaintainerPullRequests({
      profile,
      pageSize: 25,
      repo: pr,
    });

    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    const summary = result.value.entries[0]?.pullRequest.summary;
    expect(summary?.labelCount).toBe(25);
    expect(summary?.labels).toHaveLength(20);
  });

  it("fetches repository labels with their GraphQL node ids", async () => {
    const page = {
      data: {
        repository: {
          labels: {
            totalCount: 2,
            nodes: [
              { id: "LA_kwDOL7JuT87MAAAB", name: "bug", color: "d73a4a" },
              {
                id: "LA_kwDOL7JuT87MAAAC",
                name: "enhancement",
                color: "a2eeef",
              },
            ],
          },
        },
      },
    };
    const transport = orderedTransport([JSON.stringify(page)]);
    const adapter = testAdapter(transport);

    const result = await adapter.listRepositoryLabels({ profile, repo: pr });

    expect(result).toEqual({
      _tag: "ok",
      value: {
        totalCount: 2,
        labels: [
          { id: "LA_kwDOL7JuT87MAAAB", name: "bug", color: "d73a4a" },
          { id: "LA_kwDOL7JuT87MAAAC", name: "enhancement", color: "a2eeef" },
        ],
      },
    });
    expect(
      sent(transport, 0).argv.some((argument) =>
        argument.includes("labels(first: 100)"),
      ),
    ).toBe(true);
  });

  it("carries a label's description when GitHub reports one, and omits the field entirely when GitHub reports null", async () => {
    const page = {
      data: {
        repository: {
          labels: {
            totalCount: 2,
            nodes: [
              {
                id: "LA_kwDOL7JuT87MAAAB",
                name: "bug",
                color: "d73a4a",
                description: "Something isn't working",
              },
              {
                id: "LA_kwDOL7JuT87MAAAC",
                name: "enhancement",
                color: "a2eeef",
                description: null,
              },
            ],
          },
        },
      },
    };
    const transport = orderedTransport([JSON.stringify(page)]);
    const adapter = testAdapter(transport);

    const result = await adapter.listRepositoryLabels({ profile, repo: pr });

    expect(result).toEqual({
      _tag: "ok",
      value: {
        totalCount: 2,
        labels: [
          {
            id: "LA_kwDOL7JuT87MAAAB",
            name: "bug",
            color: "d73a4a",
            description: "Something isn't working",
          },
          { id: "LA_kwDOL7JuT87MAAAC", name: "enhancement", color: "a2eeef" },
        ],
      },
    });
    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value.labels[1]).not.toHaveProperty("description");
  });

  it("surfaces repository-label truncation via totalCount when more labels exist than the bounded page returned", async () => {
    const page = {
      data: {
        repository: {
          labels: {
            totalCount: 5,
            nodes: [
              { id: "LA_kwDOL7JuT87MAAAB", name: "bug", color: "d73a4a" },
              {
                id: "LA_kwDOL7JuT87MAAAC",
                name: "enhancement",
                color: "a2eeef",
              },
              { id: "LA_kwDOL7JuT87MAAAD", name: "question", color: "d876e3" },
            ],
          },
        },
      },
    };
    const transport = orderedTransport([JSON.stringify(page)]);
    const adapter = testAdapter(transport);

    const result = await adapter.listRepositoryLabels({ profile, repo: pr });

    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value.totalCount).toBe(5);
    expect(result.value.labels).toHaveLength(3);
    // The caller derives the remaining, uncaptured labels from these two counts.
    expect(result.value.totalCount - result.value.labels.length).toBe(2);
  });

  it("fetches assignable users with their GraphQL node ids", async () => {
    const page = {
      data: {
        repository: {
          assignableUsers: {
            totalCount: 2,
            nodes: [
              {
                id: "U_kwDOL7JuT87MAAAB",
                login: "octocat",
                name: "The Octocat",
                avatarUrl: "https://avatars.example/octocat.png",
              },
              {
                id: "U_kwDOL7JuT87MAAAC",
                login: "hubot",
                name: null,
                avatarUrl: null,
              },
            ],
          },
        },
      },
    };
    const transport = orderedTransport([JSON.stringify(page)]);
    const adapter = testAdapter(transport);

    const result = await adapter.listAssignableUsers({ profile, repo: pr });

    expect(result).toEqual({
      _tag: "ok",
      value: {
        totalCount: 2,
        users: [
          {
            id: "U_kwDOL7JuT87MAAAB",
            login: "octocat",
            name: "The Octocat",
            avatarUrl: "https://avatars.example/octocat.png",
          },
          { id: "U_kwDOL7JuT87MAAAC", login: "hubot" },
        ],
      },
    });
    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value.users[1]).not.toHaveProperty("name");
    expect(result.value.users[1]).not.toHaveProperty("avatarUrl");
    expect(
      sent(transport, 0).argv.some((argument) =>
        argument.includes("assignableUsers(first: 100"),
      ),
    ).toBe(true);
  });

  it("passes a caller-supplied search string as the assignableUsers `search` GraphQL variable, omitting it entirely when absent", async () => {
    const page = {
      data: {
        repository: {
          assignableUsers: { totalCount: 0, nodes: [] },
        },
      },
    };
    const withQuery = orderedTransport([JSON.stringify(page)]);
    await testAdapter(withQuery).listAssignableUsers({
      profile,
      repo: pr,
      query: "octo",
    });
    expect(
      sent(withQuery, 0).argv.some((argument) => argument === "search=octo"),
    ).toBe(true);

    const withoutQuery = orderedTransport([JSON.stringify(page)]);
    await testAdapter(withoutQuery).listAssignableUsers({
      profile,
      repo: pr,
    });
    expect(
      sent(withoutQuery, 0).argv.some((argument) =>
        argument.startsWith("search="),
      ),
    ).toBe(false);
  });

  it("sends addAssigneesToAssignable/removeAssigneesFromAssignable with repeated assigneeIds[] flags", async () => {
    const okResponse = JSON.stringify({ data: {} });
    const addTransport = orderedTransport([okResponse]);
    const addResult = await testAdapter(addTransport).addAssigneesToAssignable({
      profile,
      assignableId: "PR_node",
      assigneeIds: ["U_a", "U_b"],
    });
    expect(addResult).toEqual({ _tag: "ok", value: undefined });
    expect(sent(addTransport, 0).argv).toContain("assigneeIds[]=U_a");
    expect(sent(addTransport, 0).argv).toContain("assigneeIds[]=U_b");
    expect(sent(addTransport, 0).argv).toContain("assignableId=PR_node");

    const removeTransport = orderedTransport([okResponse]);
    const removeResult = await testAdapter(
      removeTransport,
    ).removeAssigneesFromAssignable({
      profile,
      assignableId: "PR_node",
      assigneeIds: ["U_a"],
    });
    expect(removeResult).toEqual({ _tag: "ok", value: undefined });
    expect(sent(removeTransport, 0).argv).toContain("assigneeIds[]=U_a");
  });

  it("fetches a pull request's reviewer state: requested reviewers, both review views, and suggestions", async () => {
    const page = {
      data: {
        repository: {
          pullRequest: {
            reviewRequests: {
              nodes: [
                {
                  requestedReviewer: {
                    login: "octocat",
                    name: "The Octocat",
                    avatarUrl: "https://avatars.example/octocat.png",
                  },
                },
                // A team reviewer: the `... on User` fragment does not
                // match, so GitHub returns an empty object here, not null.
                { requestedReviewer: {} },
              ],
            },
            latestReviews: {
              nodes: [
                {
                  author: { login: "hubot", avatarUrl: null },
                  state: "PENDING",
                  submittedAt: null,
                  commit: null,
                },
              ],
            },
            reviews: {
              nodes: [
                {
                  author: { login: "hubot", avatarUrl: null },
                  state: "APPROVED",
                  submittedAt: "2026-01-01T00:00:00Z",
                  commit: { oid: "a".repeat(40) },
                },
                // A ghosted/deleted author is dropped, not merged under a
                // shared placeholder login.
                {
                  author: null,
                  state: "COMMENTED",
                  submittedAt: "2026-01-01T00:00:00Z",
                  commit: { oid: "a".repeat(40) },
                },
              ],
            },
            suggestedReviewers: [
              {
                isAuthor: false,
                isCommenter: true,
                reviewer: { login: "octocat", name: null, avatarUrl: null },
              },
            ],
          },
        },
      },
    };
    const transport = orderedTransport([JSON.stringify(page)]);
    const adapter = testAdapter(transport);

    const result = await adapter.getPullRequestReviewers({ profile, pr });

    expect(result).toEqual({
      _tag: "ok",
      value: {
        requested: [
          {
            login: "octocat",
            name: "The Octocat",
            avatarUrl: "https://avatars.example/octocat.png",
          },
        ],
        latestReviews: [{ login: "hubot", state: "PENDING" }],
        reviews: [
          {
            login: "hubot",
            state: "APPROVED",
            submittedAt: "2026-01-01T00:00:00.000Z",
            commitOid: "a".repeat(40),
          },
        ],
        suggested: [
          {
            isAuthor: false,
            isCommenter: true,
            reviewer: { login: "octocat" },
          },
        ],
      },
    });
    expect(
      sent(transport, 0).argv.some((argument) =>
        argument.includes("PullRequestReviewers"),
      ),
    ).toBe(true);
    expect(sent(transport, 0).argv).toContain(`number=${pr.number}`);
  });

  it("sends requestReviews as an additive union:true mutation with repeated userIds[] flags", async () => {
    const okResponse = JSON.stringify({ data: {} });
    const transport = orderedTransport([okResponse]);

    const result = await testAdapter(transport).requestReviews({
      profile,
      pullRequestId: "PR_node",
      userIds: ["U_a", "U_b"],
    });

    expect(result).toEqual({ _tag: "ok", value: undefined });
    expect(sent(transport, 0).argv).toContain("userIds[]=U_a");
    expect(sent(transport, 0).argv).toContain("userIds[]=U_b");
    expect(sent(transport, 0).argv).toContain("pullRequestId=PR_node");
    expect(
      sent(transport, 0).argv.some(
        (argument) =>
          argument.startsWith("query=") && argument.includes("union: true"),
      ),
    ).toBe(true);
  });

  it("removes requested reviewers via the subtractive DELETE endpoint, sending only the named logins as its body", async () => {
    const okResponse = JSON.stringify({});
    const transport = orderedTransport([okResponse]);

    const result = await testAdapter(transport).removeRequestedReviewers({
      profile,
      pr,
      logins: ["octocat"],
    });

    expect(result).toEqual({ _tag: "ok", value: undefined });
    expect(sent(transport, 0).argv).toContain("--method");
    expect(sent(transport, 0).argv).toContain("DELETE");
    expect(sent(transport, 0).argv).toContain(
      `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/requested_reviewers`,
    );
    // The subtractive REST body carries exactly the named logins — never a
    // recomputed "remaining reviewers" set.
    expect(sent(transport, 0).stdin).toBe(
      JSON.stringify({ reviewers: ["octocat"] }),
    );
  });

  it("classifies a CommandRateLimited listMaintainerPullRequests failure as GitHubRateLimited", async () => {
    const transport = orderedTransport([{ _tag: "CommandRateLimited" }]);
    const adapter = testAdapter(transport);

    const result = await adapter.listMaintainerPullRequests({
      profile,
      pageSize: 25,
      repo: pr,
    });

    expect(result).toEqual({
      _tag: "err",
      error: { _tag: "GitHubRateLimited", operation: "list_maintainer_prs" },
    });
  });

  it("populates the per-host rate-limit cache from a successful rateLimit field, then carries resumeAt on a later rate-limited failure", async () => {
    const resetAt = "2026-08-01T05:00:00Z";
    const successPage = {
      data: {
        rateLimit: { remaining: 10, resetAt },
        repository: {
          pullRequests: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
    const transport = orderedTransport([
      JSON.stringify(successPage),
      { _tag: "CommandRateLimited" },
    ]);
    const adapter = testAdapter(transport);

    const first = await adapter.listMaintainerPullRequests({
      profile,
      pageSize: 25,
      repo: pr,
    });
    expect(first).toMatchObject({ _tag: "ok" });

    const second = await adapter.listMaintainerPullRequests({
      profile,
      pageSize: 25,
      repo: pr,
    });
    expect(second).toEqual({
      _tag: "err",
      error: {
        _tag: "GitHubRateLimited",
        operation: "list_maintainer_prs",
        resumeAt: "2026-08-01T05:00:00.000Z",
      },
    });
  });

  it("classifies the live OmisePayments IP-allow-list GraphQL FORBIDDEN failure as GitHubForbidden/ip_allow_list (plan 009)", async () => {
    const transport = orderedTransport([
      { _tag: "CommandForbidden", reason: "ip_allow_list" },
    ]);
    const adapter = testAdapter(transport);

    const result = await adapter.listMaintainerPullRequests({
      profile,
      pageSize: 25,
      repo: pr,
    });

    expect(result).toEqual({
      _tag: "err",
      error: {
        _tag: "GitHubForbidden",
        operation: "list_maintainer_prs",
        reason: "ip_allow_list",
      },
    });
  });

  // Both listing queries carry `rateLimit { remaining resetAt }`, and they are
  // the only place the per-host rate-limit cache is ever filled. Every other
  // GitHub call reads that cache through commandFailure to report a resume
  // time, so losing the selection here degrades the whole app to a blind
  // sixty-minute wait, silently. The whole selection is asserted, not just the
  // field name: dropping `resetAt` alone would remove the resume time while
  // leaving a substring match on "rateLimit" intact.
  it("guards the rateLimit selection on maintainerInboxQuery, the sole source of the per-host rate-limit cache", () => {
    expect(maintainerInboxQuery).toContain("rateLimit { remaining resetAt }");
  });

  it("guards the rateLimit selection on maintainerInboxSearchQuery, the sole source of the per-host rate-limit cache", () => {
    expect(maintainerInboxSearchQuery).toContain(
      "rateLimit { remaining resetAt }",
    );
  });

  describe("searchMaintainerPullRequests", () => {
    /** Identical wire shape to the "reads one OPEN GraphQL inbox page" node fixture above, so the two queries can be proven to project equal rows for the same node. */
    const sharedNode = {
      number: 42,
      title: "Add safe GitHub reads",
      isDraft: false,
      headRefName: "feat/github-read",
      headRefOid: headSha,
      baseRefName: "sit",
      author: { login: "reviewer" },
      updatedAt: "2026-07-16T12:00:00Z",
      mergeable: "MERGEABLE",
      reviewDecision: "REVIEW_REQUIRED",
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      labels: {
        totalCount: 2,
        nodes: [{ name: "bug", color: "d73a4a" }],
        pageInfo: { hasNextPage: false },
      },
      reviewRequests: {
        nodes: [{ requestedReviewer: { login: "octo-dev" } }],
      },
      assignees: { nodes: [] },
      commits: {
        nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }],
      },
    };

    it("sends the search qualifier string as the GraphQL search variable", async () => {
      const emptyPage = {
        data: {
          search: {
            issueCount: 0,
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
      const transport = orderedTransport([JSON.stringify(emptyPage)]);
      const adapter = testAdapter(transport);

      await adapter.searchMaintainerPullRequests({
        profile,
        repo: pr,
        searchQuery: "repo:octo-org/patchdesk is:pr is:open",
        state: "open",
        pageSize: 25,
      });

      expect(transport.requests).toHaveLength(1);
      expect(sent(transport, 0).argv).toContain(
        "search=repo:octo-org/patchdesk is:pr is:open",
      );
      expect(sent(transport, 0).argv).toContain("first=25");
    });

    it("returns issueCount, GitHub's true repository-wide match count, from the response", async () => {
      const page = {
        data: {
          rateLimit: { remaining: 4998, resetAt: "2026-08-25T10:00:00Z" },
          search: {
            issueCount: 137,
            edges: [{ cursor: "edge-42", node: sharedNode }],
            pageInfo: { hasNextPage: true, endCursor: "cursor-42" },
          },
        },
      };
      const transport = orderedTransport([JSON.stringify(page)]);
      const adapter = testAdapter(transport);

      const result = await adapter.searchMaintainerPullRequests({
        profile,
        repo: pr,
        searchQuery: "repo:octo-org/patchdesk is:pr is:open",
        state: "open",
        pageSize: 25,
      });

      expect(result).toMatchObject({
        _tag: "ok",
        value: { issueCount: 137, hasNextPage: true, endCursor: "cursor-42" },
      });
    });

    it("projects rows equal to what listMaintainerPullRequests produces for the same node fixture", async () => {
      const listPage = {
        data: {
          repository: {
            pullRequests: {
              edges: [{ cursor: "edge-42", node: sharedNode }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
      const searchPage = {
        data: {
          search: {
            issueCount: 1,
            edges: [{ cursor: "edge-42", node: sharedNode }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
      const listAdapter = testAdapter(
        orderedTransport([JSON.stringify(listPage)]),
      );
      const searchAdapter = testAdapter(
        orderedTransport([JSON.stringify(searchPage)]),
      );

      const listResult = await listAdapter.listMaintainerPullRequests({
        profile,
        repo: pr,
        pageSize: 25,
      });
      const searchResult = await searchAdapter.searchMaintainerPullRequests({
        profile,
        repo: pr,
        searchQuery: "repo:octo-org/patchdesk is:pr is:open",
        state: "open",
        pageSize: 25,
      });

      expect(listResult._tag).toBe("ok");
      expect(searchResult._tag).toBe("ok");
      if (listResult._tag !== "ok" || searchResult._tag !== "ok") return;
      expect(searchResult.value.entries).toEqual(listResult.value.entries);
    });
  });

  it("uses checked-in argv contracts for all GitHub read methods and auth", async () => {
    const [listOpenPrs, getPr, getComments, getChecks, getStatuses, getDiff] =
      await Promise.all([
        payload("list-open-prs.json"),
        payload("get-pr.json"),
        payload("get-comments.json"),
        payload("get-checks.json"),
        payload("get-statuses.json"),
        payload("get-diff.patch"),
      ]);
    const transport = orderedTransport([
      listOpenPrs,
      getPr,
      getComments,
      getChecks,
      getStatuses,
      getDiff,
      '{"login":"octo-dev"}',
    ]);
    const adapter = testAdapter(transport);

    expect(
      await adapter.listOpenPullRequests({ profile, repo: pr }),
    ).toMatchObject({
      _tag: "ok",
      value: [
        {
          title: "Add safe GitHub reads",
          changedFileCount: 2,
          requestedReviewers: ["octo-dev"],
          assignees: ["octo-dev"],
        },
      ],
    });
    expect(await adapter.getPullRequest({ profile, pr })).toMatchObject({
      _tag: "ok",
      value: {
        headSha,
        baseBranch: "sit",
        author: "reviewer",
        nodeId: "PR_kwDOL7JuT85qX9Zz",
      },
    });
    expect(await adapter.getPullRequestComments({ profile, pr })).toEqual({
      _tag: "ok",
      value: {
        complete: true,
        threads: [
          {
            complete: true,
            id: "thread-1",
            state: "open",
            location: {
              path: "src/review.ts",
              line: 5,
              lineEnd: 7,
              diffSide: "new",
            },
            comments: [
              expect.objectContaining({
                id: "comment-1",
                location: {
                  path: "src/review.ts",
                  line: 5,
                  lineEnd: 7,
                  diffSide: "new",
                },
              }),
            ],
          },
        ],
      },
    });
    expect(
      await adapter.getPullRequestChecks({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
      }),
    ).toEqual({
      _tag: "ok",
      value: {
        overall: "passing",
        checks: [
          {
            name: "test",
            required: "unknown",
            status: "completed",
            conclusion: "success",
            url: "https://example.test/check",
          },
          {
            name: "AWS CodeBuild",
            required: "unknown",
            status: "completed",
            conclusion: "success",
            url: "https://example.test/build",
          },
        ],
      },
    });
    expect(
      await adapter.getPullRequestDiff({
        profile,
        pr,
        snapshot: {
          baseSha: mustParse(parseGitSha(baseSha)),
          headSha: mustParse(parseGitSha(headSha)),
        },
      }),
    ).toEqual({
      _tag: "ok",
      value: getDiff,
    });
    expect(await adapter.resolveAuthenticatedAccount(profile)).toEqual({
      _tag: "ok",
      value: { host: "github.com", account: "octo-dev" },
    });

    await expect(
      Promise.all([
        golden("list-open-prs"),
        golden("get-pr"),
        golden("get-comments"),
        golden("get-checks"),
        golden("get-statuses"),
        golden("get-diff"),
        golden("auth-status"),
      ]),
    ).resolves.toEqual(sentArgv(transport));
  });

  it("normalizes GitHub's degenerate single-line LEFT thread anchor", async () => {
    // GitHub reports single-line LEFT-side threads with startLine = line + 1;
    // the adapter must anchor them to the one old-side line instead of an
    // inverted range that the Diff mapping would reject.
    const fixture = JSON.parse(await payload("get-comments.json"));
    fixture.data.repository.pullRequest.reviewThreads.nodes[0] = {
      id: "thread-left",
      isResolved: false,
      isOutdated: false,
      path: "src/review.ts",
      line: 43,
      startLine: 44,
      diffSide: "LEFT",
      startDiffSide: null,
      originalLine: 43,
      comments: {
        nodes: [
          {
            id: "comment-left",
            body: "Old side single line.",
            createdAt: "2026-07-16T12:00:00Z",
            updatedAt: null,
            url: "https://example.test/comment/left",
            author: { login: "reviewer" },
            path: "src/review.ts",
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
    const transport = orderedTransport([JSON.stringify(fixture)]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getPullRequestComments({ profile, pr }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        complete: true,
        threads: [
          {
            complete: true,
            id: "thread-left",
            state: "open",
            location: { path: "src/review.ts", line: 43, diffSide: "old" },
            comments: [
              expect.objectContaining({
                id: "comment-left",
                location: { path: "src/review.ts", line: 43, diffSide: "old" },
              }),
            ],
          },
        ],
      },
    });
  });

  it("paginates review threads and retains their server ordering", async () => {
    const first = JSON.parse(await payload("get-comments.json"));
    const second = structuredClone(first);
    first.data.repository.pullRequest.reviewThreads.pageInfo = {
      hasNextPage: true,
      endCursor: "threads-page-2",
    };
    second.data.repository.pullRequest.reviewThreads.nodes[0].id = "thread-2";
    second.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[0].id =
      "comment-2";
    second.data.repository.pullRequest.reviewThreads.pageInfo = {
      hasNextPage: false,
      endCursor: null,
    };
    const transport = orderedTransport([
      JSON.stringify(first),
      JSON.stringify(second),
    ]);
    const adapter = testAdapter(transport);

    await expect(
      adapter.getPullRequestComments({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        complete: true,
        threads: [{ id: "thread-1" }, { id: "thread-2" }],
      },
    });
    expect(sent(transport, 1).argv).toContain("cursor=threads-page-2");
  });

  it("marks a repeated review-thread cursor incomplete", async () => {
    const first = JSON.parse(await payload("get-comments.json"));
    const second = structuredClone(first);
    first.data.repository.pullRequest.reviewThreads.pageInfo = {
      hasNextPage: true,
      endCursor: "repeat",
    };
    second.data.repository.pullRequest.reviewThreads.pageInfo = {
      hasNextPage: true,
      endCursor: "repeat",
    };
    const adapter = testAdapter(
      orderedTransport([JSON.stringify(first), JSON.stringify(second)]),
    );

    await expect(
      adapter.getPullRequestComments({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { complete: false, incompleteReason: "pagination" },
    });
  });

  it("loads a second reply page and preserves earlier replies when that page fails", async () => {
    const outer = JSON.parse(await payload("get-comments.json"));
    outer.data.repository.pullRequest.reviewThreads.nodes[0].comments.pageInfo =
      { hasNextPage: true, endCursor: "replies-page-2" };
    const replies = {
      data: {
        node: {
          comments: {
            nodes: [
              {
                id: "comment-2",
                body: "A later reply.",
                createdAt: "2026-07-16T12:01:00Z",
                updatedAt: null,
                url: "https://example.test/comment/2",
                author: { login: "reviewer" },
                path: "src/review.ts",
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
    const complete = testAdapter(
      orderedTransport([JSON.stringify(outer), JSON.stringify(replies)]),
    );
    await expect(
      complete.getPullRequestComments({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        complete: true,
        threads: [
          {
            complete: true,
            comments: [{ id: "comment-1" }, { id: "comment-2" }],
          },
        ],
      },
    });

    const partial = testAdapter(
      orderedTransport([JSON.stringify(outer), { _tag: "CommandFailed" }]),
    );
    await expect(
      partial.getPullRequestComments({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        complete: false,
        incompleteReason: "comment_cap",
        threads: [{ complete: false, comments: [{ id: "comment-1" }] }],
      },
    });
  });

  it("stops after the bounded review-thread page cap", async () => {
    const fixture = JSON.parse(await payload("get-comments.json"));
    const responses = Array.from({ length: 10 }, (_, index) => {
      const page = structuredClone(fixture);
      page.data.repository.pullRequest.reviewThreads.pageInfo = {
        hasNextPage: true,
        endCursor: `page-${index}`,
      };
      return JSON.stringify(page);
    });
    const adapter = testAdapter(orderedTransport(responses));

    await expect(
      adapter.getPullRequestComments({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { complete: false, incompleteReason: "thread_cap" },
    });
  });

  it("returns a degraded summary when optional GitHub metadata is absent", async () => {
    const adapter = testAdapter(
      orderedTransport([
        JSON.stringify([
          pullRequestPayload({
            labels: [],
            additions: undefined,
            deletions: undefined,
            changed_files: undefined,
            mergeable_state: undefined,
          }),
        ]),
      ]),
    );

    const result = await adapter.listOpenPullRequests({ profile, repo: pr });
    expect(result).toMatchObject({
      _tag: "ok",
      value: [expect.objectContaining({ mergeability: "unknown", labels: [] })],
    });
    if (result._tag === "ok") {
      expect(result.value[0]).not.toHaveProperty("changedFileCount");
      expect(result.value[0]).not.toHaveProperty("additions");
      expect(result.value[0]).not.toHaveProperty("deletions");
    }
  });

  it("uses the immutable managed refs when fetched-ref evidence is supplied", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: `${baseSha}\n`,
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: `${headSha}\n`,
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: "diff --git a/fallback.ts b/fallback.ts\n",
        stderr: "",
      },
    ]);
    const adapter = testAdapter(
      orderedTransport([]),
      new CommandRunner(executor),
    );

    expect(
      await adapter.getPullRequestDiff({
        profile,
        pr,
        fetchedRefs: mustParse(
          createFetchedDiffRefs({
            repositoryPath: mustParse(parseAbsolutePath("/tmp/patchdesk-repo")),
            baseRef: "refs/patchdesk/base",
            headRef: "refs/patchdesk/head",
            baseSha: mustParse(parseGitSha(baseSha)),
            headSha: mustParse(parseGitSha(headSha)),
          }),
        ),
      }),
    ).toEqual({
      _tag: "ok",
      value: "diff --git a/fallback.ts b/fallback.ts\n",
    });
    expect(executor.requests).toEqual([
      [
        "git",
        "-C",
        "/tmp/patchdesk-repo",
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        "refs/patchdesk/base^{commit}",
      ],
      [
        "git",
        "-C",
        "/tmp/patchdesk-repo",
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        "refs/patchdesk/head^{commit}",
      ],
      [
        "git",
        "-C",
        "/tmp/patchdesk-repo",
        "diff",
        "--no-ext-diff",
        "refs/patchdesk/base...refs/patchdesk/head",
      ],
    ]);
  });

  it("uses an immutable GitHub comparison when no managed checkout is available", async () => {
    const transport = orderedTransport(["diff --git a/exact.ts b/exact.ts\n"]);
    const adapter = testAdapter(transport);

    expect(
      await adapter.getPullRequestDiff({
        profile,
        pr,
        snapshot: {
          baseSha: mustParse(parseGitSha(baseSha)),
          headSha: mustParse(parseGitSha(headSha)),
        },
      }),
    ).toEqual({
      _tag: "ok",
      value: "diff --git a/exact.ts b/exact.ts\n",
    });
    expect(sentArgv(transport)).toEqual([
      [
        "gh",
        "api",
        "--hostname",
        profile.githubHost,
        "-H",
        "Accept: application/vnd.github.v3.diff",
        `repos/${pr.owner}/${pr.repo}/compare/${baseSha}...${headSha}`,
      ],
    ]);
  });

  it("rejects untrusted ref names before a git diff fallback can be requested", () => {
    expect(
      createFetchedDiffRefs({
        repositoryPath: mustParse(parseAbsolutePath("/tmp/patchdesk-repo")),
        baseRef: "--output=/tmp/unsafe",
        headRef: "refs/patchdesk/head",
        baseSha: mustParse(parseGitSha(baseSha)),
        headSha: mustParse(parseGitSha(headSha)),
      }),
    ).toEqual({ _tag: "err", error: { _tag: "InvalidFetchedDiffRefs" } });
  });

  it("does not run git diff when an expected fetched ref is absent", async () => {
    const executor = new FakeProcessExecutor([
      { _tag: "Exited", exitCode: 1, stdout: "", stderr: "unknown revision" },
    ]);
    const adapter = testAdapter(
      orderedTransport([]),
      new CommandRunner(executor),
    );

    expect(
      await adapter.getPullRequestDiff({
        profile,
        pr,
        fetchedRefs: mustParse(
          createFetchedDiffRefs({
            repositoryPath: mustParse(parseAbsolutePath("/tmp/patchdesk-repo")),
            baseRef: "refs/patchdesk/base",
            headRef: "refs/patchdesk/head",
            baseSha: mustParse(parseGitSha(baseSha)),
            headSha: mustParse(parseGitSha(headSha)),
          }),
        ),
      }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "GitHubReadFailed", operation: "get_diff" },
    });
    expect(executor.requests).toEqual([
      [
        "git",
        "-C",
        "/tmp/patchdesk-repo",
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        "refs/patchdesk/base^{commit}",
      ],
    ]);
  });

  it("does not run git diff when a managed fetched ref resolves to the wrong commit", async () => {
    const executor = new FakeProcessExecutor([
      { _tag: "Exited", exitCode: 0, stdout: `${headSha}\n`, stderr: "" },
    ]);
    const adapter = testAdapter(
      orderedTransport([]),
      new CommandRunner(executor),
    );

    expect(
      await adapter.getPullRequestDiff({
        profile,
        pr,
        fetchedRefs: mustParse(
          createFetchedDiffRefs({
            repositoryPath: mustParse(parseAbsolutePath("/tmp/patchdesk-repo")),
            baseRef: "refs/patchdesk/base",
            headRef: "refs/patchdesk/head",
            baseSha: mustParse(parseGitSha(baseSha)),
            headSha: mustParse(parseGitSha(headSha)),
          }),
        ),
      }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "GitHubReadFailed", operation: "get_diff" },
    });
    expect(executor.requests).toHaveLength(1);
  });

  it("classifies a credential that authenticates as another account as github_auth", async () => {
    const adapter = testAdapter(
      orderedTransport([JSON.stringify({ login: "another-user", id: 5 })]),
    );

    expect(await adapter.resolveAuthenticatedAccount(profile)).toEqual({
      _tag: "err",
      error: { _tag: "GitHubAuthenticationFailed", operation: "auth_status" },
    });
  });

  it("classifies malformed valid JSON GitHub responses without exposing payloads", async () => {
    const adapter = testAdapter(
      orderedTransport([await payload("malformed-get-pr.json")]),
    );

    expect(await adapter.getPullRequest({ profile, pr })).toEqual({
      _tag: "err",
      error: { _tag: "GitHubResponseInvalid", operation: "get_pr" },
    });
  });

  it("maps missing local GitHub auth to github_auth", async () => {
    const adapter = testAdapter(
      orderedTransport([{ _tag: "CommandAuthenticationRequired" }]),
    );
    expect(await adapter.resolveAuthenticatedAccount(profile)).toEqual({
      _tag: "err",
      error: { _tag: "GitHubAuthenticationFailed", operation: "auth_status" },
    });
  });
  it("lists pull request commits with immutable parsing and head marking", async () => {
    const olderSha = "1111111111111111111111111111111111111111";
    const transport = orderedTransport([
      JSON.stringify(pullRequestPayload()),
      JSON.stringify([
        [
          {
            sha: olderSha,
            html_url: "https://github.com/octo-org/patchdesk/commit/111",
            commit: {
              message: "Older change",
              author: { name: "Older", date: "2026-07-16T11:00:00Z" },
            },
          },
        ],
        [
          {
            sha: headSha,
            html_url: "https://github.com/octo-org/patchdesk/commit/head",
            commit: {
              message: "Head change",
              author: { name: "Head", date: "2026-07-16T12:00:00Z" },
            },
          },
        ],
      ]),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getPullRequestCommits({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: [
        { sha: headSha, message: "Head change", isHead: true },
        { sha: olderSha, message: "Older change", isHead: false },
      ],
    });
    expect(sent(transport, 1).argv).toEqual([
      "gh",
      "api",
      "--paginate",
      "--slurp",
      "--hostname",
      "github.com",
      "repos/octo-org/patchdesk/pulls/42/commits?per_page=100",
    ]);
  });

  it("rejects a commit listing that reaches the deliberate cap", async () => {
    const commits = Array.from({ length: 251 }, (_, index) => ({
      sha: `${"a".repeat(39)}${(index % 16).toString(16)}`,
      commit: {
        message: `Commit ${index}`,
        author: { name: "Author", date: "2026-07-16T12:00:00Z" },
      },
    }));
    const transport = orderedTransport([
      JSON.stringify(pullRequestPayload()),
      JSON.stringify([commits]),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getPullRequestCommits({ profile, pr }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "GitHubResponseInvalid", operation: "get_pr_commits" },
    });
  });
});

describe("GitHubAdapter review write boundary", () => {
  it("creates a pending review and submits its selected event through JSON stdin", async () => {
    const [createArgv, submitArgv, createPayload, submitPayload] =
      await Promise.all([
        golden("create-pending-review"),
        golden("submit-pending-review"),
        payload("create-pending-review.json"),
        payload("submit-pending-review.json"),
      ]);
    const transport = orderedTransport([
      JSON.stringify({ id: 9001, state: "PENDING" }),
      JSON.stringify({ id: 9001, state: "SUBMITTED" }),
    ]);
    const adapter = testAdapter(transport);

    await expect(
      adapter.createPendingReview({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
        summaryBody: "Keep the safety check.",
        comments: [
          {
            body: "Comment body",
            path: "src/review.ts",
            line: 7,
            lineEnd: 9,
            diffSide: "new",
          },
        ],
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { reviewId: "9001", state: "PENDING" },
    });
    await expect(
      adapter.submitPendingReview({
        profile,
        pr,
        reviewId: "9001",
        event: "REQUEST_CHANGES",
        summaryBody: "Request changes before merge.",
      }),
    ).resolves.toEqual({ _tag: "ok", value: { reviewId: "9001" } });

    expect(sentArgv(transport)).toEqual([createArgv, submitArgv]);
    expect(JSON.parse(sent(transport, 0).stdin ?? "{}")).toEqual(
      JSON.parse(createPayload),
    );
    expect(JSON.parse(sent(transport, 1).stdin ?? "{}")).toEqual(
      JSON.parse(submitPayload),
    );
  });

  it("rejects a create response unless GitHub confirms the review is pending", async () => {
    const adapter = testAdapter(
      orderedTransport([JSON.stringify({ id: 9001, state: "SUBMITTED" })]),
    );
    await expect(
      adapter.createPendingReview({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
        summaryBody: "summary",
        comments: [
          {
            body: "Comment body",
            path: "src/review.ts",
            line: 7,
            diffSide: "new",
          },
        ],
      }),
    ).resolves.toEqual({
      _tag: "err",
      error: {
        _tag: "GitHubWriteFailure",
        category: "unavailable",
        message: "GitHub did not return a PENDING review.",
      },
    });
  });

  it("uses the same explicit event endpoint for a summary-only submit", async () => {
    const [submitArgv, summaryPayload] = await Promise.all([
      golden("submit-pending-review"),
      payload("submit-summary-only-review.json"),
    ]);
    const transport = orderedTransport([
      JSON.stringify({ id: 9001, state: "SUBMITTED" }),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.submitPendingReview({
        profile,
        pr,
        reviewId: "9001",
        event: "COMMENT",
        summaryBody: "Summary-only review.",
      }),
    ).resolves.toEqual({ _tag: "ok", value: { reviewId: "9001" } });
    expect(sentArgv(transport)).toEqual([submitArgv]);
    expect(JSON.parse(sent(transport, 0).stdin ?? "{}")).toEqual(
      JSON.parse(summaryPayload),
    );
  });

  it("deletes a review comment through GitHub's id argument", async () => {
    const transport = orderedTransport([
      JSON.stringify({
        data: { deletePullRequestReviewComment: { clientMutationId: "1" } },
      }),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.deleteThreadComment({ profile, commentId: "PRRC_abc" }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
    // GitHub rejects DeletePullRequestReviewCommentInput with a
    // pullRequestReviewCommentId argument; the mutation must pass id.
    const request = sent(transport, 0).argv.join(" ");
    expect(request).toContain("deletePullRequestReviewComment(input:{id:$");
    expect(request).not.toContain("pullRequestReviewCommentId");
  });

  it("exposes the review a reply submits so the write journal can exclude it", async () => {
    const transport = orderedTransport([
      JSON.stringify({
        data: {
          addPullRequestReviewThreadReply: {
            comment: {
              id: "PRRC_reply",
              pullRequestReview: { id: "PRR_review" },
            },
          },
        },
      }),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.createThreadReply({
        profile,
        threadId: mustParse(parseGitHubThreadId("PRRT_thread")),
        body: "A reply",
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { commentId: "PRRC_reply", reviewId: "PRR_review" },
    });
    const request = sent(transport, 0).argv.join(" ");
    expect(request).toContain("pullRequestReview{id}");
  });

  it("retries the read-back with backoff before confirming a thread", async () => {
    vi.useFakeTimers();
    try {
      const restResponse = JSON.stringify({ node_id: "PRRC_comment" });
      const noMatchYet = confirmThreadResponse([]);
      const nowConfirmed = confirmThreadResponse([
        {
          id: "PRRT_thread",
          comments: [{ id: "PRRC_comment", body: "Body" }],
        },
      ]);
      const transport = orderedTransport([
        restResponse,
        noMatchYet,
        nowConfirmed,
      ]);
      const adapter = testAdapter(transport);
      const pending = adapter.createInlineComment({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
        coordinates: { path: "src/a.ts", line: 5, side: "RIGHT" },
        body: "Body",
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toEqual({
        _tag: "ok",
        value: { commentId: "PRRC_comment", threadId: "PRRT_thread" },
      });
      expect(transport.requests).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not upgrade when a matching comment id has a different body, and exhausts all attempts", async () => {
    vi.useFakeTimers();
    try {
      const restResponse = JSON.stringify({ node_id: "PRRC_comment" });
      const idMatchWrongBody = confirmThreadResponse([
        {
          id: "PRRT_thread",
          comments: [{ id: "PRRC_comment", body: "A different body" }],
        },
      ]);
      const transport = orderedTransport([
        restResponse,
        idMatchWrongBody,
        idMatchWrongBody,
        idMatchWrongBody,
      ]);
      const adapter = testAdapter(transport);
      const pending = adapter.createInlineComment({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
        coordinates: { path: "src/a.ts", line: 5, side: "RIGHT" },
        body: "Body",
      });
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1500);
      await expect(pending).resolves.toEqual({
        _tag: "ok",
        value: { commentId: "PRRC_comment" },
      });
      expect(transport.requests).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("degrades the create receipt without upgrading when all read-back attempts are exhausted", async () => {
    vi.useFakeTimers();
    try {
      const restResponse = JSON.stringify({ node_id: "PRRC_comment" });
      const noMatch = confirmThreadResponse([]);
      const transport = orderedTransport([
        restResponse,
        noMatch,
        noMatch,
        noMatch,
      ]);
      const adapter = testAdapter(transport);
      const pending = adapter.createInlineComment({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
        coordinates: { path: "src/a.ts", line: 5, side: "RIGHT" },
        body: "Body",
      });
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1500);
      await expect(pending).resolves.toEqual({
        _tag: "ok",
        value: { commentId: "PRRC_comment" },
      });
      expect(transport.requests).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("proves a review thread target with one bounded node query", async () => {
    const transport = orderedTransport([
      JSON.stringify({
        data: {
          node: {
            id: "PRRT_thread",
            comments: {
              nodes: [
                {
                  id: "PRRC_c1",
                  pullRequest: {
                    repository: {
                      owner: { login: "octo-org" },
                      name: "patchdesk",
                    },
                    number: 42,
                  },
                },
              ],
            },
          },
        },
      }),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getReviewThreadTarget({
        profile,
        pr,
        threadId: mustParse(parseGitHubThreadId("PRRT_thread")),
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: true } });
    const request = sent(transport, 0).argv.join(" ");
    expect(transport.requests).toHaveLength(1);
    expect(request).toContain("query ReviewThreadTarget($id: ID!)");
    expect(request).toContain("comments(first: 1)");
    expect(request).toContain("-F id=PRRT_thread");
    // The proof never carries conversation content.
    expect(request).not.toContain("body");
    expect(request).not.toContain("author");
    expect(request).not.toContain("viewerDidAuthor");
  });

  it("treats a thread from another pull request as not found without disclosing it", async () => {
    const transport = orderedTransport([
      JSON.stringify({
        data: {
          node: {
            id: "PRRT_foreign",
            comments: {
              nodes: [
                {
                  id: "PRRC_c1",
                  pullRequest: {
                    repository: {
                      owner: { login: "octo-org" },
                      name: "patchdesk",
                    },
                    number: 99,
                  },
                },
              ],
            },
          },
        },
      }),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getReviewThreadTarget({
        profile,
        pr,
        threadId: mustParse(parseGitHubThreadId("PRRT_foreign")),
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: false } });
  });

  it("treats a missing, typeless, or comment-less thread node as not found", async () => {
    const missing = orderedTransport([
      JSON.stringify({ data: { node: null } }),
    ]);
    const adapter = testAdapter(missing);
    await expect(
      adapter.getReviewThreadTarget({
        profile,
        pr,
        threadId: mustParse(parseGitHubThreadId("PRRT_gone")),
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: false } });
    const wrongType = orderedTransport([
      JSON.stringify({ data: { node: { id: "PRRT_thread" } } }),
    ]);
    const adapter2 = testAdapter(wrongType);
    await expect(
      adapter2.getReviewThreadTarget({
        profile,
        pr,
        threadId: mustParse(parseGitHubThreadId("PRRT_thread")),
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: false } });
  });

  it("proves a review comment target with viewer authorship", async () => {
    const transport = orderedTransport([
      JSON.stringify({
        data: {
          node: {
            id: "PRRC_comment",
            viewerDidAuthor: true,
            pullRequest: {
              repository: {
                owner: { login: "octo-org" },
                name: "patchdesk",
              },
              number: 42,
            },
          },
        },
      }),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getReviewCommentTarget({
        profile,
        pr,
        commentId: "PRRC_comment",
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { found: true, viewerDidAuthor: true },
    });
    const request = sent(transport, 0).argv.join(" ");
    expect(request).toContain("query ReviewCommentTarget($id: ID!)");
    expect(request).toContain("viewerDidAuthor");
    expect(request).not.toContain("body");
  });

  it("treats a foreign or non-authored comment as the completed target result", async () => {
    const foreign = orderedTransport([
      JSON.stringify({
        data: {
          node: {
            id: "PRRC_foreign",
            viewerDidAuthor: true,
            pullRequest: {
              repository: {
                owner: { login: "octo-org" },
                name: "patchdesk",
              },
              number: 99,
            },
          },
        },
      }),
    ]);
    const adapter = testAdapter(foreign);
    await expect(
      adapter.getReviewCommentTarget({
        profile,
        pr,
        commentId: "PRRC_foreign",
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: false } });
    const notAuthor = orderedTransport([
      JSON.stringify({
        data: {
          node: {
            id: "PRRC_other",
            viewerDidAuthor: false,
            pullRequest: {
              repository: {
                owner: { login: "octo-org" },
                name: "patchdesk",
              },
              number: 42,
            },
          },
        },
      }),
    ]);
    const adapter2 = testAdapter(notAuthor);
    await expect(
      adapter2.getReviewCommentTarget({ profile, pr, commentId: "PRRC_other" }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { found: true, viewerDidAuthor: false },
    });
  });

  it("degrades the create receipt instead of failing when the thread read-back hard-fails, and does not retry", async () => {
    const transport = orderedTransport([
      JSON.stringify({ node_id: "PRRC_comment" }),
      { _tag: "CommandFailed" },
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.createInlineComment({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
        coordinates: { path: "src/a.ts", line: 5, side: "RIGHT" },
        body: "Body",
      }),
    ).resolves.toEqual({ _tag: "ok", value: { commentId: "PRRC_comment" } });
    // A transport/command error stops the read-back immediately: retrying
    // against a hard failure is a different problem than eventual
    // consistency, and the create must not be held hostage to it.
    expect(transport.requests).toHaveLength(2);
  });

  it("merges only through the explicit SHA-pinned GitHub endpoint", async () => {
    const [mergeArgv, mergePayload] = await Promise.all([
      golden("merge-pull-request"),
      payload("merge-pull-request.json"),
    ]);
    const transport = orderedTransport([
      JSON.stringify({ merged: true, sha: headSha }),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.mergePullRequest({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
        method: "squash",
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { mergeCommitSha: mustParse(parseGitSha(headSha)) },
    });
    expect(sentArgv(transport)).toEqual([mergeArgv]);
    expect(JSON.parse(sent(transport, 0).stdin ?? "{}")).toEqual(
      JSON.parse(mergePayload),
    );
  });
});

describe("GitHubAdapter pending-review gateway", () => {
  const account = "octo-dev";
  const reviewId = 9001;
  const reviewNodeId = "PRR_kwDORJzsQM7e6QwJ";
  const threadId = "PRRT_kwDORJzsQM0001";
  const commentId = "PRRC_kwDORJzsQM7fI2Rd";
  const reviewListUrl = `repos/octo-org/patchdesk/pulls/42/reviews?per_page=100&page=1`;

  function reviewsPayload(): string {
    return JSON.stringify([
      {
        id: reviewId,
        node_id: reviewNodeId,
        user: { login: account },
        body: "Summary body",
        state: "PENDING",
        commit_id: headSha,
      },
    ]);
  }

  /** One GraphQL review-thread node as GitHub reports it. */
  type ThreadNodeFixture = {
    readonly id: string;
    readonly isOutdated: boolean;
    readonly path: string;
    readonly line: number;
    readonly startLine: number;
    readonly diffSide: string;
    readonly startDiffSide?: string | undefined;
    readonly comments: {
      readonly nodes: ReadonlyArray<{
        readonly id: string;
        readonly body: string;
        readonly createdAt: string;
        readonly author: { readonly login: string };
        readonly pullRequestReview: {
          readonly id: string;
          readonly state: string;
        };
      }>;
      readonly pageInfo: {
        readonly hasNextPage: boolean;
        readonly endCursor: string | null;
      };
    };
  };

  function threadNode(
    overrides: Partial<ThreadNodeFixture> = {},
  ): ThreadNodeFixture {
    return {
      id: threadId,
      isOutdated: false,
      path: "src/review.ts",
      line: 7,
      startLine: 7,
      diffSide: "RIGHT",
      startDiffSide: "RIGHT",
      comments: {
        nodes: [
          {
            id: commentId,
            body: "Comment body",
            createdAt: "2026-08-09T11:34:50Z",
            author: { login: account },
            pullRequestReview: { id: reviewNodeId, state: "PENDING" },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      ...overrides,
    };
  }

  function threadsPayload(
    options: {
      readonly node?: ThreadNodeFixture;
      readonly pageInfo?: {
        readonly hasNextPage: boolean;
        readonly endCursor: string | null;
      };
    } = {},
  ): string {
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [options.node ?? threadNode()],
              pageInfo: options.pageInfo ?? {
                hasNextPage: false,
                endCursor: null,
              },
            },
          },
        },
      },
    });
  }

  it("returns None only for a complete result with no viewer pending review", async () => {
    const transport = orderedTransport([
      JSON.stringify([
        {
          id: 1,
          state: "COMMENTED",
          user: { login: "other" },
          submitted_at: "2026-08-08T00:00:00Z",
        },
      ]),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getViewerPendingReview({
        profile,
        pr,
        account: mustParse(parseGitHubLogin(account)),
      }),
    ).resolves.toEqual({ _tag: "ok", value: { _tag: "None" } });
    expect(sent(transport, 0).argv).toContain(reviewListUrl);
  });

  it("imports the viewer's pending review with complete bounded thread/comment identity", async () => {
    const transport = orderedTransport([reviewsPayload(), threadsPayload()]);
    const adapter = testAdapter(transport);
    const result = await adapter.getViewerPendingReview({
      profile,
      pr,
      account: mustParse(parseGitHubLogin(account)),
    });
    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value).toMatchObject({
      _tag: "Pending",
      review: {
        restId: "9001",
        nodeId: reviewNodeId,
        author: account,
        headSha,
        comments: [
          { reviewCommentId: commentId, threadId, body: "Comment body" },
        ],
      },
    });
    // The GraphQL probe selects the owning review so the adapter can prove
    // which threads belong to the PENDING review.
    expect(sent(transport, 1).argv.join(" ")).toContain(
      "pullRequestReview { id state }",
    );
  });

  it("normalizes GitHub's inverted LEFT single-line range", async () => {
    const threads = threadsPayload({
      node: threadNode({
        startLine: 8,
        diffSide: "LEFT",
        startDiffSide: undefined,
      }),
    });
    const transport = orderedTransport([reviewsPayload(), threads]);
    const adapter = testAdapter(transport);
    const result = await adapter.getViewerPendingReview({
      profile,
      pr,
      account: mustParse(parseGitHubLogin(account)),
    });
    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value._tag).toBe("Pending");
    if (result.value._tag !== "Pending") return;
    expect(result.value.review.comments[0]?.anchor).toEqual({
      path: "src/review.ts",
      startLine: 7,
      line: 7,
      side: "old",
    });
  });

  it("treats foreign-author and non-pending threads as non-actionable", async () => {
    const threads = threadsPayload({
      node: threadNode({
        startDiffSide: undefined,
        comments: {
          nodes: [
            {
              id: commentId,
              body: "Comment body",
              createdAt: "2026-08-09T11:34:50Z",
              author: { login: "other" },
              pullRequestReview: { id: reviewNodeId, state: "PENDING" },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    });
    const transport = orderedTransport([reviewsPayload(), threads]);
    const adapter = testAdapter(transport);
    // No actionable comments: an empty pending review is the unproven case.
    await expect(
      adapter.getViewerPendingReview({
        profile,
        pr,
        account: mustParse(parseGitHubLogin(account)),
      }),
    ).resolves.toMatchObject({ _tag: "err" });
  });

  it("fails closed on pagination, incomplete threads, and malformed data", async () => {
    const fullReviews = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      state: "COMMENTED",
      user: { login: "other" },
      submitted_at: "2026-08-08T00:00:00Z",
    }));
    const paginated = testAdapter(
      orderedTransport([JSON.stringify(fullReviews)]),
    );
    await expect(
      paginated.getViewerPendingReview({
        profile,
        pr,
        account: mustParse(parseGitHubLogin(account)),
      }),
    ).resolves.toMatchObject({ _tag: "err" });

    const threads = threadsPayload({
      pageInfo: { hasNextPage: true, endCursor: "cursor" },
    });
    const incompleteThreads = testAdapter(
      orderedTransport([reviewsPayload(), threads]),
    );
    await expect(
      incompleteThreads.getViewerPendingReview({
        profile,
        pr,
        account: mustParse(parseGitHubLogin(account)),
      }),
    ).resolves.toMatchObject({ _tag: "err" });

    const malformed = testAdapter(
      orderedTransport(["{not-json", threadsPayload()]),
    );
    await expect(
      malformed.getViewerPendingReview({
        profile,
        pr,
        account: mustParse(parseGitHubLogin(account)),
      }),
    ).resolves.toMatchObject({ _tag: "err" });
  });

  it("starts a review with its first thread and reads the full owner back", async () => {
    const transport = orderedTransport([
      // GitHub's live create-review response does not include the created
      // inline comment. Exact thread identity must come from read-back.
      JSON.stringify({
        id: reviewId,
        node_id: reviewNodeId,
        state: "PENDING",
        commit_id: headSha,
      }),
      reviewsPayload(),
      threadsPayload(),
    ]);
    const adapter = testAdapter(transport);
    const result = await adapter.startPendingReviewWithThread({
      profile,
      pr,
      headSha: mustParse(parseGitSha(headSha)),
      anchor: {
        path: mustParse(parseRepoRelativePath("src/review.ts")),
        startLine: 7,
        line: 7,
        side: "new",
      },
      body: "Comment body",
    });
    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value.review.restId).toBe("9001");
    expect(result.value.createdThreadId).toBe(threadId);
    // REST Start owns the inline comment; Finish owns general feedback.
    expect(JSON.parse(sent(transport, 0).stdin ?? "{}")).toEqual({
      commit_id: headSha,
      comments: [
        { path: "src/review.ts", line: 7, side: "RIGHT", body: "Comment body" },
      ],
    });
    expect(JSON.parse(sent(transport, 0).stdin ?? "{}")).not.toHaveProperty(
      "body",
    );
  });

  it("never fabricates a pending owner when the create read-back cannot be proven", async () => {
    const missingRead = testAdapter(
      orderedTransport([
        JSON.stringify({
          id: reviewId,
          node_id: reviewNodeId,
          state: "PENDING",
          commit_id: headSha,
          comments: [{ node_id: commentId }],
        }),
        "[]",
      ]),
    );
    const result = await missingRead.startPendingReviewWithThread({
      profile,
      pr,
      headSha: mustParse(parseGitSha(headSha)),
      anchor: {
        path: mustParse(parseRepoRelativePath("src/review.ts")),
        startLine: 7,
        line: 7,
        side: "new",
      },
      body: "Comment body",
    });
    expect(result).toMatchObject({
      _tag: "err",
      error: { category: "unavailable" },
    });
  });

  it("appends a thread through the spike-proven GraphQL mutation and reads back", async () => {
    const transport = orderedTransport([
      JSON.stringify({
        data: {
          addPullRequestReviewThread: {
            thread: {
              id: threadId,
              path: "src/review.ts",
              line: 9,
              startLine: 9,
              diffSide: "RIGHT",
              comments: {
                nodes: [{ id: "PRRC_kwDORJzsQM7fI2Xp", body: "More" }],
              },
            },
          },
        },
      }),
      reviewsPayload(),
      threadsPayload(),
    ]);
    const adapter = testAdapter(transport);
    const result = await adapter.addPendingReviewThread({
      profile,
      pr,
      reviewId: mustParse(parseGitHubReviewNodeId(reviewNodeId)),
      anchor: {
        path: mustParse(parseRepoRelativePath("src/review.ts")),
        startLine: 9,
        line: 9,
        side: "new",
      },
      body: "More",
    });
    expect(result._tag).toBe("ok");
    const request = sent(transport, 0).argv.join(" ");
    expect(request).toContain("addPullRequestReviewThread");
    expect(request).toContain("pullRequestReviewId:$reviewId");
  });

  it("keeps pageInfo inside the comments connection in the AddThread selection", async () => {
    // PullRequestReviewThread has no pageInfo field; the old
    // `comments(first:100){nodes{id body}} pageInfo{hasNextPage}` shape made
    // GitHub reject the mutation at schema validation (409 github_rejected)
    // before any execution. The query must nest pageInfo under comments.
    const transport = orderedTransport([
      JSON.stringify({
        data: {
          addPullRequestReviewThread: {
            thread: {
              id: threadId,
              path: "src/review.ts",
              line: 9,
              startLine: 9,
              diffSide: "RIGHT",
              comments: {
                nodes: [{ id: "PRRC_kwDORJzsQM7fI2Xp", body: "More" }],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      }),
      reviewsPayload(),
      threadsPayload(),
    ]);
    const adapter = testAdapter(transport);
    const result = await adapter.addPendingReviewThread({
      profile,
      pr,
      reviewId: mustParse(parseGitHubReviewNodeId(reviewNodeId)),
      anchor: {
        path: mustParse(parseRepoRelativePath("src/review.ts")),
        startLine: 9,
        line: 9,
        side: "new",
      },
      body: "More",
    });
    expect(result._tag).toBe("ok");
    const request = sent(transport, 0).argv.join(" ");
    expect(request).toContain(
      "comments(first:100){nodes{id body} pageInfo{hasNextPage}}",
    );
    expect(request).not.toMatch(/nodes\{id body\}\} pageInfo/);
    expect(request).toContain("diffSide");
  });

  it("rejects an append whose mutation response lacks thread identity", async () => {
    const adapter = testAdapter(
      orderedTransport([
        JSON.stringify({
          data: {
            addPullRequestReviewThread: {
              thread: { id: "PRRT_ok", comments: { nodes: [] } },
            },
          },
        }),
      ]),
    );
    const result = await adapter.addPendingReviewThread({
      profile,
      pr,
      reviewId: mustParse(parseGitHubReviewNodeId(reviewNodeId)),
      anchor: {
        path: mustParse(parseRepoRelativePath("src/review.ts")),
        startLine: 9,
        line: 9,
        side: "new",
      },
      body: "More",
    });
    expect(result).toMatchObject({
      _tag: "err",
      error: { category: "unavailable" },
    });
  });

  it("isolates the viewer's pending review from a foreign account", async () => {
    const transport = orderedTransport([reviewsPayload()]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getViewerPendingReview({
        profile,
        pr,
        account: mustParse(parseGitHubLogin("other")),
      }),
    ).resolves.toEqual({ _tag: "ok", value: { _tag: "None" } });
  });
});

describe("GitHubAdapter pending-review discard", () => {
  it("deletes the pending review through the dbacd62-proven REST endpoint and accepts the empty 204 body", async () => {
    const transport = orderedTransport([""]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.discardPendingReview({
        profile,
        pr,
        reviewId: mustParse(parseGitHubReviewRestId("9001")),
      }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
    expect(sent(transport, 0).argv).toEqual([
      "gh",
      "api",
      "--hostname",
      "github.com",
      "--method",
      "DELETE",
      "repos/octo-org/patchdesk/pulls/42/reviews/9001",
    ]);
  });

  it("classifies a not-found discard as unavailable (conservative, never a confirmed absence)", async () => {
    const transport = orderedTransport([{ _tag: "CommandNotFound" }]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.discardPendingReview({
        profile,
        pr,
        reviewId: mustParse(parseGitHubReviewRestId("9001")),
      }),
    ).resolves.toMatchObject({
      _tag: "err",
      error: { _tag: "GitHubWriteFailure", category: "unavailable" },
    });
  });

  it("classifies a forbidden discard as forbidden with its specific reason, not the generic unavailable category", async () => {
    const transport = orderedTransport([
      { _tag: "CommandForbidden", reason: "unknown" },
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.discardPendingReview({
        profile,
        pr,
        reviewId: mustParse(parseGitHubReviewRestId("9001")),
      }),
    ).resolves.toMatchObject({
      _tag: "err",
      error: {
        _tag: "GitHubWriteFailure",
        category: "forbidden",
        reason: "unknown",
      },
    });
  });

  it("keeps the fake discard seam unimplemented until a fixture is supplied", async () => {
    const adapter = new FakeGitHubAdapter({
      authenticatedAccount: { host: "github.com", account: "octo-dev" },
    });
    await expect(
      adapter.discardPendingReview({
        profile,
        pr,
        reviewId: mustParse(parseGitHubReviewRestId("9001")),
      }),
    ).resolves.toMatchObject({
      _tag: "err",
      error: { category: "unavailable" },
    });
  });
});

describe("GitHubAdapter direct summary reads", () => {
  it("ignores dismissed reviews while retaining submitted direct summaries", async () => {
    const adapter = testAdapter(
      orderedTransport([
        JSON.stringify([
          {
            id: 100,
            user: { login: "octo-dev" },
            state: "DISMISSED",
            commit_id: headSha,
            submitted_at: "2026-08-01T00:00:00Z",
            body: "Dismissed",
          },
          {
            id: 101,
            user: { login: "octo-dev" },
            state: "COMMENTED",
            commit_id: headSha,
            submitted_at: "2026-08-01T00:01:00Z",
            body: "Summary",
          },
        ]),
      ]),
    );

    await expect(
      adapter.getViewerDirectSummaryReviews({
        profile,
        pr,
        account: mustParse(parseGitHubLogin("octo-dev")),
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        complete: true,
        reviews: [{ reviewId: "101", event: "COMMENT", headSha }],
      },
    });
  });
});

describe("GitHubAdapter workspace-profile GitHub account", () => {
  const enterpriseProfile = mustParse(
    parseWorkspaceProfileConfig({
      id: "opn",
      label: "OPN",
      githubHost: "github.opn.example",
      ghAccount: "matthew-opn",
      workspaceRoots: [],
      rulePaths: [],
      repos: [],
    }),
  );

  /** One canned HTTP answer, as the account's credential earned it. */
  type ServedAnswer = { readonly status: number; readonly body: string };

  /**
   * The adapter as production composes it: one `GitHubCliCredentials` shared
   * with the HTTP client, so the profile's own `gh auth token` child is what
   * authenticates every call (ADR 0046). The `Authorization` header each call
   * carried is recorded, because that is where the account now reaches GitHub.
   */
  function servedAdapter(
    executor: CommandExecutor,
    answers: ReadonlyArray<ServedAnswer>,
  ) {
    const authorizations: Array<string | null> = [];
    const commands = new CommandRunner(executor);
    const credentials = new GitHubCliCredentials(commands);
    const http = new GitHubHttpClient(
      credentials,
      undefined,
      undefined,
      async (_url, init) => {
        authorizations.push(new Headers(init.headers).get("authorization"));
        const answer = answers[authorizations.length - 1];
        if (answer === undefined) throw new Error("Missing fake GitHub answer");
        return new Response(answer.body, {
          status: answer.status,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    return {
      adapter: new GitHubAdapter(commands, credentials, http),
      authorizations,
    };
  }

  function exited(stdout: string): CommandExecution {
    return { _tag: "Exited", exitCode: 0, stdout, stderr: "" };
  }

  const servedPullRequest: ServedAnswer = {
    status: 200,
    body: JSON.stringify(pullRequestPayload()),
  };

  it("authenticates gh as the profile's account, not the machine-wide active account", async () => {
    const executor = new FakeProcessExecutor([exited("profile-token\n")]);
    const served = servedAdapter(executor, [servedPullRequest]);

    await expect(
      served.adapter.getPullRequest({ profile, pr }),
    ).resolves.toMatchObject({ _tag: "ok" });

    expect(executor.requests).toEqual([
      ["gh", "auth", "token", "--hostname", "github.com", "--user", "octo-dev"],
    ]);
    expect(served.authorizations).toEqual(["Bearer profile-token"]);
  });

  it("reads an Enterprise Server host's credential under that host's own account", async () => {
    const executor = new FakeProcessExecutor([exited("enterprise-token\n")]);
    const served = servedAdapter(executor, [servedPullRequest]);

    await served.adapter.getPullRequest({ profile: enterpriseProfile, pr });

    expect(executor.requests[0]).toEqual([
      "gh",
      "auth",
      "token",
      "--hostname",
      "github.opn.example",
      "--user",
      "matthew-opn",
    ]);
    expect(served.authorizations).toEqual(["Bearer enterprise-token"]);
  });

  it("reports authentication failure without dispatching the call when the account has no stored credential", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr: "no oauth token found for github.com account octo-dev",
      },
    ]);
    const served = servedAdapter(executor, []);

    await expect(
      served.adapter.getPullRequest({ profile, pr }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "GitHubAuthenticationFailed", operation: "get_pr" },
    });
    expect(executor.requests).toHaveLength(1);
    expect(served.authorizations).toEqual([]);
  });

  it("reuses a resolved token and re-reads it after GitHub rejects the credential", async () => {
    const executor = new FakeProcessExecutor([
      exited("token-1\n"),
      exited("token-2\n"),
    ]);
    const served = servedAdapter(executor, [
      servedPullRequest,
      { status: 401, body: JSON.stringify({ message: "Bad credentials" }) },
      servedPullRequest,
    ]);

    await served.adapter.getPullRequest({ profile, pr });
    await served.adapter.getPullRequest({ profile, pr });
    await served.adapter.getPullRequest({ profile, pr });

    expect(executor.requests.map((request) => request.slice(0, 3))).toEqual([
      ["gh", "auth", "token"],
      ["gh", "auth", "token"],
    ]);
    expect(served.authorizations).toEqual([
      "Bearer token-1",
      "Bearer token-1",
      "Bearer token-2",
    ]);
  });

  it("resolves the authenticated account against the profile's own credential", async () => {
    const executor = new FakeProcessExecutor([exited("profile-token\n")]);
    const served = servedAdapter(executor, [
      { status: 200, body: '{"login":"octo-dev"}' },
    ]);

    await expect(
      served.adapter.resolveAuthenticatedAccount(profile),
    ).resolves.toEqual({
      _tag: "ok",
      value: { host: "github.com", account: "octo-dev" },
    });
    expect(served.authorizations).toEqual(["Bearer profile-token"]);
  });
});
