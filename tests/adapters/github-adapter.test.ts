import { readFile } from "node:fs/promises";
import { join } from "node:path";

import * as v from "valibot";
import { describe, expect, it } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
  type CommandFailure,
} from "../../src/adapters/github/command-runner";
import {
  createFetchedDiffRefs,
  FakeGitHubAdapter,
  GitHubAdapter,
} from "../../src/adapters/github/github-adapter";
import {
  GitHubCliCredentials,
  type GitHubCredentials,
} from "../../src/adapters/github/github-credentials";
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
import { ok, type Result } from "../../src/domain/result";
import {
  parseWorkspaceProfileConfig,
  type WorkspaceProfileConfig,
} from "../../src/domain/workspace-profile";

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
    id: "cfw",
    label: "CFW",
    githubHost: "github.com",
    ghAccount: "pmquan2cfw",
    ownerFilters: ["centraldigital"],
    workspaceRoots: [],
    rulePaths: [],
    repos: [],
  }),
);

const pr: PullRequestRef = {
  host: mustParse(parseGitHubHost("github.com")),
  owner: mustParse(parseGitHubOwner("centraldigital")),
  repo: mustParse(parseGitHubRepoName("patchdesk")),
  number: mustParse(parsePullRequestNumber(42)),
};

class FakeProcessExecutor implements CommandExecutor {
  readonly requests: Array<ReadonlyArray<string>> = [];
  readonly stdin: Array<string | undefined> = [];
  readonly environments: Array<Readonly<Record<string, string>> | undefined> =
    [];

  constructor(private readonly responses: ReadonlyArray<CommandExecution>) {}

  async execute(input: {
    readonly argv: ReadonlyArray<string>;
    readonly timeoutMs: number;
    readonly stdin?: string;
    readonly environment?: Readonly<Record<string, string>>;
  }): Promise<CommandExecution> {
    this.requests.push(input.argv);
    this.stdin.push(input.stdin);
    this.environments.push(input.environment);
    const response = this.responses[this.requests.length - 1];
    if (response === undefined)
      throw new Error("Missing fake command response");
    return response;
  }
}

/** Resolves a fixed credential so command expectations stay about gh argv. */
class StubCredentials implements GitHubCredentials {
  readonly forgotten: Array<string> = [];

  async environmentFor(): Promise<
    Result<Readonly<Record<string, string>>, CommandFailure>
  > {
    return ok({ GH_TOKEN: "profile-token" });
  }

  forget(profile: WorkspaceProfileConfig): void {
    this.forgotten.push(profile.ghAccount);
  }
}

function testAdapter(
  commands: CommandRunner,
  credentials: GitHubCredentials = new StubCredentials(),
): GitHubAdapter {
  return new GitHubAdapter(commands, credentials);
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
  readonly labels?: ReadonlyArray<{ readonly name: string }>;
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
    labels: [{ name: "review" }],
    requested_reviewers: [{ login: "pmquan2cfw" }],
    assignees: [{ login: "pmquan2cfw" }],
    additions: 12,
    deletions: 3,
    changed_files: 2,
    ...overrides,
  };
}

describe("CommandRunner", () => {
  it("classifies the one-pending-review rejection distinctly from generic 422s", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr:
          "HTTP 422: Validation Failed - user_id can only have one pending review per pull request",
      },
    ]);
    const runner = new CommandRunner(executor);
    await expect(
      runner.runJson({ argv: ["gh", "api", "x"], timeoutMs: 2_500 }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "CommandPendingReview" },
    });
  });

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

    const result = await runner.runJson({
      argv: ["gh", "api", "user"],
      timeoutMs: 2_500,
    });

    expect(result).toEqual({ _tag: "ok", value: { status: "ok" } });
    expect(executor.requests).toEqual([["gh", "api", "user"]]);
  });

  it("classifies timeout, invalid JSON, and authentication without command output", async () => {
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

    expect(
      await timeout.runJson({ argv: ["gh", "api", "user"], timeoutMs: 5 }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "CommandTimedOut" },
    });
    expect(
      await invalidJson.runJson({ argv: ["gh", "api", "user"], timeoutMs: 5 }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "CommandInvalidJson" },
    });

    describe("GitHubAdapter direct summary writes", () => {
      it("fails closed when gh exits generically after the request may have dispatched", async () => {
        const adapter = testAdapter(
          new CommandRunner(
            new FakeProcessExecutor([
              {
                _tag: "Exited",
                exitCode: 1,
                stdout: "",
                stderr: "HTTP 502: Bad Gateway",
              },
            ]),
          ),
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
    expect(
      await auth.runJson({ argv: ["gh", "api", "user"], timeoutMs: 5 }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "CommandAuthenticationRequired" },
    });
  });
});

describe("GitHubAdapter merge outcome", () => {
  it("reads merged, open, and closed-unmerged outcomes without a write command", async () => {
    const adapter = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify({
              state: "closed",
              merged_at: "2026-08-01T00:00:00Z",
              merge_commit_sha: headSha,
            }),
            stderr: "",
          },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify({ state: "open" }),
            stderr: "",
          },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify({ state: "closed", merged_at: null }),
            stderr: "",
          },
        ]),
      ),
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

describe("GitHubAdapter merge policy", () => {
  it("joins the exact-head rollup to required branch contexts", async () => {
    const adapter = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify(mergePolicyPayload()),
            stderr: "",
          },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify({ contexts: ["unit"], checks: [] }),
            stderr: "",
          },
        ]),
      ),
    );

    await expect(
      adapter.getMergePolicy({
        profile,
        pr,
        expectedHeadSha: mustParse(parseGitSha(headSha)),
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: expect.objectContaining({
        headSha,
        complete: true,
        reviewDecision: "approved",
        checks: {
          overall: "passing",
          checks: [
            expect.objectContaining({
              name: "unit",
              required: true,
              conclusion: "success",
            }),
          ],
        },
      }),
    });
  });

  it("parses detailed merge-state statuses and preserves unavailable versus unknown", async () => {
    const statuses = [
      ["BLOCKED", "blocked"],
      ["BEHIND", "behind"],
      ["DIRTY", "dirty"],
      ["DRAFT", "draft"],
      ["HAS_HOOKS", "has_hooks"],
      ["UNSTABLE", "unstable"],
      ["CLEAN", "clean"],
      ["FUTURE_STATUS", "unknown"],
    ] as const;
    for (const [raw, expected] of statuses) {
      const adapter = testAdapter(
        new CommandRunner(
          new FakeProcessExecutor([
            {
              _tag: "Exited",
              exitCode: 0,
              stdout: JSON.stringify(
                mergePolicyPayload({ mergeStateStatus: raw }),
              ),
              stderr: "",
            },
            {
              _tag: "Exited",
              exitCode: 0,
              stdout: JSON.stringify({ contexts: [], checks: [] }),
              stderr: "",
            },
          ]),
        ),
      );
      await expect(
        adapter.getMergePolicy({
          profile,
          pr,
          expectedHeadSha: mustParse(parseGitSha(headSha)),
        }),
      ).resolves.toMatchObject({
        _tag: "ok",
        value: { mergeStateStatus: expected },
      });
    }
    const missing = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify(
              mergePolicyPayload({ mergeStateStatus: undefined }),
            ),
            stderr: "",
          },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify({ contexts: [], checks: [] }),
            stderr: "",
          },
        ]),
      ),
    );
    await expect(
      missing.getMergePolicy({
        profile,
        pr,
        expectedHeadSha: mustParse(parseGitSha(headSha)),
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { mergeStateStatus: "unavailable" },
    });
  });

  it("fails closed for a head mismatch, policy pagination cap, or branch-protection denial", async () => {
    const headMismatch = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify(mergePolicyPayload({ headRefOid: baseSha })),
            stderr: "",
          },
        ]),
      ),
    );
    await expect(
      headMismatch.getMergePolicy({
        profile,
        pr,
        expectedHeadSha: mustParse(parseGitSha(headSha)),
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { complete: false, incompleteReason: "head_mismatch" },
    });

    const pages = [0, 1, 2].map((index) => ({
      _tag: "Exited" as const,
      exitCode: 0,
      stdout: JSON.stringify(
        mergePolicyPayload({
          pageInfo: { hasNextPage: true, endCursor: `cursor-${index}` },
        }),
      ),
      stderr: "",
    }));
    const pagination = testAdapter(
      new CommandRunner(new FakeProcessExecutor(pages)),
    );
    await expect(
      pagination.getMergePolicy({
        profile,
        pr,
        expectedHeadSha: mustParse(parseGitSha(headSha)),
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { complete: false, incompleteReason: "pagination" },
    });

    const denied = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify(mergePolicyPayload()),
            stderr: "",
          },
          {
            _tag: "Exited",
            exitCode: 1,
            stdout: "",
            stderr: "HTTP 403: Resource not accessible",
          },
        ]),
      ),
    );
    await expect(
      denied.getMergePolicy({
        profile,
        pr,
        expectedHeadSha: mustParse(parseGitSha(headSha)),
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { complete: false, incompleteReason: "permission" },
    });
  });
});

function mergePolicyPayload(
  overrides: {
    readonly headRefOid?: string;
    readonly mergeStateStatus?: string | undefined;
    readonly pageInfo?: {
      readonly hasNextPage: boolean;
      readonly endCursor: string | null;
    };
  } = {},
) {
  // An undefined mergeStateStatus is dropped by JSON.stringify, which is how
  // GitHub reports the field being absent.
  return {
    data: {
      repository: {
        pullRequest: {
          state: "OPEN",
          isDraft: false,
          headRefOid: overrides.headRefOid ?? headSha,
          baseRefOid: baseSha,
          baseRefName: "sit",
          mergeable: "MERGEABLE",
          mergeStateStatus: overrides.mergeStateStatus,
          reviewDecision: "APPROVED",
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: "CheckRun",
                          name: "unit",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                          detailsUrl: "https://example.test/unit",
                        },
                      ],
                      pageInfo: overrides.pageInfo ?? {
                        hasNextPage: false,
                        endCursor: null,
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  };
}

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
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify(branchProtection),
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify(rules),
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
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
    expect(executor.requests).toEqual([
      [
        "gh",
        "api",
        "--hostname",
        "github.com",
        "repos/centraldigital/patchdesk/branches/sit/protection",
      ],
      [
        "gh",
        "api",
        "--hostname",
        "github.com",
        "repos/centraldigital/patchdesk/rules/branches/sit",
      ],
    ]);
  });

  it("treats a zero approval count as unavailable policy evidence", async () => {
    const adapter = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify({
              required_pull_request_reviews: {
                required_approving_review_count: 0,
                dismiss_stale_reviews: false,
                require_code_owner_reviews: false,
              },
            }),
            stderr: "",
          },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify([]),
            stderr: "",
          },
        ]),
      ),
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
    ["403", "forbidden"],
    ["404", "not_found"],
    ["405", "unsupported"],
  ] as const)(
    "maps an optional endpoint HTTP %s response to unavailable evidence",
    async (status, reason) => {
      const adapter = testAdapter(
        new CommandRunner(
          new FakeProcessExecutor([
            {
              _tag: "Exited",
              exitCode: 1,
              stdout: "",
              stderr: `HTTP ${status}: endpoint unavailable`,
            },
            {
              _tag: "Exited",
              exitCode: 0,
              stdout: JSON.stringify(rules),
              stderr: "",
            },
          ]),
        ),
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
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify({
              required_pull_request_reviews: {
                required_approving_review_count: "two",
              },
            }),
            stderr: "",
          },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify(rules),
            stderr: "",
          },
        ]),
      ),
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
      new CommandRunner(
        new FakeProcessExecutor([
          { _tag: "TimedOut", stdout: "", stderr: "" },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify(rules),
            stderr: "",
          },
        ]),
      ),
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
});

describe("GitHubAdapter Published feedback capabilities", () => {
  it("requires authenticated owner and repository/branch evidence", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify([
          {
            id: 7,
            user: { login: "pmquan2cfw" },
            body: "ok",
            state: "APPROVED",
            submitted_at: "2026-08-01T00:00:00Z",
          },
        ]),
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify([
          {
            id: 8,
            user: { login: "pmquan2cfw" },
            body: "comment",
            created_at: "2026-08-01T00:00:00Z",
          },
        ]),
        stderr: "",
      },
      { _tag: "Exited", exitCode: 0, stdout: "pmquan2cfw\n", stderr: "" },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({ permission: "push" }),
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify(pullRequestPayload()),
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({ required_pull_request_reviews: null }),
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
    const result = await adapter.getPullRequestPublishedFeedback({
      profile,
      pr,
    });
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        comments: [{ id: "8", canEdit: true, canDelete: true }],
        reviews: [{ id: "7", canDismiss: true }],
      },
    });
  });

  it("projects dismissal capability when GitHub reports an unprotected base branch as 404", async () => {
    const adapter = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify([
              {
                id: 7,
                user: { login: "pmquan2cfw" },
                body: "ok",
                state: "APPROVED",
                submitted_at: "2026-08-01T00:00:00Z",
              },
            ]),
            stderr: "",
          },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify([]),
            stderr: "",
          },
          { _tag: "Exited", exitCode: 0, stdout: "pmquan2cfw\n", stderr: "" },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify({ permission: "push" }),
            stderr: "",
          },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify(pullRequestPayload()),
            stderr: "",
          },
          {
            _tag: "Exited",
            exitCode: 1,
            stdout: "",
            stderr: "HTTP 404: Branch not protected",
          },
        ]),
      ),
    );
    await expect(
      adapter.getPullRequestPublishedFeedback({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { reviews: [{ id: "7", canDismiss: true }] },
    });
  });

  it("fails closed when permission evidence is malformed while retaining records", async () => {
    const adapter = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify([]),
            stderr: "",
          },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify([
              {
                id: 8,
                user: { login: "pmquan2cfw" },
                body: "comment",
                created_at: "2026-08-01T00:00:00Z",
              },
            ]),
            stderr: "",
          },
          { _tag: "Exited", exitCode: 0, stdout: "pmquan2cfw\n", stderr: "" },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify({ permission: "owner" }),
            stderr: "",
          },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify(pullRequestPayload()),
            stderr: "",
          },
        ]),
      ),
    );
    const result = await adapter.getPullRequestPublishedFeedback({
      profile,
      pr,
    });
    expect(result).toMatchObject({
      _tag: "ok",
      value: { comments: [{ id: "8", canEdit: false, canDelete: false }] },
    });
  });

  it("skips PENDING reviews that GitHub omits submitted_at for instead of failing the read", async () => {
    // A started-but-unsubmitted review has no submitted_at key at all; the
    // feedback read must tolerate it (and later detect/refresh passes) rather
    // than reporting GitHubResponseInvalid.
    const adapter = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify([
              {
                id: 6,
                user: { login: "pmquan2cfw" },
                body: "",
                state: "PENDING",
              },
              {
                id: 7,
                user: { login: "pmquan2cfw" },
                body: "ok",
                state: "APPROVED",
                submitted_at: "2026-08-01T00:00:00Z",
              },
            ]),
            stderr: "",
          },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify([]),
            stderr: "",
          },
          { _tag: "Exited", exitCode: 0, stdout: "pmquan2cfw\n", stderr: "" },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify({ permission: "push" }),
            stderr: "",
          },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify(pullRequestPayload()),
            stderr: "",
          },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify({ required_pull_request_reviews: null }),
            stderr: "",
          },
        ]),
      ),
    );
    await expect(
      adapter.getPullRequestPublishedFeedback({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { reviews: [{ id: "7", canDismiss: true }] },
    });
  });
});

describe("GitHubAdapter read boundary", () => {
  it("returns parsed GraphQL inbox rows and marks a capped listing incomplete", async () => {
    const page = (hasNextPage: boolean, endCursor: string | null) => ({
      data: {
        repository: {
          pullRequests: {
            nodes: [
              {
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
                reviewRequests: {
                  nodes: [{ requestedReviewer: { login: "pmquan2cfw" } }],
                },
                assignees: { nodes: [] },
                commits: {
                  nodes: [
                    { commit: { statusCheckRollup: { state: "SUCCESS" } } },
                  ],
                },
              },
            ],
            pageInfo: { hasNextPage, endCursor },
          },
        },
      },
    });
    const executor = new FakeProcessExecutor(
      [0, 1, 2].map((index) => ({
        _tag: "Exited" as const,
        exitCode: 0,
        stdout: JSON.stringify(page(true, `cursor-${index}`)),
        stderr: "",
      })),
    );
    const adapter = testAdapter(new CommandRunner(executor));

    const result = await adapter.listMaintainerPullRequests({
      profile,
      repo: pr,
    });

    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        complete: false,
        pullRequests: expect.arrayContaining([
          expect.objectContaining({
            summary: expect.objectContaining({
              reviewState: "review_pending",
              mergeability: "mergeable",
            }),
            checks: { overall: "passing", checks: [] },
          }),
        ]),
      },
    });
    if (result._tag === "ok") expect(result.value.pullRequests).toHaveLength(3);
    expect(executor.requests).toHaveLength(3);
    expect(executor.requests[1]).toContain("cursor=cursor-0");
    expect(
      executor.requests[0]?.some((argument) =>
        argument.includes("reviewRequests(first: 50)"),
      ),
    ).toBe(true);
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
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: listOpenPrs,
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: getPr,
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: getComments,
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: getChecks,
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: getStatuses,
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: getDiff,
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: "pmquan2cfw\n",
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));

    expect(
      await adapter.listOpenPullRequests({ profile, repo: pr }),
    ).toMatchObject({
      _tag: "ok",
      value: [
        {
          title: "Add safe GitHub reads",
          changedFileCount: 2,
          requestedReviewers: ["pmquan2cfw"],
          assignees: ["pmquan2cfw"],
        },
      ],
    });
    expect(await adapter.getPullRequest({ profile, pr })).toMatchObject({
      _tag: "ok",
      value: { headSha, baseBranch: "sit", author: "reviewer" },
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
    expect(await adapter.getPullRequestDiff({ profile, pr })).toEqual({
      _tag: "ok",
      value: getDiff,
    });
    expect(await adapter.resolveAuthenticatedAccount(profile)).toEqual({
      _tag: "ok",
      value: { host: "github.com", account: "pmquan2cfw" },
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
    ).resolves.toEqual(executor.requests);
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
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify(fixture),
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
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
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify(first),
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify(second),
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));

    await expect(
      adapter.getPullRequestComments({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        complete: true,
        threads: [{ id: "thread-1" }, { id: "thread-2" }],
      },
    });
    expect(executor.requests[1]).toContain("cursor=threads-page-2");
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
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify(first),
            stderr: "",
          },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify(second),
            stderr: "",
          },
        ]),
      ),
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
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify(outer),
            stderr: "",
          },
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify(replies),
            stderr: "",
          },
        ]),
      ),
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
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify(outer),
            stderr: "",
          },
          {
            _tag: "Exited",
            exitCode: 1,
            stdout: "",
            stderr: "network unavailable",
          },
        ]),
      ),
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
      return {
        _tag: "Exited" as const,
        exitCode: 0,
        stdout: JSON.stringify(page),
        stderr: "",
      };
    });
    const adapter = testAdapter(
      new CommandRunner(new FakeProcessExecutor(responses)),
    );

    await expect(
      adapter.getPullRequestComments({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { complete: false, incompleteReason: "thread_cap" },
    });
  });

  it("returns a degraded summary when optional GitHub metadata is absent", async () => {
    const adapter = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify([
              pullRequestPayload({
                labels: [],
                additions: undefined,
                deletions: undefined,
                changed_files: undefined,
                mergeable_state: undefined,
              }),
            ]),
            stderr: "",
          },
        ]),
      ),
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

  it("does not execute a git diff fallback without fetched-ref evidence", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr: "pull request diff unavailable",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));

    expect(await adapter.getPullRequestDiff({ profile, pr })).toEqual({
      _tag: "err",
      error: { _tag: "GitHubReadFailed", operation: "get_diff" },
    });
    expect(executor.requests).toEqual([await golden("get-diff")]);
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
    const adapter = testAdapter(new CommandRunner(executor));

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
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: "diff --git a/exact.ts b/exact.ts\n",
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));

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
    expect(executor.requests).toEqual([
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
    const adapter = testAdapter(new CommandRunner(executor));

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
    const adapter = testAdapter(new CommandRunner(executor));

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

  it("classifies a successful status for a different gh account as github_auth", async () => {
    const adapter = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout:
              "github.com\n  ✓ Logged in to github.com account another-user (keyring)\n",
            stderr: "",
          },
        ]),
      ),
    );

    expect(await adapter.resolveAuthenticatedAccount(profile)).toEqual({
      _tag: "err",
      error: { _tag: "GitHubAuthenticationFailed", operation: "auth_status" },
    });
  });

  it("classifies a configured account that is listed but inactive as github_auth", async () => {
    const adapter = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout:
              "github.com\n  ✓ Logged in to github.com account pmquan2cfw (keyring)\n  - Active account: false\n  ✓ Logged in to github.com account another-user (keyring)\n  - Active account: true\n",
            stderr: "",
          },
        ]),
      ),
    );

    expect(await adapter.resolveAuthenticatedAccount(profile)).toEqual({
      _tag: "err",
      error: { _tag: "GitHubAuthenticationFailed", operation: "auth_status" },
    });
  });

  it("classifies malformed valid JSON GitHub responses without exposing payloads", async () => {
    const adapter = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: await payload("malformed-get-pr.json"),
            stderr: "",
          },
        ]),
      ),
    );

    expect(await adapter.getPullRequest({ profile, pr })).toEqual({
      _tag: "err",
      error: { _tag: "GitHubResponseInvalid", operation: "get_pr" },
    });
  });

  it("maps missing local GitHub auth to github_auth", async () => {
    const adapter = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 1,
            stdout: "",
            stderr: "not logged into any GitHub hosts",
          },
        ]),
      ),
    );
    expect(await adapter.resolveAuthenticatedAccount(profile)).toEqual({
      _tag: "err",
      error: { _tag: "GitHubAuthenticationFailed", operation: "auth_status" },
    });
  });
  it("lists pull request commits with immutable parsing and head marking", async () => {
    const olderSha = "1111111111111111111111111111111111111111";
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify(pullRequestPayload()),
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify([
          [
            {
              sha: olderSha,
              html_url:
                "https://github.com/centraldigital/patchdesk/commit/111",
              commit: {
                message: "Older change",
                author: { name: "Older", date: "2026-07-16T11:00:00Z" },
              },
            },
          ],
          [
            {
              sha: headSha,
              html_url:
                "https://github.com/centraldigital/patchdesk/commit/head",
              commit: {
                message: "Head change",
                author: { name: "Head", date: "2026-07-16T12:00:00Z" },
              },
            },
          ],
        ]),
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
    await expect(
      adapter.getPullRequestCommits({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: [
        { sha: headSha, message: "Head change", isHead: true },
        { sha: olderSha, message: "Older change", isHead: false },
      ],
    });
    expect(executor.requests[1]).toEqual([
      "gh",
      "api",
      "--paginate",
      "--slurp",
      "--hostname",
      "github.com",
      "repos/centraldigital/patchdesk/pulls/42/commits?per_page=100",
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
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify(pullRequestPayload()),
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify([commits]),
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
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
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({ id: 9001, state: "PENDING" }),
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({ id: 9001, state: "SUBMITTED" }),
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));

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

    expect(executor.requests).toEqual([createArgv, submitArgv]);
    expect(JSON.parse(executor.stdin[0] ?? "{}")).toEqual(
      JSON.parse(createPayload),
    );
    expect(JSON.parse(executor.stdin[1] ?? "{}")).toEqual(
      JSON.parse(submitPayload),
    );
  });

  it("rejects a create response unless GitHub confirms the review is pending", async () => {
    const adapter = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify({ id: 9001, state: "SUBMITTED" }),
            stderr: "",
          },
        ]),
      ),
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
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({ id: 9001, state: "SUBMITTED" }),
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
    await expect(
      adapter.submitPendingReview({
        profile,
        pr,
        reviewId: "9001",
        event: "COMMENT",
        summaryBody: "Summary-only review.",
      }),
    ).resolves.toEqual({ _tag: "ok", value: { reviewId: "9001" } });
    expect(executor.requests).toEqual([submitArgv]);
    expect(JSON.parse(executor.stdin[0] ?? "{}")).toEqual(
      JSON.parse(summaryPayload),
    );
  });

  it("deletes a review comment through GitHub's id argument", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({
          data: { deletePullRequestReviewComment: { clientMutationId: "1" } },
        }),
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
    await expect(
      adapter.deleteThreadComment({ profile, commentId: "PRRC_abc" }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
    // GitHub rejects DeletePullRequestReviewCommentInput with a
    // pullRequestReviewCommentId argument; the mutation must pass id.
    const request = executor.requests[0]?.join(" ") ?? "";
    expect(request).toContain("deletePullRequestReviewComment(input:{id:$");
    expect(request).not.toContain("pullRequestReviewCommentId");
  });

  it("exposes the review a reply submits so the write journal can exclude it", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            addPullRequestReviewThreadReply: {
              comment: {
                id: "PRRC_reply",
                pullRequestReview: { id: "PRR_review" },
              },
            },
          },
        }),
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
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
    const request = executor.requests[0]?.join(" ") ?? "";
    expect(request).toContain("pullRequestReview{id}");
  });

  it("creates an inline comment with exactly one REST command and no post-write thread scan", async () => {
    // The REST create receipt has no thread id; the removed GraphQL scan
    // declared an unused $id variable (GitHub rejects it) and added a full
    // reviewThreads(first:100) read on the write's critical path.
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({
          node_id: "PRRC_comment",
          pull_request_review_id: 42,
        }),
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
    await expect(
      adapter.createInlineComment({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
        coordinates: { path: "src/a.ts", line: 5, side: "RIGHT" },
        body: "Body",
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { commentId: "PRRC_comment", reviewId: "42" },
    });
    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]?.join(" ")).not.toContain("graphql");
    expect(executor.requests[0]?.join(" ")).not.toContain("reviewThreads");
  });

  it("proves a review thread target with one bounded node query", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            node: {
              id: "PRRT_thread",
              comments: {
                nodes: [
                  {
                    id: "PRRC_c1",
                    pullRequest: {
                      repository: {
                        owner: { login: "centraldigital" },
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
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
    await expect(
      adapter.getReviewThreadTarget({
        profile,
        pr,
        threadId: mustParse(parseGitHubThreadId("PRRT_thread")),
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: true } });
    const request = executor.requests[0]?.join(" ") ?? "";
    expect(executor.requests).toHaveLength(1);
    expect(request).toContain("query ReviewThreadTarget($id: ID!)");
    expect(request).toContain("comments(first: 1)");
    expect(request).toContain("-F id=PRRT_thread");
    // The proof never carries conversation content.
    expect(request).not.toContain("body");
    expect(request).not.toContain("author");
    expect(request).not.toContain("viewerDidAuthor");
  });

  it("treats a thread from another pull request as not found without disclosing it", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            node: {
              id: "PRRT_foreign",
              comments: {
                nodes: [
                  {
                    id: "PRRC_c1",
                    pullRequest: {
                      repository: {
                        owner: { login: "centraldigital" },
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
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
    await expect(
      adapter.getReviewThreadTarget({
        profile,
        pr,
        threadId: mustParse(parseGitHubThreadId("PRRT_foreign")),
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: false } });
  });

  it("treats a missing, typeless, or comment-less thread node as not found", async () => {
    const missing = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({ data: { node: null } }),
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(missing));
    await expect(
      adapter.getReviewThreadTarget({
        profile,
        pr,
        threadId: mustParse(parseGitHubThreadId("PRRT_gone")),
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: false } });
    const wrongType = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({ data: { node: { id: "PRRT_thread" } } }),
        stderr: "",
      },
    ]);
    const adapter2 = testAdapter(new CommandRunner(wrongType));
    await expect(
      adapter2.getReviewThreadTarget({
        profile,
        pr,
        threadId: mustParse(parseGitHubThreadId("PRRT_thread")),
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: false } });
  });

  it("proves a review comment target with viewer authorship", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            node: {
              id: "PRRC_comment",
              viewerDidAuthor: true,
              pullRequest: {
                repository: {
                  owner: { login: "centraldigital" },
                  name: "patchdesk",
                },
                number: 42,
              },
            },
          },
        }),
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
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
    const request = executor.requests[0]?.join(" ") ?? "";
    expect(request).toContain("query ReviewCommentTarget($id: ID!)");
    expect(request).toContain("viewerDidAuthor");
    expect(request).not.toContain("body");
  });

  it("treats a foreign or non-authored comment as the completed target result", async () => {
    const foreign = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            node: {
              id: "PRRC_foreign",
              viewerDidAuthor: true,
              pullRequest: {
                repository: {
                  owner: { login: "centraldigital" },
                  name: "patchdesk",
                },
                number: 99,
              },
            },
          },
        }),
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(foreign));
    await expect(
      adapter.getReviewCommentTarget({
        profile,
        pr,
        commentId: "PRRC_foreign",
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: false } });
    const notAuthor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            node: {
              id: "PRRC_other",
              viewerDidAuthor: false,
              pullRequest: {
                repository: {
                  owner: { login: "centraldigital" },
                  name: "patchdesk",
                },
                number: 42,
              },
            },
          },
        }),
        stderr: "",
      },
    ]);
    const adapter2 = testAdapter(new CommandRunner(notAuthor));
    await expect(
      adapter2.getReviewCommentTarget({ profile, pr, commentId: "PRRC_other" }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { found: true, viewerDidAuthor: false },
    });
  });

  it("degrades the create receipt instead of failing when the thread lookup fails", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({ node_id: "PRRC_comment" }),
        stderr: "",
      },
      { _tag: "Exited", exitCode: 1, stdout: "", stderr: "HTTP 500" },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
    await expect(
      adapter.createInlineComment({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
        coordinates: { path: "src/a.ts", line: 5, side: "RIGHT" },
        body: "Body",
      }),
    ).resolves.toEqual({ _tag: "ok", value: { commentId: "PRRC_comment" } });
  });

  it("merges only through the explicit SHA-pinned GitHub endpoint", async () => {
    const [mergeArgv, mergePayload] = await Promise.all([
      golden("merge-pull-request"),
      payload("merge-pull-request.json"),
    ]);
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({ merged: true, sha: headSha }),
        stderr: "",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
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
    expect(executor.requests).toEqual([mergeArgv]);
    expect(JSON.parse(executor.stdin[0] ?? "{}")).toEqual(
      JSON.parse(mergePayload),
    );
  });
});

describe("GitHubAdapter pending-review gateway", () => {
  const account = "pmquan2cfw";
  const reviewId = 9001;
  const reviewNodeId = "PRR_kwDORJzsQM7e6QwJ";
  const threadId = "PRRT_kwDORJzsQM0001";
  const commentId = "PRRC_kwDORJzsQM7fI2Rd";
  const reviewListUrl = `repos/centraldigital/patchdesk/pulls/42/reviews?per_page=100&page=1`;

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

  const exited = (stdout: string): CommandExecution => ({
    _tag: "Exited",
    exitCode: 0,
    stdout,
    stderr: "",
  });

  it("returns None only for a complete result with no viewer pending review", async () => {
    const executor = new FakeProcessExecutor([
      exited(
        JSON.stringify([
          {
            id: 1,
            state: "COMMENTED",
            user: { login: "other" },
            submitted_at: "2026-08-08T00:00:00Z",
          },
        ]),
      ),
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
    await expect(
      adapter.getViewerPendingReview({
        profile,
        pr,
        account: mustParse(parseGitHubLogin(account)),
      }),
    ).resolves.toEqual({ _tag: "ok", value: { _tag: "None" } });
    expect(executor.requests[0]).toContain(reviewListUrl);
  });

  it("imports the viewer's pending review with complete bounded thread/comment identity", async () => {
    const executor = new FakeProcessExecutor([
      exited(reviewsPayload()),
      exited(threadsPayload()),
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
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
    expect(executor.requests[1]?.join(" ")).toContain(
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
    const executor = new FakeProcessExecutor([
      exited(reviewsPayload()),
      exited(threads),
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
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
    const executor = new FakeProcessExecutor([
      exited(reviewsPayload()),
      exited(threads),
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
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
      new CommandRunner(
        new FakeProcessExecutor([exited(JSON.stringify(fullReviews))]),
      ),
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
      new CommandRunner(
        new FakeProcessExecutor([exited(reviewsPayload()), exited(threads)]),
      ),
    );
    await expect(
      incompleteThreads.getViewerPendingReview({
        profile,
        pr,
        account: mustParse(parseGitHubLogin(account)),
      }),
    ).resolves.toMatchObject({ _tag: "err" });

    const malformed = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          exited("{not-json"),
          exited(threadsPayload()),
        ]),
      ),
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
    const executor = new FakeProcessExecutor([
      // GitHub's live create-review response does not include the created
      // inline comment. Exact thread identity must come from read-back.
      exited(
        JSON.stringify({
          id: reviewId,
          node_id: reviewNodeId,
          state: "PENDING",
          commit_id: headSha,
        }),
      ),
      exited(reviewsPayload()),
      exited(threadsPayload()),
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
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
    // The REST create passes the head SHA and the single inline comment.
    expect(JSON.parse(executor.stdin[0] ?? "{}")).toEqual({
      commit_id: headSha,
      body: "Comment body",
      comments: [
        { path: "src/review.ts", line: 7, side: "RIGHT", body: "Comment body" },
      ],
    });
  });

  it("never fabricates a pending owner when the create read-back cannot be proven", async () => {
    const missingRead = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          exited(
            JSON.stringify({
              id: reviewId,
              node_id: reviewNodeId,
              state: "PENDING",
              commit_id: headSha,
              comments: [{ node_id: commentId }],
            }),
          ),
          exited("[]"),
        ]),
      ),
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
    const executor = new FakeProcessExecutor([
      exited(
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
      ),
      exited(reviewsPayload()),
      exited(threadsPayload()),
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
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
    const request = executor.requests[0]?.join(" ") ?? "";
    expect(request).toContain("addPullRequestReviewThread");
    expect(request).toContain("pullRequestReviewId:$reviewId");
  });

  it("keeps pageInfo inside the comments connection in the AddThread selection", async () => {
    // PullRequestReviewThread has no pageInfo field; the old
    // `comments(first:100){nodes{id body}} pageInfo{hasNextPage}` shape made
    // GitHub reject the mutation at schema validation (409 github_rejected)
    // before any execution. The query must nest pageInfo under comments.
    const executor = new FakeProcessExecutor([
      exited(
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
      ),
      exited(reviewsPayload()),
      exited(threadsPayload()),
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
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
    const request = executor.requests[0]?.join(" ") ?? "";
    expect(request).toContain(
      "comments(first:100){nodes{id body} pageInfo{hasNextPage}}",
    );
    expect(request).not.toMatch(/nodes\{id body\}\} pageInfo/);
    expect(request).toContain("diffSide");
  });

  it("rejects an append whose mutation response lacks thread identity", async () => {
    const adapter = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          exited(
            JSON.stringify({
              data: {
                addPullRequestReviewThread: {
                  thread: { id: "PRRT_ok", comments: { nodes: [] } },
                },
              },
            }),
          ),
        ]),
      ),
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
    const executor = new FakeProcessExecutor([exited(reviewsPayload())]);
    const adapter = testAdapter(new CommandRunner(executor));
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
    const executor = new FakeProcessExecutor([
      { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
    await expect(
      adapter.discardPendingReview({
        profile,
        pr,
        reviewId: mustParse(parseGitHubReviewRestId("9001")),
      }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
    expect(executor.requests[0]).toEqual([
      "gh",
      "api",
      "--hostname",
      "github.com",
      "--method",
      "DELETE",
      "repos/centraldigital/patchdesk/pulls/42/reviews/9001",
    ]);
  });

  it("classifies a not-found discard as unavailable (conservative, never a confirmed absence)", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr: "gh: Not Found (HTTP 404)",
      },
    ]);
    const adapter = testAdapter(new CommandRunner(executor));
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

  it("keeps the fake discard seam unimplemented until a fixture is supplied", async () => {
    const adapter = new FakeGitHubAdapter({
      authenticatedAccount: { host: "github.com", account: "pmquan2cfw" },
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
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify([
              {
                id: 100,
                user: { login: "pmquan2cfw" },
                state: "DISMISSED",
                commit_id: headSha,
                submitted_at: "2026-08-01T00:00:00Z",
                body: "Dismissed",
              },
              {
                id: 101,
                user: { login: "pmquan2cfw" },
                state: "COMMENTED",
                commit_id: headSha,
                submitted_at: "2026-08-01T00:01:00Z",
                body: "Summary",
              },
            ]),
            stderr: "",
          },
        ]),
      ),
    );

    await expect(
      adapter.getViewerDirectSummaryReviews({
        profile,
        pr,
        account: mustParse(parseGitHubLogin("pmquan2cfw")),
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
      ownerFilters: [],
      workspaceRoots: [],
      rulePaths: [],
      repos: [],
    }),
  );

  function credentialAdapter(executor: FakeProcessExecutor): GitHubAdapter {
    const commands = new CommandRunner(executor);
    return new GitHubAdapter(commands, new GitHubCliCredentials(commands));
  }

  function exited(stdout: string): CommandExecution {
    return { _tag: "Exited", exitCode: 0, stdout, stderr: "" };
  }

  it("authenticates gh as the profile's account, not the machine-wide active account", async () => {
    const executor = new FakeProcessExecutor([
      exited("profile-token\n"),
      exited(JSON.stringify(pullRequestPayload())),
    ]);

    await expect(
      credentialAdapter(executor).getPullRequest({ profile, pr }),
    ).resolves.toMatchObject({ _tag: "ok" });

    expect(executor.requests[0]).toEqual([
      "gh",
      "auth",
      "token",
      "--hostname",
      "github.com",
      "--user",
      "pmquan2cfw",
    ]);
    expect(executor.requests[1]?.[0]).toBe("gh");
    expect(executor.environments[1]).toEqual({ GH_TOKEN: "profile-token" });
  });

  it("passes an Enterprise Server host its own token variable", async () => {
    const executor = new FakeProcessExecutor([
      exited("enterprise-token\n"),
      exited(JSON.stringify(pullRequestPayload())),
    ]);

    await credentialAdapter(executor).getPullRequest({
      profile: enterpriseProfile,
      pr,
    });

    expect(executor.requests[0]).toEqual([
      "gh",
      "auth",
      "token",
      "--hostname",
      "github.opn.example",
      "--user",
      "matthew-opn",
    ]);
    expect(executor.environments[1]).toEqual({
      GH_ENTERPRISE_TOKEN: "enterprise-token",
    });
  });

  it("reports authentication failure without dispatching the call when the account has no stored credential", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr: "no oauth token found for github.com account pmquan2cfw",
      },
    ]);

    await expect(
      credentialAdapter(executor).getPullRequest({ profile, pr }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "GitHubAuthenticationFailed", operation: "get_pr" },
    });
    expect(executor.requests).toHaveLength(1);
  });

  it("reuses a resolved token and re-reads it after GitHub rejects the credential", async () => {
    const executor = new FakeProcessExecutor([
      exited("token-1\n"),
      exited(JSON.stringify(pullRequestPayload())),
      {
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr: "gh auth login",
      },
      exited("token-2\n"),
      exited(JSON.stringify(pullRequestPayload())),
    ]);
    const adapter = credentialAdapter(executor);

    await adapter.getPullRequest({ profile, pr });
    await adapter.getPullRequest({ profile, pr });
    await adapter.getPullRequest({ profile, pr });

    expect(executor.requests.map((request) => request.slice(0, 3))).toEqual([
      ["gh", "auth", "token"],
      ["gh", "api", "--hostname"],
      ["gh", "api", "--hostname"],
      ["gh", "auth", "token"],
      ["gh", "api", "--hostname"],
    ]);
    expect(executor.environments[2]).toEqual({ GH_TOKEN: "token-1" });
    expect(executor.environments[4]).toEqual({ GH_TOKEN: "token-2" });
  });

  it("resolves the authenticated account against the profile's own credential", async () => {
    const executor = new FakeProcessExecutor([
      exited("profile-token\n"),
      exited("pmquan2cfw\n"),
    ]);

    await expect(
      credentialAdapter(executor).resolveAuthenticatedAccount(profile),
    ).resolves.toEqual({
      _tag: "ok",
      value: { host: "github.com", account: "pmquan2cfw" },
    });
    expect(executor.environments[1]).toEqual({ GH_TOKEN: "profile-token" });
  });
});
