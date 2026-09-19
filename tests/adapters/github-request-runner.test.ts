import { describe, expect, it } from "vitest";

import { GhRequestRunner } from "../../src/adapters/github/gh-request-runner";
import {
  confirmCreatedCommentThreadQuery,
  reviewCommentTargetQuery,
  reviewThreadTargetQuery,
  watchedPullRequestsQuery,
} from "../../src/adapters/github/github-graphql-queries";
import type {
  GitHubGraphQlRequest,
  GitHubRestRequest,
} from "../../src/adapters/github/github-request";
import { err, ok } from "../../src/domain/result";
import { profile } from "./github-http-fixture-server";
import {
  labelFor,
  routedTransport,
  type CannedAnswer,
} from "./github-transport-doubles";
import { writeRequests } from "./github-write-inventory";

/**
 * T4 left the runner with one transport and no routing (issue #276): every
 * request goes to the HTTP client. What is still its own is which of the
 * client's three seams a request reaches, and that a GraphQL answer read as
 * text fails rather than changing shape.
 */

function runnerWith(answer: CannedAnswer = "{}") {
  const transport = routedTransport(() => answer);
  return { transport, runner: new GhRequestRunner(transport) };
}

const openPullRequests: GitHubRestRequest = {
  kind: "rest",
  host: "github.com",
  path: "repos/octo-org/patchdesk/pulls?state=open&per_page=100",
};

const reviewThreadTarget: GitHubGraphQlRequest = {
  kind: "graphql",
  host: "github.com",
  document: reviewThreadTargetQuery,
  variables: [{ kind: "typed", name: "id", value: "PRRT_1" }],
};

/** The reads that had no comparison window before T4 and moved with it. */
const lateReads: ReadonlyArray<readonly [string, GitHubRestRequest]> = [
  ["api GET repos/:owner/:repo/pulls", openPullRequests],
  [
    "api GET repos/:owner/:repo/contents/:path",
    {
      kind: "rest",
      host: "github.com",
      path: "repos/octo-org/patchdesk/contents/src/app.ts?ref=main",
    },
  ],
];

/** The queries that run inside a write flow, plus the watched-pull-request poll. */
const lateQueries: ReadonlyArray<readonly [string, GitHubGraphQlRequest]> = [
  ["api graphql ReviewThreadTarget", reviewThreadTarget],
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
  [
    "api graphql WatchedPullRequests",
    {
      kind: "graphql",
      host: "github.com",
      document: watchedPullRequestsQuery(1),
      variables: [
        { kind: "string", name: "owner0", value: "octo-org" },
        { kind: "string", name: "name0", value: "patchdesk" },
        { kind: "typed", name: "number0", value: 42 },
      ],
    },
  ],
];

describe("every request the adapter can send goes to the HTTP transport", () => {
  it.each([...lateReads, ...lateQueries])(
    "sends %s unchanged",
    async (label, request) => {
      const { transport, runner } = runnerWith('{"data":null}');

      await runner.ghJson(profile, request);

      expect(transport.requests).toEqual([request]);
      expect(transport.labels).toEqual([label]);
    },
  );

  it.each(writeRequests())(
    "sends $name unchanged, under $label",
    async ({ request, label }) => {
      const { transport, runner } = runnerWith();

      await runner.ghJson(profile, request);

      expect(transport.requests).toEqual([request]);
      expect(transport.labels).toEqual([label]);
    },
  );
});

describe("which seam of the transport a request reaches", () => {
  it("parses a REST answer for a JSON caller", async () => {
    const { runner } = runnerWith('{"id":9}');

    await expect(runner.ghJson(profile, openPullRequests)).resolves.toEqual(
      ok({ id: 9 }),
    );
  });

  it("hands a REST answer over unparsed for a text caller", async () => {
    const { runner } = runnerWith("not json at all");

    await expect(runner.ghText(profile, openPullRequests)).resolves.toEqual(
      ok("not json at all"),
    );
  });

  it("fails a GraphQL answer read as text rather than changing its shape", async () => {
    const { runner } = runnerWith('{"data":null}');

    await expect(runner.ghText(profile, reviewThreadTarget)).resolves.toEqual(
      err({ _tag: "CommandFailed" }),
    );
  });

  it("returns the transport's failure as this call's failure", async () => {
    const { runner } = runnerWith({ _tag: "CommandUnavailable" });

    await expect(runner.ghJson(profile, openPullRequests)).resolves.toEqual(
      err({ _tag: "CommandUnavailable" }),
    );
  });
});

describe("the label one request is logged under", () => {
  it("names each write inventory row the label its call site expects", () => {
    const labels = writeRequests().map((write) => [
      write.name,
      labelFor(write.request),
    ]);

    expect(labels).toEqual(
      writeRequests().map((write) => [write.name, write.label]),
    );
  });
});
