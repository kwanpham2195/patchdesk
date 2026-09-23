import { orderedTransport } from "./github-transport-doubles";
import {
  maintainerInboxQuery,
  maintainerInboxSearchQuery,
} from "../../src/adapters/github/github-graphql-queries";
import { describe, expect, it } from "vitest";
import { profile, pr, testAdapter, sent } from "./github-adapter-test-support";

describe("GitHubAdapter assignee, reviewer, and rate-limit reads", () => {
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
      query: "2026",
    });
    const searchIndex = sent(withQuery, 0).argv.indexOf("search=2026");
    expect(sent(withQuery, 0).argv[searchIndex - 1]).toBe("-f");

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
});
