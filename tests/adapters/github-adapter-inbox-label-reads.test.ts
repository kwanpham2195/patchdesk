import { orderedTransport } from "./github-transport-doubles";
import { describe, expect, it } from "vitest";
import {
  headSha,
  profile,
  pr,
  testAdapter,
  sent,
} from "./github-adapter-test-support";

describe("GitHubAdapter inbox and repository-label reads", () => {
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
});
