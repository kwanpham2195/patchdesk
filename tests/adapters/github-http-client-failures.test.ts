import { describe, expect, it, vi } from "vitest";

import type { CommandFailure } from "../../src/adapters/github/command-runner";
import { commandTimeoutMs } from "../../src/adapters/github/gh-request-runner";
import { GitHubHttpClient } from "../../src/adapters/github/github-http-client";
import {
  errorOf,
  json,
  profile,
  useFixtureServer,
} from "./github-http-fixture-server";
import { StubCredentials } from "./stub-github-credentials";

const fixture = useFixtureServer();

describe("GitHubHttpClient status classification", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly status: number;
    readonly message: string;
    readonly expected: CommandFailure;
  }> = [
    {
      name: "401 is an authentication failure",
      status: 401,
      message: "Bad credentials",
      expected: { _tag: "CommandAuthenticationRequired" },
    },
    {
      name: "403 naming the rate limit is rate limited, not forbidden",
      status: 403,
      message: "API rate limit exceeded for user ID 1.",
      expected: { _tag: "CommandRateLimited" },
    },
    {
      name: "403 naming an IP allow list is attributed to it",
      status: 403,
      message:
        "Although you appear to have the correct authorization credentials, the organization has an IP allow list enabled.",
      expected: { _tag: "CommandForbidden", reason: "ip_allow_list" },
    },
    {
      name: "403 with no attributable reason is forbidden for an unknown reason",
      status: 403,
      message: "Resource not accessible by integration",
      expected: { _tag: "CommandForbidden", reason: "unknown" },
    },
    {
      name: "404 is not found",
      status: 404,
      message: "Not Found",
      expected: { _tag: "CommandNotFound" },
    },
    {
      name: "405 is unsupported",
      status: 405,
      message: "Method not allowed",
      expected: { _tag: "CommandUnsupported" },
    },
    {
      name: "415 is unsupported",
      status: 415,
      message: "Unsupported media type",
      expected: { _tag: "CommandUnsupported" },
    },
    {
      name: "422 naming the pending review constraint is a pending review",
      status: 422,
      message: "User can only have one pending review per pull request",
      expected: { _tag: "CommandPendingReview" },
    },
    {
      name: "422 for any other validation failure is unsupported",
      status: 422,
      message: "Validation Failed",
      expected: { _tag: "CommandUnsupported" },
    },
    {
      name: "429 is rate limited",
      status: 429,
      message: "Too many requests",
      expected: { _tag: "CommandRateLimited" },
    },
    {
      name: "501 is unsupported",
      status: 501,
      message: "Not implemented",
      expected: { _tag: "CommandUnsupported" },
    },
  ];

  it.each(cases)("$name", async ({ status, message, expected }) => {
    fixture.respondWith(json(status, { message, status: String(status) }));
    const result = await fixture.client().rest(profile, {
      kind: "rest",
      host: "github.com",
      path: "user",
    });

    expect(errorOf(result)).toEqual(expected);
  });

  it("drops the rejected credential so the next call re-reads it", async () => {
    fixture.respondWith(json(401, { message: "Bad credentials" }));
    const credentials = new StubCredentials();
    await fixture.client(credentials).rest(profile, {
      kind: "rest",
      host: "github.com",
      path: "user",
    });

    expect(credentials.forgotten).toEqual(["octo-dev"]);
  });

  it("reports an unmapped 4xx as a rejection carrying GitHub's message", async () => {
    fixture.respondWith(json(400, { message: "Problems parsing JSON" }));
    const result = await fixture.client().rest(profile, {
      kind: "rest",
      host: "github.com",
      path: "user",
    });

    expect(errorOf(result)._tag).toBe("CommandFailed");
  });
});

/**
 * The write path turns `CommandFailed` into `rejected`, which removes a write
 * intent, and everything else into `unavailable`, which locks the review for
 * reconciliation (`github-write-failures.ts`, ADR 0035). A mutation that may
 * already have landed must never reach the first branch.
 */
describe("GitHubHttpClient never reports a transport failure as a rejection", () => {
  it.each([500, 502, 503, 504])(
    "classifies %i as unavailable",
    async (status) => {
      fixture.respondWith(json(status, { message: "Server Error" }));
      const result = await fixture.client().rest(profile, {
        kind: "rest",
        host: "github.com",
        method: "POST",
        path: "repos/octo-org/patchdesk/pulls/42/reviews",
        jsonBody: "{}",
      });

      expect(errorOf(result)).toEqual({ _tag: "CommandUnavailable" });
    },
  );

  it("classifies a connection dropped mid-response as unavailable", async () => {
    fixture.respondWith((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": "64",
      });
      response.write("{");
      response.socket?.destroy();
    });
    const result = await fixture.client().rest(profile, {
      kind: "rest",
      host: "github.com",
      method: "POST",
      path: "repos/octo-org/patchdesk/pulls/42/reviews",
      jsonBody: "{}",
    });

    expect(errorOf(result)).toEqual({ _tag: "CommandUnavailable" });
  });

  it("classifies a refused connection as unavailable", async () => {
    const unreachable = new GitHubHttpClient(
      new StubCredentials(),
      () => undefined,
      () => ({
        rest: "http://127.0.0.1:1",
        graphql: "http://127.0.0.1:1/graphql",
      }),
    );
    const result = await unreachable.rest(profile, {
      kind: "rest",
      host: "github.com",
      path: "user",
    });

    expect(errorOf(result)).toEqual({ _tag: "CommandUnavailable" });
  });

  it("classifies a response that never arrives as timed out", async () => {
    fixture.respondWith(() => undefined);
    vi.useFakeTimers();
    const pending = fixture.client().rest(profile, {
      kind: "rest",
      host: "github.com",
      path: "user",
    });
    await vi.advanceTimersByTimeAsync(commandTimeoutMs);
    const result = await pending;

    expect(errorOf(result)).toEqual({ _tag: "CommandTimedOut" });
  });
});

describe("GitHubHttpClient GraphQL requests", () => {
  it("posts the document and its variables, inferring each variable's type as gh did", async () => {
    fixture.respondWith(json(200, { data: { repository: { id: "R_1" } } }));
    const result = await fixture.client().graphql(profile, {
      kind: "graphql",
      host: "github.com",
      document: "query Repo($owner: String!) { repository { id } }",
      variables: [
        { kind: "typed", name: "owner", value: "octo-org" },
        { kind: "typed", name: "number", value: 42 },
        { kind: "string", name: "baseRefName", value: "2024" },
        { kind: "list", name: "ids", values: ["MDQ6VXNlcjE=", "MDQ6VXNlcjI="] },
      ],
    });

    expect(result).toEqual({
      _tag: "ok",
      value: { data: { repository: { id: "R_1" } } },
    });
    expect(fixture.requests()[0]?.url).toBe("/graphql");
    expect(JSON.parse(fixture.requests()[0]?.body ?? "")).toEqual({
      query: "query Repo($owner: String!) { repository { id } }",
      variables: {
        owner: "octo-org",
        number: 42,
        baseRefName: "2024",
        ids: ["MDQ6VXNlcjE=", "MDQ6VXNlcjI="],
      },
    });
  });

  // What a 200 carrying `errors` means on both transports is pinned in
  // `github-graphql-errors.test.ts`, which asserts gh's tag for each body.

  it("classifies a GraphQL 5xx as unavailable", async () => {
    fixture.respondWith(json(502, { message: "Bad gateway" }));
    const result = await fixture.client().graphql(profile, {
      kind: "graphql",
      host: "github.com",
      document: "mutation { addComment { id } }",
      variables: [],
    });

    expect(errorOf(result)).toEqual({ _tag: "CommandUnavailable" });
  });
});
