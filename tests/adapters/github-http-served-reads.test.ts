import { describe, expect, it } from "vitest";

import { CommandRunner } from "../../src/adapters/github/command-runner";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import {
  assignableUsersQuery,
  maintainerInboxSearchQuery,
  mergePolicyQuery,
  repositoryBranchesQuery,
  threadQuery,
} from "../../src/adapters/github/github-graphql-queries";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import type { PullRequestRef } from "../../src/domain/pull-request";
import { err, ok, type Result } from "../../src/domain/result";
import { json, profile, useFixtureServer } from "./github-http-fixture-server";
import { RecordingGhExecutor } from "./github-transport-doubles";
import { StubCredentials } from "./stub-github-credentials";

/**
 * The reads the adapter makes, driven through the real HTTP client against a
 * loopback fixture server (issue #276). What these pin is what the client puts
 * on the wire and what it hands back: the URL, the GraphQL variables with the
 * types gh's field inference gave them, and the rate limit a response carries.
 */

function mustParse<T, E>(result: Result<T, E>): T {
  if (result._tag === "err") throw new Error("Expected test value to parse");
  return result.value;
}

const pr: PullRequestRef = {
  host: mustParse(parseGitHubHost("github.com")),
  owner: mustParse(parseGitHubOwner("centraldigital")),
  repo: mustParse(parseGitHubRepoName("patchdesk")),
  number: mustParse(parsePullRequestNumber(42)),
};

describe("reads served over the real HTTP client", () => {
  const server = useFixtureServer();

  function adapter(): GitHubAdapter {
    const credentials = new StubCredentials();
    return new GitHubAdapter(
      new CommandRunner(
        new RecordingGhExecutor({
          _tag: "Exited",
          exitCode: 1,
          stdout: "",
          stderr: "no gh child may run for a served read",
        }),
      ),
      credentials,
      server.client(credentials),
    );
  }

  it("reads a 404 on branch protection as the unprotected-branch evidence", async () => {
    server.respondWith(json(404, { message: "Branch not protected" }));

    const read = await adapter().readBranchProtection({
      profile,
      pr,
      branch: "main",
    });

    expect(read.dismissal).toEqual(
      ok({ protected: false, allowedDismissers: [] }),
    );
    expect(server.requests()[0]?.url).toBe(
      "/repos/centraldigital/patchdesk/branches/main/protection",
    );
  });

  it("parses the authenticated login out of the whole user body", async () => {
    server.respondWith(json(200, { login: "pmquan2cfw", id: 1 }));

    await expect(
      adapter().resolveAuthenticatedAccount(profile),
    ).resolves.toEqual(ok({ host: "github.com", account: "pmquan2cfw" }));
    expect(server.requests()[0]?.url).toBe("/user");
  });

  /**
   * gh's `-F` inferred each variable's type from its text and `-f` always sent
   * a String. The client infers from the same text, so these three call sites
   * have to reach GitHub with the types they reached it with through gh.
   */
  it("sends the merge policy variables with the types gh sent", async () => {
    server.respondWith(json(200, { data: { repository: null } }));

    await adapter().getMergePolicy({
      profile,
      pr,
      expectedHeadSha: mustParse(parseGitSha("b".repeat(40))),
    });

    expect(server.requests()[0]?.url).toBe("/graphql");
    expect(JSON.parse(server.requests()[0]?.body ?? "")).toEqual({
      query: mergePolicyQuery,
      variables: { owner: "centraldigital", name: "patchdesk", number: 42 },
    });
  });

  it("sends the review thread variables with the types gh sent", async () => {
    server.respondWith(json(200, { data: { repository: null } }));

    await adapter().getPullRequestComments({ profile, pr });

    expect(JSON.parse(server.requests()[0]?.body ?? "")).toEqual({
      query: threadQuery,
      variables: { owner: "centraldigital", name: "patchdesk", number: 42 },
    });
  });

  it("sends the inbox search variables with the types gh sent", async () => {
    server.respondWith(json(200, { data: { search: null } }));

    await adapter().searchMaintainerPullRequests({
      profile,
      repo: pr,
      searchQuery: "repo:centraldigital/patchdesk is:pr is:open",
      state: "open",
      pageSize: 25,
      cursor: "Y3Vyc29yOnYyOpHOAAE",
    });

    expect(JSON.parse(server.requests()[0]?.body ?? "")).toEqual({
      query: maintainerInboxSearchQuery,
      variables: {
        search: "repo:centraldigital/patchdesk is:pr is:open",
        first: 25,
        cursor: "Y3Vyc29yOnYyOpHOAAE",
      },
    });
  });

  /**
   * The assignee and branch pickers put the maintainer's typed text straight
   * into a GraphQL variable, so how that text encodes is most of what these
   * two reads can differ on. gh sent the assignee search through `-F`
   * (`github-collaborators.ts`) and the branch search through `-f`
   * (`github-pull-request-reader.ts`), which is why only the first infers a
   * type from the text.
   */
  const searchTexts = [
    { name: "ordinary text", typed: "ann", inferred: "ann" },
    {
      name: "a quote and a backslash",
      typed: 'o"neill\\src',
      inferred: 'o"neill\\src',
    },
    { name: "non-ASCII text", typed: "café", inferred: "café" },
    // Issue #279: `-F` inferred an all-digit field as an Int against
    // `$search: String`, and the client infers from the same text, so the bug
    // reaches GitHub identically rather than being fixed by the transport.
    { name: "an all-digit string", typed: "2026", inferred: 2026 },
    // gh's `-F` read a leading `@` as a filename to read the value from; the
    // client has no filesystem step and sends the text as typed.
    { name: "a leading @", typed: "@octocat", inferred: "@octocat" },
  ] as const;

  it.each(searchTexts)(
    "sends an assignee search of $name the way gh's -F typed it",
    async ({ typed, inferred }) => {
      server.respondWith(json(200, { data: { repository: null } }));

      await adapter().listAssignableUsers({ profile, repo: pr, query: typed });

      expect(server.requests()[0]?.url).toBe("/graphql");
      expect(JSON.parse(server.requests()[0]?.body ?? "")).toEqual({
        query: assignableUsersQuery,
        variables: {
          owner: "centraldigital",
          name: "patchdesk",
          search: inferred,
        },
      });
    },
  );

  it.each(searchTexts)(
    "sends a branch search of $name as the String gh's -f sent",
    async ({ typed }) => {
      server.respondWith(json(200, { data: { repository: null } }));

      await adapter().listRepositoryBranches({
        profile,
        repo: pr,
        query: typed,
      });

      expect(JSON.parse(server.requests()[0]?.body ?? "")).toEqual({
        query: repositoryBranchesQuery,
        variables: {
          owner: "centraldigital",
          name: "patchdesk",
          search: typed,
        },
      });
    },
  );

  it("still learns the rate limit the inbox search carries (ADR 0023)", async () => {
    const resetAt = "2099-01-01T00:00:00Z";
    server.respondWith(
      json(200, {
        data: {
          rateLimit: { remaining: 0, resetAt },
          search: {
            issueCount: 0,
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );
    const github = adapter();

    await github.searchMaintainerPullRequests({
      profile,
      repo: pr,
      searchQuery: "repo:centraldigital/patchdesk is:pr is:open",
      state: "open",
      pageSize: 25,
    });
    // A host whose whole budget is spent answers without asking GitHub again.
    const watched = await github.readWatchedPullRequests({
      profile,
      refs: [pr],
      now: mustParse(parseIsoTimestamp("2026-09-19T00:00:00.000Z")),
    });

    expect(watched).toEqual(
      err({
        _tag: "GitHubRateLimited",
        operation: "get_watched_prs",
        resumeAt: "2099-01-01T00:00:00.000Z",
      }),
    );
    expect(server.requests()).toHaveLength(1);
  });
});
