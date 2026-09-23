import { CommandRunner } from "../../src/adapters/github/command-runner";
import { orderedTransport } from "./github-transport-doubles";
import {
  type GitHubAdapter,
  pullRequestWritePermission,
  repositoryLabelPermission,
  type GitHubReadFailure,
} from "../../src/adapters/github/github-adapter";
import { parseGitSha } from "../../src/domain/ids";
import { err, ok } from "../../src/domain/result";
import { describe, expect, it } from "vitest";
import {
  headSha,
  mustParse,
  profile,
  pr,
  FakeProcessExecutor,
  testAdapter,
  sentArgv,
} from "./github-adapter-test-support";

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
  it.each([
    {
      description: "merged",
      response: JSON.stringify({
        state: "closed",
        merged_at: "2026-08-01T00:00:00Z",
        merge_commit_sha: headSha,
      }),
      outcome: {
        state: "merged" as const,
        mergeCommitSha: headSha,
        mergedAt: "2026-08-01T00:00:00.000Z",
      },
    },
    {
      description: "open",
      response: JSON.stringify({ state: "open" }),
      outcome: { state: "open" as const },
    },
    {
      description: "closed but unmerged",
      response: JSON.stringify({ state: "closed", merged_at: null }),
      outcome: { state: "closed_unmerged" as const },
    },
  ])("reads the $description outcome", async ({ response, outcome }) => {
    const adapter = testAdapter(orderedTransport([response]));

    await expect(adapter.getMergeOutcome({ profile, pr })).resolves.toEqual({
      _tag: "ok",
      value: outcome,
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
