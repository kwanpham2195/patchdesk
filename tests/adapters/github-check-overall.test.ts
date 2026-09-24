import { parseGitSha } from "../../src/domain/ids";
import { describe, expect, it } from "vitest";
import { orderedTransport, routedTransport } from "./github-transport-doubles";
import {
  headSha,
  mustParse,
  profile,
  pr,
  testAdapter,
} from "./github-adapter-test-support";

const checkRunsLabel = "api GET repos/:owner/:repo/commits/:sha/check-runs";
const noCheckRuns = JSON.stringify({ total_count: 0, check_runs: [] });
const noStatuses = JSON.stringify({ state: "pending", statuses: [] });

describe("GitHubAdapter overall check state", () => {
  it("reports none when both check reads succeed with no checks", async () => {
    const adapter = testAdapter(
      routedTransport((label) =>
        label === checkRunsLabel ? noCheckRuns : noStatuses,
      ),
    );

    const result = await adapter.getPullRequestChecks({
      profile,
      pr,
      headSha: mustParse(parseGitSha(headSha)),
    });

    expect(result).toEqual({
      _tag: "ok",
      value: { overall: "none", checks: [] },
    });
  });

  it("reports unknown when the check-runs read fails and statuses are empty", async () => {
    const adapter = testAdapter(
      routedTransport((label) =>
        label === checkRunsLabel ? { _tag: "CommandFailed" } : noStatuses,
      ),
    );

    const result = await adapter.getPullRequestChecks({
      profile,
      pr,
      headSha: mustParse(parseGitSha(headSha)),
    });

    expect(result).toEqual({
      _tag: "ok",
      value: { overall: "unknown", checks: [] },
    });
  });

  it.each([
    { name: "no status rollup", rollup: null, overall: "none" },
    {
      name: "an unrecognised rollup state",
      rollup: { state: "SOMETHING_NEW" },
      overall: "unknown",
    },
  ])(
    "reads $name on a listing row as $overall",
    async ({ rollup, overall }) => {
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
                    baseRefName: "main",
                    author: { login: "reviewer" },
                    updatedAt: "2026-07-16T12:00:00Z",
                    mergeable: "MERGEABLE",
                    reviewDecision: null,
                    additions: 1,
                    deletions: 0,
                    changedFiles: 1,
                    labels: {
                      totalCount: 0,
                      nodes: [],
                      pageInfo: { hasNextPage: false },
                    },
                    reviewRequests: { nodes: [] },
                    assignees: { nodes: [] },
                    commits: {
                      nodes: [{ commit: { statusCheckRollup: rollup } }],
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
      const adapter = testAdapter(orderedTransport([JSON.stringify(page)]));

      const result = await adapter.listMaintainerPullRequests({
        profile,
        repo: pr,
        pageSize: 25,
      });

      expect(result).toMatchObject({
        _tag: "ok",
        value: {
          entries: [{ pullRequest: { checks: { overall, checks: [] } } }],
        },
      });
    },
  );
});
