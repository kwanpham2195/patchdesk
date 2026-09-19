import { expect } from "vitest";

import { CommandRunner } from "../../src/adapters/github/command-runner";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import {
  ghInvocationFor,
  type GitHubRestRequest,
} from "../../src/adapters/github/github-request";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import type { PullRequestRef } from "../../src/domain/pull-request";
import type { Result } from "../../src/domain/result";
import {
  type FixtureServer,
  type RecordedRequest,
} from "./github-http-fixture-server";
import { RecordingGhExecutor } from "./github-transport-doubles";
import { StubCredentials } from "./stub-github-credentials";

/**
 * A write cannot be shadowed: it is sent once, so the two transports can never
 * be compared on the same call (issue #276, step T3). The proof is instead
 * request-shape equality — what the client puts on the wire against what the
 * `gh api` argv and stdin for the same call encode today.
 *
 * `ghSentRest` reads that expectation out of the argv itself rather than out
 * of a hand-written literal, so a change to `ghInvocationFor` moves both sides
 * together and a divergence is a failing assertion.
 */

/** A `GitHubAdapter` serving writes over the fixture server, whose gh child fails if it ever runs. */
export function writeAdapter(server: FixtureServer): GitHubAdapter {
  const credentials = new StubCredentials();
  return new GitHubAdapter(
    new CommandRunner(
      new RecordingGhExecutor({
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr: "no gh child may run for a served write",
      }),
    ),
    credentials,
    server.client(credentials),
  );
}

/** What `gh api` put on the wire for one REST request, read back out of its argv and stdin. */
export type GhRestEncoding = {
  readonly method: string;
  readonly path: string;
  readonly accept: string;
  readonly body: string | undefined;
};

/** gh's own default when the request names no media type (`gh api`'s `--jq`-free JSON default). */
const defaultAccept = "application/vnd.github+json";

export function ghSentRest(request: GitHubRestRequest): GhRestEncoding {
  const { argv, stdin } = ghInvocationFor(request);
  const rest = argv.slice(2);
  let method: string | undefined;
  let accept: string | undefined;
  let path: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--method") {
      method = rest[index + 1];
      index += 1;
    } else if (token === "-H") {
      accept = rest[index + 1]?.replace(/^Accept:\s*/, "");
      index += 1;
    } else if (token === "--hostname" || token === "--input") {
      index += 1;
    } else if (token !== undefined && !token.startsWith("-")) {
      path ??= token;
    }
  }
  return {
    // `gh api --input -` with no `--method` posts.
    method: method ?? (stdin === undefined ? "GET" : "POST"),
    path: path ?? "",
    accept: accept ?? defaultAccept,
    body: stdin,
  };
}

/**
 * Asserts the one recorded HTTP request is byte-for-byte the request gh sent:
 * the same verb, the same path, the same `Accept`, a `Content-Type` exactly
 * when gh had a stdin body, and that body unchanged.
 */
export function expectSameRequestAsGh(
  recorded: RecordedRequest | undefined,
  request: GitHubRestRequest,
): void {
  const gh = ghSentRest(request);
  expect(recorded?.method).toBe(gh.method);
  expect(recorded?.url).toBe(`/${gh.path}`);
  expect(recorded?.headers.accept).toBe(gh.accept);
  expect(recorded?.headers["content-type"]).toBe(
    gh.body === undefined ? undefined : "application/json",
  );
  expect(recorded?.body).toBe(gh.body ?? "");
  // The client pins the REST surface the adapter's schemas were written
  // against on every call. gh 2.100.0 carries the same header name and the
  // same value in its own binary, so this matches gh rather than adding to it.
  expect(recorded?.headers["x-github-api-version"]).toBe("2022-11-28");
}

/** One GraphQL variable value, as gh's `-f` and `-F` field typing produced it. */
type GraphQlVariableValue = string | number | boolean | null;

/** The `variables` object a mutation posts, keyed by the variable names its document declares. */
type PostedVariables = Readonly<
  Record<string, GraphQlVariableValue | ReadonlyArray<GraphQlVariableValue>>
>;

/** Asserts the one recorded GraphQL request carries the document and variables gh posted. */
export function expectSameMutationAsGh(
  recorded: RecordedRequest | undefined,
  expected: {
    readonly query: string;
    readonly variables: PostedVariables;
  },
): void {
  expect(recorded?.method).toBe("POST");
  expect(recorded?.url).toBe("/graphql");
  expect(recorded?.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(recorded?.body ?? "")).toEqual(expected);
}

function mustParse<T, E>(result: Result<T, E>): T {
  if (result._tag === "err") throw new Error("Expected test value to parse");
  return result.value;
}

export const pr: PullRequestRef = {
  host: mustParse(parseGitHubHost("github.com")),
  owner: mustParse(parseGitHubOwner("octo-org")),
  repo: mustParse(parseGitHubRepoName("patchdesk")),
  number: mustParse(parsePullRequestNumber(42)),
};

export { mustParse };
