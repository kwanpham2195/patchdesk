import { createServer } from "node:http";
import type { Socket } from "node:net";

import { describe, expect, it } from "vitest";

import { runWithRequestAbortSignal } from "../../src/adapters/github/command-runner";
import {
  gitHubApiOrigin,
  GitHubHttpClient,
  type GitHubHttpRequestRecord,
  type GitHubRateLimitObservation,
} from "../../src/adapters/github/github-http-client";
import {
  errorOf,
  json,
  portOf,
  profile,
  useFixtureServer,
} from "./github-http-fixture-server";
import { StubCredentials } from "./stub-github-credentials";

const fixture = useFixtureServer();

describe("gitHubApiOrigin", () => {
  it("prefixes github.com with the shared API host", () => {
    expect(gitHubApiOrigin("github.com")).toEqual({
      rest: "https://api.github.com",
      graphql: "https://api.github.com/graphql",
    });
  });

  it("prefixes a GitHub Enterprise Cloud tenant with its own api subdomain", () => {
    expect(gitHubApiOrigin("acme.ghe.com")).toEqual({
      rest: "https://api.acme.ghe.com",
      graphql: "https://api.acme.ghe.com/graphql",
    });
  });

  it("serves GitHub Enterprise Server from the host itself", () => {
    expect(gitHubApiOrigin("github.opn.example")).toEqual({
      rest: "https://github.opn.example/api/v3",
      graphql: "https://github.opn.example/api/graphql",
    });
  });
});

describe("GitHubHttpClient REST requests", () => {
  it("sends the profile account's credential as a bearer token", async () => {
    fixture.respondWith(json(200, { login: "octo-dev" }));
    const result = await fixture.client().rest(profile, {
      kind: "rest",
      host: "github.com",
      path: "user",
    });

    expect(result).toEqual({ _tag: "ok", value: { login: "octo-dev" } });
    expect(fixture.requests()[0]?.headers.authorization).toBe(
      "Bearer profile-token",
    );
    expect(fixture.requests()[0]?.method).toBe("GET");
    expect(fixture.requests()[0]?.url).toBe("/user");
  });

  it("sends a method and a JSON body as one request", async () => {
    fixture.respondWith(json(201, { id: 7 }));
    const result = await fixture.client().rest(profile, {
      kind: "rest",
      host: "github.com",
      method: "POST",
      path: "repos/octo-org/patchdesk/pulls/42/reviews",
      jsonBody: '{"commit_id":"abc"}',
    });

    expect(result).toEqual({ _tag: "ok", value: { id: 7 } });
    expect(fixture.requests()[0]?.method).toBe("POST");
    expect(fixture.requests()[0]?.body).toBe('{"commit_id":"abc"}');
    expect(fixture.requests()[0]?.headers["content-type"]).toBe(
      "application/json",
    );
  });

  /**
   * Which seam the caller took decides how the body is read, as `runText` and
   * `runJson` decided it for the same `gh api` stdout. The response's media
   * type does not: `discardPendingReview` reads a text answer GitHub sends as
   * JSON, and a JSON caller handed an unparseable 200 has to fail the way
   * `runJson` failed rather than answer with the prose.
   */
  it("answers a text caller with the response bytes whatever the media type", async () => {
    fixture.respondWith((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/vnd.github.v3.diff",
      });
      response.end("diff --git a/a.ts b/a.ts\n");
    });
    const result = await fixture.client().restText(profile, {
      kind: "rest",
      host: "github.com",
      accept: "application/vnd.github.v3.diff",
      path: "repos/octo-org/patchdesk/compare/base...head",
    });

    expect(result).toEqual({ _tag: "ok", value: "diff --git a/a.ts b/a.ts\n" });
    expect(fixture.requests()[0]?.headers.accept).toBe(
      "application/vnd.github.v3.diff",
    );
  });

  it("answers a text caller's empty 204 with an empty body", async () => {
    fixture.respondWith((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const result = await fixture.client().restText(profile, {
      kind: "rest",
      host: "github.com",
      method: "DELETE",
      path: "repos/octo-org/patchdesk/pulls/comments/9",
    });

    expect(result).toEqual({ _tag: "ok", value: "" });
  });

  it("answers a text caller with a JSON body unparsed", async () => {
    fixture.respondWith(json(200, { id: 9, state: "PENDING" }));
    const result = await fixture.client().restText(profile, {
      kind: "rest",
      host: "github.com",
      method: "DELETE",
      path: "repos/octo-org/patchdesk/pulls/42/reviews/9",
    });

    expect(result).toEqual({
      _tag: "ok",
      value: '{"id":9,"state":"PENDING"}',
    });
  });

  it("fails a JSON caller's empty 204 the way runJson failed on empty stdout", async () => {
    fixture.respondWith((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const result = await fixture.client().rest(profile, {
      kind: "rest",
      host: "github.com",
      method: "DELETE",
      path: "repos/octo-org/patchdesk/pulls/42/reviews/9",
    });

    expect(errorOf(result)).toEqual({ _tag: "CommandInvalidJson" });
  });

  it("fails a JSON caller handed a non-JSON 200", async () => {
    fixture.respondWith((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<html>proxy</html>");
    });
    const result = await fixture.client().rest(profile, {
      kind: "rest",
      host: "github.com",
      path: "user",
    });

    expect(errorOf(result)).toEqual({ _tag: "CommandInvalidJson" });
  });

  it("follows every page and answers one array of pages", async () => {
    fixture.respondWith((request, response) => {
      if (request.url === "/repos/octo-org/patchdesk/pulls/42/commits") {
        response.writeHead(200, {
          "Content-Type": "application/json",
          Link: `<${fixture.origin().rest}/page2>; rel="next"`,
        });
        response.end('[{"sha":"a"}]');
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('[{"sha":"b"}]');
    });
    const result = await fixture.client().rest(profile, {
      kind: "rest",
      host: "github.com",
      paginate: true,
      path: "repos/octo-org/patchdesk/pulls/42/commits",
    });

    expect(result).toEqual({
      _tag: "ok",
      value: [[{ sha: "a" }], [{ sha: "b" }]],
    });
    expect(fixture.requests().map((entry) => entry.url)).toEqual([
      "/repos/octo-org/patchdesk/pulls/42/commits",
      "/page2",
    ]);
  });

  it("reports an unparseable JSON body as invalid JSON", async () => {
    fixture.respondWith((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{not json");
    });
    const result = await fixture.client().rest(profile, {
      kind: "rest",
      host: "github.com",
      path: "user",
    });

    expect(errorOf(result)).toEqual({ _tag: "CommandInvalidJson" });
  });

  /**
   * The TLS handshake this saves is about 90 ms of every call (ADR 0046). A
   * server of its own keeps the assertion exact: the connection pool is
   * process-wide, so a socket another test left open to the shared fixture
   * would be reused and hide a regression here.
   */
  it("opens one connection for a run of calls to the same host", async () => {
    let connections = 0;
    const sockets: Array<Socket> = [];
    const own = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    });
    own.on("connection", (socket: Socket) => {
      connections += 1;
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => {
      own.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${portOf(own)}`;
    const client = new GitHubHttpClient(
      new StubCredentials(),
      () => undefined,
      () => ({ rest: base, graphql: `${base}/graphql` }),
    );

    for (let call = 0; call < 5; call += 1) {
      await client.rest(profile, {
        kind: "rest",
        host: "github.com",
        path: "user",
      });
      // The pool hands a socket back a tick after the body ends; without this
      // a back-to-back call is dispatched onto a second connection.
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      own.close(() => resolve());
    });

    expect(connections).toBe(1);
  });
});

describe("GitHubHttpClient partial GraphQL responses", () => {
  const request = {
    kind: "graphql" as const,
    host: "github.com",
    document: "query WatchedPullRequests { viewer { login } }",
    variables: [],
  };

  it("returns data beside path-aware errors only for an opted-in caller", async () => {
    const body = {
      data: { viewer: null },
      errors: [{ type: "NOT_FOUND", path: ["viewer"], message: "missing" }],
    };
    fixture.respondWith(json(200, body));

    await expect(
      fixture
        .client()
        .graphql(profile, { ...request, acceptPathAwarePartialData: true }),
    ).resolves.toEqual({ _tag: "ok", value: body });
  });

  it("keeps the same partial response a failure for an ordinary caller", async () => {
    fixture.respondWith(
      json(200, {
        data: { viewer: null },
        errors: [{ type: "NOT_FOUND", path: ["viewer"], message: "missing" }],
      }),
    );

    expect(errorOf(await fixture.client().graphql(profile, request))).toEqual({
      _tag: "CommandNotFound",
    });
  });

  it("keeps a full GraphQL error a failure for an opted-in caller", async () => {
    fixture.respondWith(
      json(200, {
        errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }],
      }),
    );

    expect(
      errorOf(
        await fixture
          .client()
          .graphql(profile, { ...request, acceptPathAwarePartialData: true }),
      ),
    ).toEqual({ _tag: "CommandForbidden", reason: "unknown" });
  });
});

describe("GitHubHttpClient response size", () => {
  it("stops reading a body larger than the buffer cap", async () => {
    fixture.respondWith((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      for (let written = 0; written < 3; written += 1)
        response.write(Buffer.alloc(1024 * 1024, "a"));
      response.end();
    });
    const result = await fixture.client().rest(profile, {
      kind: "rest",
      host: "github.com",
      path: "repos/octo-org/patchdesk/pulls/42/files",
    });

    expect(errorOf(result)).toEqual({ _tag: "CommandFailed" });
  });
});

describe("GitHubHttpClient cancellation", () => {
  it("reports a caller's abort during the call as aborted", async () => {
    fixture.respondWith((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
      }, 500);
    });
    const controller = new AbortController();
    const pending = fixture
      .client()
      .rest(
        profile,
        { kind: "rest", host: "github.com", path: "user" },
        controller.signal,
      );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    expect(errorOf(await pending)).toEqual({ _tag: "CommandAborted" });
  });

  it("reports the ambient request signal's abort as aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runWithRequestAbortSignal(controller.signal, () =>
      fixture.client().rest(profile, {
        kind: "rest",
        host: "github.com",
        path: "user",
      }),
    );

    expect(errorOf(result)).toEqual({ _tag: "CommandAborted" });
  });

  it("lets a caller's signal win over an already-aborted ambient one", async () => {
    const ambient = new AbortController();
    ambient.abort();
    const caller = new AbortController();
    const result = await runWithRequestAbortSignal(ambient.signal, () =>
      fixture
        .client()
        .rest(
          profile,
          { kind: "rest", host: "github.com", path: "user" },
          caller.signal,
        ),
    );

    expect(result).toEqual({ _tag: "ok", value: {} });
  });
});

describe("GitHubHttpClient rate-limit headers", () => {
  it("reports the remaining quota and its reset instant", async () => {
    fixture.respondWith(
      json(
        200,
        {},
        { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1780000000" },
      ),
    );
    const observed: Array<GitHubRateLimitObservation> = [];
    await fixture
      .client(new StubCredentials(), (observation) =>
        observed.push(observation),
      )
      .rest(profile, { kind: "rest", host: "github.com", path: "user" });

    expect(observed).toEqual([
      {
        host: "github.com",
        remaining: 0,
        resetAt: new Date(1_780_000_000_000).toISOString(),
      },
    ]);
  });

  it("reports retry-after from a secondary rate limit, which carries no reset", async () => {
    fixture.respondWith(
      json(429, { message: "Too many requests" }, { "Retry-After": "60" }),
    );
    const observed: Array<GitHubRateLimitObservation> = [];
    await fixture
      .client(new StubCredentials(), (observation) =>
        observed.push(observation),
      )
      .rest(profile, { kind: "rest", host: "github.com", path: "user" });

    expect(observed).toEqual([{ host: "github.com", retryAfterSeconds: 60 }]);
  });

  it("stays silent when a response carries no rate-limit header", async () => {
    const observed: Array<GitHubRateLimitObservation> = [];
    await fixture
      .client(new StubCredentials(), (observation) =>
        observed.push(observation),
      )
      .rest(profile, { kind: "rest", host: "github.com", path: "user" });

    expect(observed).toEqual([]);
  });
});

/**
 * The main process injects Electron's `net.fetch` here, so that Chromium's
 * stack — the system proxy and the system trust store — carries the request
 * (ADR 0046). This is the seam that makes it possible without `src/adapters`
 * importing Electron.
 */
describe("GitHubHttpClient injected fetch", () => {
  it("sends the request through the fetch it was given", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new GitHubHttpClient(
      new StubCredentials(),
      () => undefined,
      () => ({ rest: "https://api.example", graphql: "https://api.example" }),
      async (url, init) => {
        calls.push({ url, init });
        return new Response('{"login":"octo-dev"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );

    const result = await client.rest(profile, {
      kind: "rest",
      host: "github.com",
      path: "user",
    });

    expect(result).toEqual({ _tag: "ok", value: { login: "octo-dev" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example/user");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer profile-token",
    );
  });
});

/**
 * A read served over HTTPS spawns nothing, so `scripts/gh-spawn-report.mjs`
 * reads these entries where it used to read a `command-spawn` (issue #276).
 */
describe("GitHubHttpClient request records", () => {
  function recordingClient(
    records: Array<GitHubHttpRequestRecord>,
  ): GitHubHttpClient {
    return new GitHubHttpClient(
      new StubCredentials(),
      undefined,
      () => fixture.origin(),
      undefined,
      (record) => records.push(record),
    );
  }

  it("records one request under the label the gh path would have logged", async () => {
    const records: Array<GitHubHttpRequestRecord> = [];
    fixture.respondWith(json(200, { login: "octo-dev" }));

    await recordingClient(records).rest(profile, {
      kind: "rest",
      host: "github.com",
      path: "user",
    });

    expect(records).toEqual([
      { label: "api GET user", status: 200, durationMs: expect.any(Number) },
    ]);
  });

  it("records a GraphQL request under its operation name", async () => {
    const records: Array<GitHubHttpRequestRecord> = [];
    fixture.respondWith(json(200, { data: { viewer: { id: "1" } } }));

    await recordingClient(records).graphql(profile, {
      kind: "graphql",
      host: "github.com",
      document: "query MergePolicy { viewer { id } }",
      variables: [],
    });

    expect(records.map((record) => record.label)).toEqual([
      "api graphql MergePolicy",
    ]);
  });

  it("records every page of a paginated read", async () => {
    const records: Array<GitHubHttpRequestRecord> = [];
    fixture.respondWith((request, response) => {
      if (request.url === "/repos/octo-org/patchdesk/pulls/42/commits") {
        response.writeHead(200, {
          "Content-Type": "application/json",
          Link: `<${fixture.origin().rest}/page2>; rel="next"`,
        });
        response.end("[]");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("[]");
    });

    await recordingClient(records).rest(profile, {
      kind: "rest",
      host: "github.com",
      paginate: true,
      path: "repos/octo-org/patchdesk/pulls/42/commits",
    });

    expect(records.map((record) => record.label)).toEqual([
      "api GET repos/:owner/:repo/pulls/:n/commits",
      "api GET repos/:owner/:repo/pulls/:n/commits",
    ]);
  });

  it("records a request that never got a response with no status", async () => {
    const records: Array<GitHubHttpRequestRecord> = [];
    const client = new GitHubHttpClient(
      new StubCredentials(),
      undefined,
      () => fixture.origin(),
      async () => {
        throw new Error("connection reset");
      },
      (record) => records.push(record),
    );

    const result = await client.rest(profile, {
      kind: "rest",
      host: "github.com",
      path: "user",
    });

    expect(result).toEqual({
      _tag: "err",
      error: { _tag: "CommandUnavailable" },
    });
    expect(records.map((record) => record.status)).toEqual([0]);
  });
});
