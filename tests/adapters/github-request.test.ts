import { describe, expect, it } from "vitest";

import {
  ghInvocationFor,
  type GitHubRequest,
} from "../../src/adapters/github/github-request";

/**
 * Every expectation below is the argv literal the matching call site wrote
 * inline before `GitHubRequest` existed, so a drift in the builder shows up
 * as a difference from what the adapter used to spawn (issue #276, ADR 0046).
 */
const cases: ReadonlyArray<{
  readonly name: string;
  readonly request: GitHubRequest;
  readonly argv: ReadonlyArray<string>;
  readonly stdin?: string;
}> = [
  {
    name: "listOpenPullRequests",
    request: {
      kind: "rest",
      host: "github.com",
      path: "repos/octo-org/patchdesk/pulls?state=open&per_page=100",
    },
    argv: [
      "gh",
      "api",
      "--hostname",
      "github.com",
      "repos/octo-org/patchdesk/pulls?state=open&per_page=100",
    ],
  },
  {
    name: "resolveAuthenticatedAccount",
    request: {
      kind: "rest",
      host: "github.com",
      path: "user",
    },
    argv: ["gh", "api", "--hostname", "github.com", "user"],
  },
  {
    name: "createPendingReview",
    request: {
      kind: "rest",
      host: "github.com",
      method: "POST",
      path: "repos/octo-org/patchdesk/pulls/42/reviews",
      jsonBody: '{"commit_id":"abc"}',
    },
    argv: [
      "gh",
      "api",
      "--hostname",
      "github.com",
      "--method",
      "POST",
      "repos/octo-org/patchdesk/pulls/42/reviews",
      "--input",
      "-",
    ],
    stdin: '{"commit_id":"abc"}',
  },
  {
    name: "discardPendingReview",
    request: {
      kind: "rest",
      host: "github.com",
      method: "DELETE",
      path: "repos/octo-org/patchdesk/pulls/42/reviews/7",
    },
    argv: [
      "gh",
      "api",
      "--hostname",
      "github.com",
      "--method",
      "DELETE",
      "repos/octo-org/patchdesk/pulls/42/reviews/7",
    ],
  },
  {
    name: "getPullRequestDiff — snapshot compare",
    request: {
      kind: "rest",
      host: "github.com",
      accept: "application/vnd.github.v3.diff",
      path: "repos/octo-org/patchdesk/compare/base...head",
    },
    argv: [
      "gh",
      "api",
      "--hostname",
      "github.com",
      "-H",
      "Accept: application/vnd.github.v3.diff",
      "repos/octo-org/patchdesk/compare/base...head",
    ],
  },
  {
    name: "getPullRequestCommits — paginated",
    request: {
      kind: "rest",
      paginate: true,
      host: "github.com",
      path: "repos/octo-org/patchdesk/pulls/42/commits?per_page=100",
    },
    argv: [
      "gh",
      "api",
      "--paginate",
      "--slurp",
      "--hostname",
      "github.com",
      "repos/octo-org/patchdesk/pulls/42/commits?per_page=100",
    ],
  },
  {
    name: "getMergePolicy — second page",
    request: {
      kind: "graphql",
      host: "github.com",
      document: "query MergePolicy",
      variables: [
        { kind: "typed", name: "owner", value: "octo-org" },
        { kind: "typed", name: "name", value: "patchdesk" },
        { kind: "typed", name: "number", value: 42 },
        { kind: "typed", name: "cursor", value: "Y3Vyc29y" },
      ],
    },
    argv: [
      "gh",
      "api",
      "graphql",
      "--hostname",
      "github.com",
      "-f",
      "query=query MergePolicy",
      "-F",
      "owner=octo-org",
      "-F",
      "name=patchdesk",
      "-F",
      "number=42",
      "-F",
      "cursor=Y3Vyc29y",
    ],
  },
  {
    name: "readWatchedPullRequests — String owner and name, typed number",
    request: {
      kind: "graphql",
      host: "github.com",
      document: "query Watched",
      variables: [
        { kind: "string", name: "owner0", value: "2026" },
        { kind: "string", name: "name0", value: "patchdesk" },
        { kind: "typed", name: "number0", value: 42 },
      ],
    },
    argv: [
      "gh",
      "api",
      "graphql",
      "--hostname",
      "github.com",
      "-f",
      "query=query Watched",
      "-f",
      "owner0=2026",
      "-f",
      "name0=patchdesk",
      "-F",
      "number0=42",
    ],
  },
  {
    name: "addLabelsToLabelable — id list",
    request: {
      kind: "graphql",
      host: "github.com",
      document: "mutation AddLabels",
      variables: [
        { kind: "typed", name: "labelableId", value: "PR_node" },
        { kind: "list", name: "labelIds", values: ["LA_one", "LA_two"] },
      ],
    },
    argv: [
      "gh",
      "api",
      "graphql",
      "--hostname",
      "github.com",
      "-f",
      "query=mutation AddLabels",
      "-F",
      "labelableId=PR_node",
      "-F",
      "labelIds[]=LA_one",
      "-F",
      "labelIds[]=LA_two",
    ],
  },
];

describe("ghInvocationFor", () => {
  for (const testCase of cases) {
    it(`builds the argv ${testCase.name} used to write inline`, () => {
      const invocation = ghInvocationFor(testCase.request);
      expect(invocation.argv).toEqual(testCase.argv);
      expect(invocation.stdin).toEqual(testCase.stdin);
    });
  }

  it("omits a GraphQL list variable entirely when it has no values", () => {
    expect(
      ghInvocationFor({
        kind: "graphql",
        host: "github.com",
        document: "mutation AddLabels",
        variables: [{ kind: "list", name: "labelIds", values: [] }],
      }).argv,
    ).toEqual([
      "gh",
      "api",
      "graphql",
      "--hostname",
      "github.com",
      "-f",
      "query=mutation AddLabels",
    ]);
  });
});
