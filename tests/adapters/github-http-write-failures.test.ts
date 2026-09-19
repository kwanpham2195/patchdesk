import { describe, expect, it, vi } from "vitest";

import { runWithRequestAbortSignal } from "../../src/adapters/github/command-runner";
import { commandTimeoutMs } from "../../src/adapters/github/gh-request-runner";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import { GitHubHttpClient } from "../../src/adapters/github/github-http-client";
import type { GitHubWriteFailure } from "../../src/domain/github-write";
import { parseGitHubThreadId } from "../../src/domain/ids";
import {
  json,
  profile,
  useFixtureServer,
  type Handler,
} from "./github-http-fixture-server";
import { noChildProcesses } from "./github-transport-doubles";
import { mustParse, pr, writeAdapter } from "./github-write-shape";
import { StubCredentials } from "./stub-github-credentials";

/**
 * How a failed write classifies on the HTTP transport (issue #276, step T3).
 *
 * The rule the whole write cutover rests on: `rejected` removes the write
 * intent, so it is only safe when GitHub refused and nothing happened (ADR
 * 0035). Anything that cannot prove a refusal — a dropped socket, a 5xx, an
 * elapsed deadline, a success body that did not parse — must keep the Review
 * locked as `unavailable` instead, because the mutation may already have
 * landed.
 *
 * Every row below comes from a real HTTP response or a real socket condition
 * on the loopback server.
 */

const server = useFixtureServer();
const threadId = mustParse(parseGitHubThreadId("PRRT_kwDOabc123"));
const commentId = "2412345678";

type WriteCategory = GitHubWriteFailure["category"];

/** One REST write over HTTP: the comment edit, which reads its answer as JSON. */
async function restWrite(handler: Handler): Promise<GitHubWriteFailure> {
  server.respondWith(handler);
  const result = await writeAdapter(server).updateReviewComment({
    profile,
    pr,
    commentId,
    body: "edited",
  });
  if (result._tag !== "err") throw new Error("Expected a failed write");
  return result.error;
}

/** One GraphQL write over HTTP: the resolve mutation. */
async function mutationWrite(handler: Handler): Promise<GitHubWriteFailure> {
  server.respondWith(handler);
  const result = await writeAdapter(server).setReviewThreadState({
    profile,
    threadId,
    state: "resolved",
  });
  if (result._tag !== "err") throw new Error("Expected a failed write");
  return result.error;
}

describe("a REST status on a write is the category that status means", () => {
  const statuses: ReadonlyArray<{
    readonly name: string;
    readonly status: number;
    readonly message: string;
    readonly expected: WriteCategory;
  }> = [
    {
      name: "401",
      status: 401,
      message: "Bad credentials",
      expected: "auth",
    },
    {
      name: "403 with no attributable reason",
      status: 403,
      message: "Resource not accessible by integration",
      expected: "forbidden",
    },
    {
      name: "403 naming the rate limit",
      status: 403,
      message: "API rate limit exceeded for user ID 1.",
      expected: "rate_limited",
    },
    {
      name: "404",
      status: 404,
      message: "Not Found",
      expected: "unavailable",
    },
    {
      name: "409",
      status: 409,
      message: "Head branch was modified. Review and try the merge again.",
      expected: "unavailable",
    },
    {
      name: "422 validation",
      status: 422,
      message: "Validation Failed",
      expected: "unavailable",
    },
    {
      name: "422 naming the one-pending-review constraint",
      status: 422,
      message:
        "User can only have one pending review per pull request. Submit or discard your pending review before submitting another.",
      expected: "pending_review",
    },
    {
      name: "429",
      status: 429,
      message: "You have exceeded a secondary rate limit.",
      expected: "rate_limited",
    },
    {
      name: "500",
      status: 500,
      message: "Internal Server Error",
      expected: "unavailable",
    },
    {
      name: "502",
      status: 502,
      message: "Bad Gateway",
      expected: "unavailable",
    },
    {
      name: "503",
      status: 503,
      message: "Service Unavailable",
      expected: "unavailable",
    },
    {
      name: "504",
      status: 504,
      message: "Gateway Timeout",
      expected: "unavailable",
    },
  ];

  it.each(statuses)(
    "classifies $name as $expected",
    async ({ status, message, expected }) => {
      const failure = await restWrite(
        json(status, { message, status: String(status) }),
      );

      expect(failure.category).toBe(expected);
      expect(failure.category).not.toBe("rejected");
    },
  );
});

describe("a GraphQL error on a write is the category its type means", () => {
  const errors: ReadonlyArray<{
    readonly type: string;
    readonly message: string;
    readonly expected: WriteCategory;
  }> = [
    {
      type: "FORBIDDEN",
      message: "Resource not accessible by personal access token",
      expected: "forbidden",
    },
    {
      type: "NOT_FOUND",
      message: "Could not resolve to a node with the global id of 'PRRT_1'.",
      expected: "unavailable",
    },
    {
      type: "UNPROCESSABLE",
      message: "The thread is already resolved.",
      expected: "unavailable",
    },
    // gh reached this through the rate-limit phrase in its own stderr; the
    // HTTP transport has no stderr, so the structural type is its only signal.
    {
      type: "RATE_LIMITED",
      message: "API rate limit exceeded",
      expected: "rate_limited",
    },
    {
      type: "INTERNAL",
      message: "Something went wrong while executing your query.",
      expected: "unavailable",
    },
  ];

  it.each(errors)(
    "classifies a $type error as $expected",
    async ({ type, message, expected }) => {
      const failure = await mutationWrite(
        json(200, { data: null, errors: [{ type, message }] }),
      );

      expect(failure.category).toBe(expected);
      expect(failure.category).not.toBe("rejected");
    },
  );
});

/**
 * None of these can prove GitHub refused, so none may be `rejected`: each one
 * leaves the write's outcome unknown and the Review locked for reconciliation.
 */
describe("a write whose outcome GitHub never reported is unavailable", () => {
  it("classifies a connection reset before any response byte", async () => {
    const failure = await restWrite((request) => request.socket.destroy());

    expect(failure.category).toBe("unavailable");
  });

  it("classifies a connection reset partway through the body", async () => {
    const failure = await restWrite((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": "64",
      });
      response.write("{");
      response.socket?.destroy();
    });

    expect(failure.category).toBe("unavailable");
  });

  it("classifies a refused connection", async () => {
    const credentials = new StubCredentials();
    const unreachable = new GitHubAdapter(
      noChildProcesses(),
      credentials,
      new GitHubHttpClient(
        credentials,
        () => undefined,
        () => ({
          rest: "http://127.0.0.1:1",
          graphql: "http://127.0.0.1:1/graphql",
        }),
      ),
    );

    const result = await unreachable.updateReviewComment({
      profile,
      pr,
      commentId,
      body: "edited",
    });

    expect(result).toMatchObject({
      _tag: "err",
      error: { category: "unavailable" },
    });
  });

  it("classifies the client's own deadline elapsing", async () => {
    server.respondWith(() => undefined);
    vi.useFakeTimers();
    const pending = writeAdapter(server).updateReviewComment({
      profile,
      pr,
      commentId,
      body: "edited",
    });
    await vi.advanceTimersByTimeAsync(commandTimeoutMs);

    expect(await pending).toMatchObject({
      _tag: "err",
      error: { category: "unavailable" },
    });
  });

  it("classifies a request the caller abandoned", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runWithRequestAbortSignal(controller.signal, () =>
      writeAdapter(server).updateReviewComment({
        profile,
        pr,
        commentId,
        body: "edited",
      }),
    );

    expect(result).toMatchObject({
      _tag: "err",
      error: { category: "unavailable" },
    });
  });

  /**
   * A 200 whose body did not parse says the mutation may well have landed,
   * which is the one case where a success status still has to keep the intent.
   */
  it("classifies a 200 whose JSON body was truncated", async () => {
    const failure = await restWrite((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"id":24123');
    });

    expect(failure.category).toBe("unavailable");
  });

  it("classifies a 200 that is not JSON at all", async () => {
    const failure = await restWrite((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<html>gateway</html>");
    });

    expect(failure.category).toBe("unavailable");
  });
});
