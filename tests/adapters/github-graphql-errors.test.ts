import { describe, expect, it } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
  type CommandFailure,
  type CommandRequest,
  type ForbiddenReason,
} from "../../src/adapters/github/command-runner";
import type { Result } from "../../src/domain/result";
import { json, profile, useFixtureServer } from "./github-http-fixture-server";

/**
 * What a GraphQL answer carrying `errors` means, pinned across both
 * transports before any GraphQL read leaves `gh api` (issue #276, step T2).
 *
 * `gh api graphql` exits nonzero whenever the response holds a non-empty
 * `errors` array, even beside a partial `data`, so every caller in this app
 * has only ever seen such a response as a failure. The HTTP client answers
 * the same 200 body, so it has to reach the same `CommandFailure` tag: the
 * same classifier reads the body on both paths, and each case below asserts
 * the gh path's tag for the body it feeds the client.
 */

const fixture = useFixtureServer();

/** Answers one recorded gh execution, whatever it is asked to run. */
class GhExecutor implements CommandExecutor {
  constructor(private readonly execution: CommandExecution) {}

  async execute(_input: CommandRequest): Promise<CommandExecution> {
    return this.execution;
  }
}

/** One entry of GitHub's `errors` array, in the fields this classification reads. */
type GraphQlErrorEntry = {
  readonly type?: string;
  readonly message?: string;
  readonly path?: ReadonlyArray<string>;
  readonly extensions?: {
    readonly saml_failure?: boolean;
    readonly code?: string;
    readonly typeName?: string;
  };
};

/** A GraphQL response body, in the shapes these cases answer with. */
type GraphQlResponseBody = {
  readonly data?: {
    readonly node?: null;
    readonly repository?: { readonly id: string } | null;
    readonly rateLimit?: { readonly remaining: number };
  } | null;
  readonly errors?: ReadonlyArray<GraphQlErrorEntry>;
};

type GraphQlErrorCase = {
  readonly name: string;
  /** The HTTP 200 body GitHub answered with, which is also gh's stdout. */
  readonly body: GraphQlResponseBody;
  /** What gh wrote to stderr for that body: its own prefix and GitHub's messages. */
  readonly ghStderr: string;
  readonly expected: CommandFailure;
};

/** The parts of a failure both transports must agree on; `stderr` is the transport's own text. */
type FailureTag = {
  readonly _tag: CommandFailure["_tag"];
  readonly reason?: ForbiddenReason;
};

function tagOf(failure: CommandFailure): FailureTag {
  return "reason" in failure
    ? { _tag: failure._tag, reason: failure.reason }
    : { _tag: failure._tag };
}

function failureOf(result: Result<unknown, CommandFailure>): CommandFailure {
  if (result._tag === "ok") throw new Error("Expected a failed result");
  return result.error;
}

/** The same body through `gh api graphql`, which exits 1 on any `errors` entry. */
async function ghAnswer(
  body: GraphQlResponseBody,
  stderr: string,
  exitCode = 1,
): Promise<Result<unknown, CommandFailure>> {
  const executor = new GhExecutor({
    _tag: "Exited",
    exitCode,
    stdout: JSON.stringify(body),
    stderr,
  });
  return new CommandRunner(executor).runJson({
    argv: ["gh", "api", "graphql"],
    timeoutMs: 1_000,
  });
}

async function httpAnswer(
  body: GraphQlResponseBody,
): Promise<Result<unknown, CommandFailure>> {
  fixture.respondWith(json(200, body));
  return fixture.client().graphql(profile, {
    kind: "graphql",
    host: "github.com",
    document: "query Probe { repository { id } }",
    variables: [],
  });
}

const cases: ReadonlyArray<GraphQlErrorCase> = [
  {
    name: "a node that does not resolve is not found",
    body: {
      data: { node: null },
      errors: [
        {
          type: "NOT_FOUND",
          path: ["node"],
          message: "Could not resolve to a node with the global id of 'x'",
        },
      ],
    },
    ghStderr: "gh: Could not resolve to a node with the global id of 'x'",
    expected: { _tag: "CommandNotFound" },
  },
  {
    name: "an IP-allow-list refusal beside a partial data field is forbidden",
    body: {
      data: { rateLimit: { remaining: 4999 }, repository: null },
      errors: [
        {
          type: "FORBIDDEN",
          path: ["repository"],
          extensions: { saml_failure: false },
          message:
            "Although you appear to have the correct authorization credentials, the `OmisePayments` organization has an IP allow list enabled, and your IP address is not permitted to access this resource.",
        },
      ],
    },
    ghStderr:
      "gh: Although you appear to have the correct authorization credentials, the `OmisePayments` organization has an IP allow list enabled, and your IP address is not permitted to access this resource.",
    expected: { _tag: "CommandForbidden", reason: "ip_allow_list" },
  },
  {
    name: "a SAML-protected resource is forbidden for that reason",
    body: {
      data: { repository: null },
      errors: [
        {
          type: "FORBIDDEN",
          extensions: { saml_failure: true },
          message: "Resource protected by organization SAML enforcement.",
        },
      ],
    },
    ghStderr: "gh: Resource protected by organization SAML enforcement.",
    expected: { _tag: "CommandForbidden", reason: "saml" },
  },
  {
    name: "a refusal GitHub does not attribute is forbidden for an unknown reason",
    body: {
      errors: [
        {
          type: "FORBIDDEN",
          message: "Resource not accessible by integration",
        },
      ],
    },
    ghStderr: "gh: Resource not accessible by integration",
    expected: { _tag: "CommandForbidden", reason: "unknown" },
  },
  {
    name: "a token missing a scope is forbidden for that reason",
    body: {
      errors: [
        {
          type: "INSUFFICIENT_SCOPES",
          message:
            "Your token has not been granted the required scopes to execute this query.",
        },
      ],
    },
    ghStderr:
      "gh: Your token has not been granted the required scopes to execute this query.",
    expected: { _tag: "CommandForbidden", reason: "insufficient_scopes" },
  },
  {
    name: "an exhausted GraphQL budget is rate limited",
    body: {
      data: { repository: null },
      errors: [
        {
          type: "RATE_LIMITED",
          message: "API rate limit exceeded for user ID 12345.",
        },
      ],
    },
    ghStderr: "gh: API rate limit exceeded for user ID 12345.",
    expected: { _tag: "CommandRateLimited" },
  },
  {
    name: "a schema-validation error has no mapped type and stays a plain failure",
    body: {
      data: { repository: null },
      errors: [
        {
          extensions: { code: "undefinedField", typeName: "Query" },
          message: "Field 'nope' doesn't exist on type 'Query'",
        },
      ],
    },
    ghStderr: "gh: Field 'nope' doesn't exist on type 'Query'",
    expected: { _tag: "CommandFailed" },
  },
];

describe("a GraphQL answer carrying errors", () => {
  it.each(cases)("$name, over HTTP", async ({ body, expected }) => {
    expect(tagOf(failureOf(await httpAnswer(body)))).toEqual(tagOf(expected));
  });

  it.each(cases)("$name, and gh answered the same", async (testCase) => {
    const answer = await ghAnswer(testCase.body, testCase.ghStderr);
    expect(tagOf(failureOf(answer))).toEqual(tagOf(testCase.expected));
  });

  it("never answers with the partial data beside the errors", async () => {
    const body = {
      data: { rateLimit: { remaining: 4999 }, repository: null },
      errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }],
    };

    const http = await httpAnswer(body);
    const gh = await ghAnswer(body, "gh: Resource not accessible");

    expect(http._tag).toBe("err");
    expect(gh._tag).toBe("err");
  });

  it("answers a null data with no errors as the value gh answered with", async () => {
    const body = { data: null };

    // No `errors` entry, so gh exited zero and handed the body over verbatim.
    await expect(ghAnswer(body, "", 0)).resolves.toEqual({
      _tag: "ok",
      value: body,
    });
    await expect(httpAnswer(body)).resolves.toEqual({
      _tag: "ok",
      value: body,
    });
  });

  it("answers an empty errors array as a success, as gh's nonzero exit needed a non-empty one", async () => {
    const body = { data: { repository: { id: "R_1" } }, errors: [] };

    await expect(ghAnswer(body, "", 0)).resolves.toEqual({
      _tag: "ok",
      value: body,
    });
    await expect(httpAnswer(body)).resolves.toEqual({
      _tag: "ok",
      value: body,
    });
  });
});
