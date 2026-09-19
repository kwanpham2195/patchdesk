import { StubCredentials } from "./stub-github-credentials";
import { describe, expect, it } from "vitest";

import {
  jsonAnswer,
  noChildProcesses,
  orderedTransport,
  type CannedAnswer,
  type HttpTransportDouble,
} from "./github-transport-doubles";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import { type PullRequestRef } from "../../src/domain/pull-request";
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

function testAdapter(transport: HttpTransportDouble): GitHubAdapter {
  return new GitHubAdapter(
    noChildProcesses(),
    new StubCredentials(),
    transport,
  );
}

/** A branch GitHub reports as unprotected answers the classic endpoint with a 404. */
const branchNotProtected: CannedAnswer = { _tag: "CommandNotFound" };

/** A branch-protection read the token may not make, with no reason GitHub names. */
const protectionDenied: CannedAnswer = {
  _tag: "CommandForbidden",
  reason: "unknown",
};

describe("GitHubAdapter merge policy", () => {
  it("joins the exact-head rollup to required branch contexts", async () => {
    const adapter = testAdapter(
      orderedTransport([
        jsonAnswer(mergePolicyPayload()),
        jsonAnswer({ contexts: ["unit"], checks: [] }),
      ]),
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
      orderedTransport([jsonAnswer(mergePolicyPayload()), branchNotProtected]),
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
      orderedTransport([
        jsonAnswer(mergePolicyPayload({ statusCheckRollup: null })),
        jsonAnswer({ contexts: [], checks: [] }),
      ]),
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
        orderedTransport([
          jsonAnswer(mergePolicyPayload({ mergeStateStatus: raw })),
          jsonAnswer({ contexts: [], checks: [] }),
        ]),
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
      orderedTransport([
        jsonAnswer(mergePolicyPayload({ mergeStateStatus: undefined })),
        jsonAnswer({ contexts: [], checks: [] }),
      ]),
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
      orderedTransport([
        jsonAnswer(mergePolicyPayload({ headRefOid: baseSha })),
      ]),
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

    const pages = [0, 1, 2].map((index) =>
      jsonAnswer(
        mergePolicyPayload({
          pageInfo: { hasNextPage: true, endCursor: `cursor-${index}` },
        }),
      ),
    );
    const pagination = testAdapter(orderedTransport(pages));
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
      orderedTransport([jsonAnswer(mergePolicyPayload()), protectionDenied]),
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
