import { describe, expect, it } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
  type CommandFailure,
} from "../../src/adapters/github/command-runner";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import { type GitHubCredentials } from "../../src/adapters/github/github-credentials";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import { type PullRequestRef } from "../../src/domain/pull-request";
import { ok, type Result } from "../../src/domain/result";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";

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

  constructor(private readonly responses: ReadonlyArray<CommandExecution>) {}

  async execute(input: {
    readonly argv: ReadonlyArray<string>;
    readonly timeoutMs: number;
    readonly stdin?: string;
    readonly environment?: Readonly<Record<string, string>>;
  }): Promise<CommandExecution> {
    this.requests.push(input.argv);
    const response = this.responses[this.requests.length - 1];
    if (response === undefined)
      throw new Error("Missing fake command response");
    return response;
  }
}

/** Resolves a fixed credential so command expectations stay about gh argv. */
class StubCredentials implements GitHubCredentials {
  async environmentFor(): Promise<
    Result<Readonly<Record<string, string>>, CommandFailure>
  > {
    return ok({ GH_TOKEN: "profile-token" });
  }

  forget(): void {}
}

function testAdapter(commands: CommandRunner): GitHubAdapter {
  return new GitHubAdapter(commands, new StubCredentials());
}

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

  it("accepts no classic required checks on a ruleset-managed branch", async () => {
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
            exitCode: 1,
            stdout: "",
            stderr: "HTTP 404: Branch not protected",
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
        complete: true,
        checks: {
          overall: "passing",
          checks: [
            expect.objectContaining({
              name: "unit",
              required: false,
              conclusion: "success",
            }),
          ],
        },
      }),
    });
  });

  it("reads a head commit with no status-check rollup as no required checks", async () => {
    const adapter = testAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify(
              mergePolicyPayload({ statusCheckRollup: null }),
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
    ).resolves.toEqual({
      _tag: "ok",
      value: expect.objectContaining({
        headSha,
        complete: true,
        checks: { overall: "unknown", checks: [] },
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
    // GitHub sends a null rollup for a head commit no CI ever ran against.
    readonly statusCheckRollup?: null;
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
                  statusCheckRollup:
                    overrides.statusCheckRollup === null
                      ? null
                      : {
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
