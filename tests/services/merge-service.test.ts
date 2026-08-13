import { describe, expect, it } from "vitest";

import { mergePullRequest } from "../../src/services/merge-service";

const sha = "abcdef1234567890abcdef1234567890abcdef12" as never;
const session = {
  id: "github.com__centraldigital__patchdesk__pr-1__sha-abcdef12__0123456789ab",
  key: {
    profileId: "cfw",
    host: "github.com",
    owner: "centraldigital",
    repo: "patchdesk",
    prNumber: 1,
    headSha: sha,
  },
  pr: { headSha: sha, baseSha: sha, isDraft: false, isOpen: true },
  patchPath: "/tmp/does-not-exist",
} as never;
const profile = { githubHost: "github.com", ghAccount: "fixture" } as never;
describe("merge service", () => {
  it("fails closed when complete revision proof is unavailable", async () => {
    const merge = async () => ({ _tag: "ok" as const, value: {} });
    await expect(
      mergePullRequest({
        profile,
        session,
        gateway: {
          getPullRequest: async () => ({
            _tag: "ok" as const,
            value: {
              ref: {
                host: "github.com",
                owner: "centraldigital",
                repo: "patchdesk",
                number: 1,
              },
              headSha: sha,
              baseSha: sha,
              changedFileCount: 1,
            },
          }),
          getPullRequestDiff: async () => ({ _tag: "ok" as const, value: "" }),
          getMergePolicy: async () => ({ _tag: "ok" as const, value: {} }),
          mergePullRequest: merge,
        } as never,
        method: "squash",
        supportedMethods: ["squash"],
        acknowledgedWarningCodes: [],
      }),
    ).resolves.toMatchObject({
      _tag: "err",
      error: { _tag: "RevisionUnavailableBlocksMerge" },
    });
  });
});
