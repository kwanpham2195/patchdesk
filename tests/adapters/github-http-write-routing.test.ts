import { describe, expect, it } from "vitest";

import { CommandRunner } from "../../src/adapters/github/command-runner";
import {
  GhRequestRunner,
  httpServedReadLabels,
  httpServedWriteLabels,
  transportRouteFor,
  type GitHubTransportRoute,
} from "../../src/adapters/github/gh-request-runner";
import {
  addLabelsToLabelableMutation,
  confirmCreatedCommentThreadQuery,
  reviewCommentTargetQuery,
  reviewThreadTargetQuery,
} from "../../src/adapters/github/github-graphql-queries";
import {
  isReadRequest,
  type GitHubGraphQlRequest,
  type GitHubRequest,
  type GitHubRestRequest,
} from "../../src/adapters/github/github-request";
import { err, ok } from "../../src/domain/result";
import { profile } from "./github-http-fixture-server";
import {
  exited,
  RecordingGhExecutor,
  RecordingHttpTransport,
} from "./github-transport-doubles";
import { StubCredentials } from "./stub-github-credentials";
import { writeRequests } from "./github-write-inventory";

/**
 * T3 lets a write leave `gh api` (issue #276). A write cannot be sent twice to
 * prove it, so what these tests pin is the routing itself: every request is classified as
 * exactly one of read, write, or stays-on-gh, a write only moves when the
 * launch asked for it, and no write can reach the read path by matching a read
 * label.
 */

function harness(options: {
  readonly writesOverHttp?: boolean;
  readonly http?: boolean;
}) {
  const executor = new RecordingGhExecutor(exited("{}"));
  const http = new RecordingHttpTransport(ok({ id: 9 }));
  const runner = new GhRequestRunner(
    new CommandRunner(executor),
    new StubCredentials(),
    options.http === false ? undefined : http,
    options.writesOverHttp ?? true,
  );
  return { executor, http, runner };
}

/** An allowlisted read, for the rows that check a write cannot borrow one's label. */
const issueComments: GitHubRestRequest = {
  kind: "rest",
  host: "github.com",
  path: "repos/centraldigital/patchdesk/issues/42/comments?per_page=100&page=1",
};

/** The three lookups that run inside a write flow. They are queries and stay on gh (ADR 0046). */
const writeFlowLookups: ReadonlyArray<readonly [string, GitHubGraphQlRequest]> =
  [
    [
      "api graphql ReviewThreadTarget",
      {
        kind: "graphql",
        host: "github.com",
        document: reviewThreadTargetQuery,
        variables: [{ kind: "typed", name: "id", value: "PRRT_1" }],
      },
    ],
    [
      "api graphql ReviewCommentTarget",
      {
        kind: "graphql",
        host: "github.com",
        document: reviewCommentTargetQuery,
        variables: [{ kind: "typed", name: "id", value: "PRRC_1" }],
      },
    ],
    [
      "api graphql ConfirmCreatedCommentThread",
      {
        kind: "graphql",
        host: "github.com",
        document: confirmCreatedCommentThreadQuery,
        variables: [{ kind: "typed", name: "number", value: 42 }],
      },
    ],
  ];

describe("isReadRequest", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly request: GitHubRequest;
    readonly read: boolean;
  }> = [
    {
      name: "a plain REST GET",
      request: { kind: "rest", host: "github.com", path: "user" },
      read: true,
    },
    {
      name: "a REST GET that asks for a media type",
      request: {
        kind: "rest",
        host: "github.com",
        path: "repos/o/r/compare/a...b",
        accept: "application/vnd.github.v3.diff",
      },
      read: true,
    },
    {
      name: "a paginated REST GET",
      request: {
        kind: "rest",
        host: "github.com",
        path: "repos/o/r/pulls/42/commits",
        paginate: true,
      },
      read: true,
    },
    {
      name: "a REST request with a method",
      request: {
        kind: "rest",
        host: "github.com",
        method: "POST",
        path: "repos/o/r/pulls/42/reviews",
      },
      read: false,
    },
    {
      // `gh api --input` defaults to POST, so a body with no method is a write.
      name: "a REST request carrying a body but no method",
      request: {
        kind: "rest",
        host: "github.com",
        path: "repos/o/r/pulls/42/reviews",
        jsonBody: '{"event":"COMMENT"}',
      },
      read: false,
    },
    {
      name: "a named GraphQL query",
      request: {
        kind: "graphql",
        host: "github.com",
        document: "query PullRequestThreads($owner: String!) { viewer { id } }",
        variables: [],
      },
      read: true,
    },
    {
      name: "a GraphQL query behind a comment",
      request: {
        kind: "graphql",
        host: "github.com",
        document:
          "\n  # the thread this comment belongs to\n  query { viewer { id } }",
        variables: [],
      },
      read: true,
    },
    {
      name: "an anonymous GraphQL selection set",
      request: {
        kind: "graphql",
        host: "github.com",
        document: "{ viewer { id } }",
        variables: [],
      },
      read: true,
    },
    {
      name: "a GraphQL mutation",
      request: {
        kind: "graphql",
        host: "github.com",
        document: "mutation { addComment(input: {}) { clientMutationId } }",
        variables: [],
      },
      read: false,
    },
  ];

  it.each(cases)("reads $name: $read", ({ request, read }) => {
    expect(isReadRequest(request)).toBe(read);
  });
});

describe("transportRouteFor classifies every request kind", () => {
  const rows: ReadonlyArray<{
    readonly name: string;
    readonly request: GitHubRequest;
    readonly withWrites: GitHubTransportRoute;
    readonly withoutWrites: GitHubTransportRoute;
  }> = [
    {
      name: "an allowlisted read",
      request: issueComments,
      withWrites: "http_read",
      withoutWrites: "http_read",
    },
    {
      name: "a read the allowlist does not name",
      request: {
        kind: "rest",
        host: "github.com",
        path: "repos/centraldigital/patchdesk/pulls?state=open",
      },
      withWrites: "gh",
      withoutWrites: "gh",
    },
    {
      name: "an allowlisted REST write",
      request: {
        kind: "rest",
        host: "github.com",
        method: "POST",
        path: "repos/centraldigital/patchdesk/pulls/42/comments",
        jsonBody: '{"body":"note"}',
      },
      withWrites: "http_write",
      withoutWrites: "gh",
    },
    {
      name: "a REST write the allowlist does not name",
      request: {
        kind: "rest",
        host: "github.com",
        method: "POST",
        path: "repos/centraldigital/patchdesk/issues/42/comments",
        jsonBody: '{"body":"note"}',
      },
      withWrites: "gh",
      withoutWrites: "gh",
    },
    {
      // `gh api --input -` without `--method` is a POST, so this is a write
      // even though `normalizeCommandLabel` prints it with a GET method.
      name: "a REST body with no method, whose label is an allowlisted read",
      request: { ...issueComments, jsonBody: '{"body":"note"}' },
      withWrites: "gh",
      withoutWrites: "gh",
    },
    {
      name: "a REST body with no method, whose POST label is allowlisted",
      request: {
        kind: "rest",
        host: "github.com",
        path: "repos/centraldigital/patchdesk/pulls/42/comments",
        jsonBody: '{"body":"note"}',
      },
      withWrites: "http_write",
      withoutWrites: "gh",
    },
    {
      name: "an allowlisted mutation",
      request: {
        kind: "graphql",
        host: "github.com",
        document: addLabelsToLabelableMutation,
        variables: [
          { kind: "typed", name: "labelableId", value: "PR_1" },
          { kind: "list", name: "labelIds", values: ["LA_1"] },
        ],
      },
      withWrites: "http_write",
      withoutWrites: "gh",
    },
    {
      name: "a mutation named after an allowlisted read",
      request: {
        kind: "graphql",
        host: "github.com",
        document:
          "mutation MergePolicy($id: ID!) { mergePullRequest(input: { pullRequestId: $id }) { clientMutationId } }",
        variables: [{ kind: "typed", name: "id", value: "PR_1" }],
      },
      withWrites: "gh",
      withoutWrites: "gh",
    },
  ];

  it.each(rows)("routes $name", ({ request, withWrites, withoutWrites }) => {
    expect(transportRouteFor(request, true)).toBe(withWrites);
    expect(transportRouteFor(request, false)).toBe(withoutWrites);
  });

  it.each(writeFlowLookups)(
    "leaves %s, which runs inside a write flow, on gh as a query",
    (label, request) => {
      expect(transportRouteFor(request, true)).toBe("gh");
      expect(httpServedReadLabels.has(label)).toBe(false);
      expect(httpServedWriteLabels.has(label)).toBe(false);
    },
  );
});

describe("httpServedWriteLabels and httpServedReadLabels are disjoint", () => {
  it("shares no label between the two allowlists", () => {
    const shared = [...httpServedWriteLabels].filter((label) =>
      httpServedReadLabels.has(label),
    );

    expect(shared).toEqual([]);
  });

  it("names a label for every write the adapter can send", () => {
    const labels = writeRequests().map((write) => write.label);

    expect(new Set(labels)).toEqual(httpServedWriteLabels);
  });
});

describe("routing a write to the HTTP transport", () => {
  const writes = writeRequests();

  it.each(writes)(
    "serves $name over HTTP when the launch switched writes on",
    async ({ request }) => {
      const { executor, http, runner } = harness({});

      await runner.ghJson(profile, request);

      expect(http.requests).toEqual([request]);
      expect(executor.labels).toEqual([]);
    },
  );

  it.each(writes)(
    "leaves $name on gh by default",
    async ({ request, label }) => {
      const { executor, http, runner } = harness({ writesOverHttp: false });

      await runner.ghJson(profile, request);

      expect(http.requests).toEqual([]);
      // Every inventory row names its method explicitly, so the gh argv and
      // the write routing print the same label for it.
      expect(executor.labels).toEqual([label]);
    },
  );

  it("leaves every write on gh when no HTTP transport was supplied", async () => {
    const { executor, http, runner } = harness({ http: false });

    await runner.ghJson(profile, {
      kind: "rest",
      host: "github.com",
      method: "POST",
      path: "repos/centraldigital/patchdesk/pulls/42/comments",
      jsonBody: '{"body":"note"}',
    });

    expect(http.requests).toEqual([]);
    expect(executor.labels).toEqual([
      "api POST repos/:owner/:repo/pulls/:n/comments",
    ]);
  });

  it("returns the HTTP failure without trying gh after it", async () => {
    const executor = new RecordingGhExecutor(exited("{}"));
    const runner = new GhRequestRunner(
      new CommandRunner(executor),
      new StubCredentials(),
      new RecordingHttpTransport(err({ _tag: "CommandUnavailable" })),
      true,
    );

    await expect(
      runner.ghJson(profile, {
        kind: "rest",
        host: "github.com",
        method: "PUT",
        path: "repos/centraldigital/patchdesk/pulls/42/merge",
        jsonBody: '{"sha":"abc"}',
      }),
    ).resolves.toEqual(err({ _tag: "CommandUnavailable" }));
    expect(executor.labels).toEqual([]);
  });

  it("reads a text write's answer through the transport's text seam", async () => {
    const { http, runner } = harness({});

    await expect(
      runner.ghText(profile, {
        kind: "rest",
        host: "github.com",
        method: "DELETE",
        path: "repos/centraldigital/patchdesk/pulls/comments/77",
      }),
    ).resolves.toEqual(ok(""));
    expect(http.requests).toHaveLength(1);
  });
});
