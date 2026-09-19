import { createServer } from "node:http";
import type { Socket } from "node:net";

import { describe, expect, it } from "vitest";

import { runWithRequestAbortSignal } from "../../src/adapters/github/command-runner";
import {
  gitHubApiOrigin,
  GitHubHttpClient,
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
    fixture.respondWith(json(200, { login: "pmquan2cfw" }));
    const result = await fixture.client().rest(profile, {
      kind: "rest",
      host: "github.com",
      path: "user",
    });

    expect(result).toEqual({ _tag: "ok", value: { login: "pmquan2cfw" } });
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
      path: "repos/centraldigital/patchdesk/pulls/42/reviews",
      jsonBody: '{"commit_id":"abc"}',
    });

    expect(result).toEqual({ _tag: "ok", value: { id: 7 } });
    expect(fixture.requests()[0]?.method).toBe("POST");
    expect(fixture.requests()[0]?.body).toBe('{"commit_id":"abc"}');
    expect(fixture.requests()[0]?.headers["content-type"]).toBe(
      "application/json",
    );
  });

  it("answers a non-JSON media type with the response text", async () => {
    fixture.respondWith((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/vnd.github.v3.diff",
      });
      response.end("diff --git a/a.ts b/a.ts\n");
    });
    const result = await fixture.client().rest(profile, {
      kind: "rest",
      host: "github.com",
      accept: "application/vnd.github.v3.diff",
      path: "repos/centraldigital/patchdesk/compare/base...head",
    });

    expect(result).toEqual({ _tag: "ok", value: "diff --git a/a.ts b/a.ts\n" });
    expect(fixture.requests()[0]?.headers.accept).toBe(
      "application/vnd.github.v3.diff",
    );
  });

  it("answers an empty 204 with an empty body", async () => {
    fixture.respondWith((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const result = await fixture.client().rest(profile, {
      kind: "rest",
      host: "github.com",
      method: "DELETE",
      path: "repos/centraldigital/patchdesk/pulls/42/reviews/9",
    });

    expect(result).toEqual({ _tag: "ok", value: "" });
  });

  it("follows every page and answers one array of pages", async () => {
    fixture.respondWith((request, response) => {
      if (request.url === "/repos/centraldigital/patchdesk/pulls/42/commits") {
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
      path: "repos/centraldigital/patchdesk/pulls/42/commits",
    });

    expect(result).toEqual({
      _tag: "ok",
      value: [[{ sha: "a" }], [{ sha: "b" }]],
    });
    expect(fixture.requests().map((entry) => entry.url)).toEqual([
      "/repos/centraldigital/patchdesk/pulls/42/commits",
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
      path: "repos/centraldigital/patchdesk/pulls/42/files",
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
