import { orderedTransport } from "./github-transport-doubles";
import { parseGitSha } from "../../src/domain/ids";
import { describe, expect, it } from "vitest";
import {
  headSha,
  baseSha,
  mustParse,
  profile,
  pr,
  testAdapter,
  sent,
  sentArgv,
  golden,
  payload,
} from "./github-adapter-test-support";

describe("GitHubAdapter search and checked-in read contracts", () => {
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
        searchQuery: "2026",
        state: "open",
        pageSize: 25,
      });

      const argv = sent(transport, 0).argv;
      const searchIndex = argv.indexOf("search=2026");
      const firstIndex = argv.indexOf("first=25");
      expect(searchIndex).toBeGreaterThan(0);
      expect(argv[searchIndex - 1]).toBe("-f");
      expect(argv[firstIndex - 1]).toBe("-F");
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
});
