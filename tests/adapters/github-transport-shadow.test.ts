import { describe, expect, it, vi } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
  type CommandFailure,
  type CommandRequest,
} from "../../src/adapters/github/command-runner";
import { GhRequestRunner } from "../../src/adapters/github/gh-request-runner";
import type { GitHubCredentials } from "../../src/adapters/github/github-credentials";
import type {
  GitHubGraphQlRequest,
  GitHubRequest,
  GitHubRestRequest,
} from "../../src/adapters/github/github-request";
import {
  isShadowableRead,
  TransportShadow,
  type GitHubShadowTransport,
} from "../../src/adapters/github/transport-shadow";
import type { LogEntryInput, LogMetaInput } from "../../src/domain/log-entry";
import { err, ok, type Result } from "../../src/domain/result";
import type { WorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { profile } from "./github-http-fixture-server";
import { StubCredentials } from "./stub-github-credentials";

/**
 * The shadow exists to measure the HTTP transport against gh without putting
 * it on the serving path (issue #292), so these tests are about what the
 * caller still gets: gh's answer, at gh's timing, whatever the shadow does.
 */

type ShadowAnswer = () => Promise<Result<unknown, CommandFailure>>;

class FakeGhExecutor implements CommandExecutor {
  readonly argv: Array<ReadonlyArray<string>> = [];

  constructor(private readonly execution: CommandExecution) {}

  async execute(input: CommandRequest): Promise<CommandExecution> {
    this.argv.push(input.argv);
    return this.execution;
  }
}

class FakeShadowTransport implements GitHubShadowTransport {
  readonly requests: Array<GitHubRequest> = [];

  constructor(private readonly answer: ShadowAnswer) {}

  async rest(
    _profile: WorkspaceProfileConfig,
    request: GitHubRestRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    this.requests.push(request);
    return this.answer();
  }

  async graphql(
    _profile: WorkspaceProfileConfig,
    request: GitHubGraphQlRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    this.requests.push(request);
    return this.answer();
  }
}

/** A profile whose credential cannot be read, which is the `skipped` outcome. */
class TokenlessCredentials extends StubCredentials {
  override async tokenFor(): Promise<Result<string, CommandFailure>> {
    return err({ _tag: "CommandAuthenticationRequired" });
  }
}

const exited = (stdout: string): CommandExecution => ({
  _tag: "Exited",
  exitCode: 0,
  stdout,
  stderr: "",
});

const notFound: CommandExecution = {
  _tag: "Exited",
  exitCode: 1,
  stdout: "",
  stderr: "gh: Not Found (HTTP 404)\n",
};

const readRequest: GitHubRequest = {
  kind: "rest",
  host: "github.com",
  path: "repos/centraldigital/patchdesk/pulls/42",
};

/** The one live-observed divergence: `rateLimit` is answered per request. */
const inboxSearchRequest: GitHubRequest = {
  kind: "graphql",
  host: "github.com",
  document:
    "query MaintainerInboxSearch($search: String!) { rateLimit { remaining resetAt } search(query: $search, type: ISSUE) { issueCount } }",
  variables: [{ kind: "string", name: "search", value: "is:open" }],
};

function harness(
  execution: CommandExecution,
  answer: ShadowAnswer,
  options: {
    readonly shadowed?: boolean;
    readonly credentials?: GitHubCredentials;
  } = {},
) {
  const entries: Array<LogEntryInput> = [];
  const transport = new FakeShadowTransport(answer);
  const credentials = options.credentials ?? new StubCredentials();
  const shadow = new TransportShadow(transport, credentials, (entry) =>
    entries.push(entry),
  );
  const runner = new GhRequestRunner(
    new CommandRunner(new FakeGhExecutor(execution)),
    credentials,
    options.shadowed === false ? undefined : shadow,
  );
  return { runner, transport, entries };
}

/** The one entry a shadowed call writes, once both transports have settled. */
async function shadowMeta(
  entries: ReadonlyArray<LogEntryInput>,
): Promise<LogMetaInput> {
  await vi.waitFor(() => expect(entries).toHaveLength(1));
  const entry = entries[0];
  expect(entry?.topic).toBe("transport-shadow");
  return entry?.meta ?? {};
}

describe("isShadowableRead", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly request: GitHubRequest;
    readonly shadowed: boolean;
  }> = [
    {
      name: "a plain REST GET",
      request: { kind: "rest", host: "github.com", path: "user" },
      shadowed: true,
    },
    {
      name: "a REST GET that asks for a media type",
      request: {
        kind: "rest",
        host: "github.com",
        path: "repos/o/r/compare/a...b",
        accept: "application/vnd.github.v3.diff",
      },
      shadowed: true,
    },
    {
      name: "a paginated REST GET",
      request: {
        kind: "rest",
        host: "github.com",
        path: "repos/o/r/pulls/42/commits",
        paginate: true,
      },
      shadowed: true,
    },
    {
      name: "a REST request with a method",
      request: {
        kind: "rest",
        host: "github.com",
        method: "POST",
        path: "repos/o/r/pulls/42/reviews",
      },
      shadowed: false,
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
      shadowed: false,
    },
    {
      name: "a named GraphQL query",
      request: {
        kind: "graphql",
        host: "github.com",
        document: "query PullRequestThreads($owner: String!) { viewer { id } }",
        variables: [],
      },
      shadowed: true,
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
      shadowed: true,
    },
    {
      name: "an anonymous GraphQL selection set",
      request: {
        kind: "graphql",
        host: "github.com",
        document: "{ viewer { id } }",
        variables: [],
      },
      shadowed: true,
    },
    {
      name: "a GraphQL mutation",
      request: {
        kind: "graphql",
        host: "github.com",
        document: "mutation { addComment(input: {}) { clientMutationId } }",
        variables: [],
      },
      shadowed: false,
    },
  ];

  it.each(cases)("shadows $name: $shadowed", ({ request, shadowed }) => {
    expect(isShadowableRead(request)).toBe(shadowed);
  });
});

describe("GhRequestRunner transport shadow", () => {
  it("makes no HTTP call at all when no shadow is configured", async () => {
    const { runner, transport, entries } = harness(
      exited('{"number":42}'),
      async () => ok({ number: 42 }),
      { shadowed: false },
    );

    const result = await runner.ghJson(profile, readRequest);

    expect(result).toEqual({ _tag: "ok", value: { number: 42 } });
    await vi.waitFor(() => expect(transport.requests).toEqual([]));
    expect(entries).toEqual([]);
  });

  it("serves gh's answer and records a match when both agree", async () => {
    const { runner, transport, entries } = harness(
      exited('{"number":42,"head":{"sha":"abc"}}'),
      async () => ok({ number: 42, head: { sha: "abc" } }),
    );

    const result = await runner.ghJson(profile, readRequest);

    expect(result).toEqual({
      _tag: "ok",
      value: { number: 42, head: { sha: "abc" } },
    });
    expect(transport.requests).toEqual([readRequest]);
    expect(await shadowMeta(entries)).toMatchObject({
      label: "api GET repos/:owner/:repo/pulls/:n",
      outcome: "match",
      ghMs: expect.any(Number),
      shadowMs: expect.any(Number),
    });
  });

  it("names the first differing path when the parsed values disagree", async () => {
    const { runner, entries } = harness(
      exited('{"number":42,"head":{"sha":"abc"}}'),
      async () => ok({ number: 42, head: { sha: "def" } }),
    );

    const result = await runner.ghJson(profile, readRequest);

    expect(result._tag).toBe("ok");
    expect(await shadowMeta(entries)).toMatchObject({
      outcome: "diverged",
      kind: "value",
      firstDifference: "$.head.sha",
    });
  });

  it("names the first differing byte when the text disagrees", async () => {
    const { runner, entries } = harness(
      exited("diff --git a/a.ts b/a.ts\n"),
      async () => ok("diff --git b/a.ts b/a.ts\n"),
    );

    const result = await runner.ghText(profile, readRequest);

    expect(result).toEqual({
      _tag: "ok",
      value: "diff --git a/a.ts b/a.ts\n",
    });
    expect(await shadowMeta(entries)).toMatchObject({
      outcome: "diverged",
      kind: "value",
      firstDifference: "byte 11",
    });
  });

  it("reports one transport answering where the other failed", async () => {
    const { runner, entries } = harness(exited('{"number":42}'), async () =>
      err({ _tag: "CommandNotFound" }),
    );

    await runner.ghJson(profile, readRequest);

    expect(await shadowMeta(entries)).toMatchObject({
      outcome: "diverged",
      kind: "ok_vs_err",
      ghTag: "ok",
      shadowTag: "CommandNotFound",
    });
  });

  it("counts the same failure tag from both transports as a match", async () => {
    const { runner, entries } = harness(notFound, async () =>
      err({ _tag: "CommandNotFound" }),
    );

    const result = await runner.ghJson(profile, readRequest);

    expect(result).toEqual({ _tag: "err", error: { _tag: "CommandNotFound" } });
    expect(await shadowMeta(entries)).toMatchObject({ outcome: "match" });
  });

  it("reports two failures that classified differently", async () => {
    const { runner, entries } = harness(notFound, async () =>
      err({ _tag: "CommandUnavailable" }),
    );

    await runner.ghJson(profile, readRequest);

    expect(await shadowMeta(entries)).toMatchObject({
      outcome: "diverged",
      kind: "failure_tag",
      ghTag: "CommandNotFound",
      shadowTag: "CommandUnavailable",
    });
  });

  it("swallows a throwing shadow and still serves gh's answer", async () => {
    const { runner, transport, entries } = harness(
      exited('{"number":42}'),
      () => {
        throw new Error("shadow transport exploded");
      },
    );

    const result = await runner.ghJson(profile, readRequest);

    expect(result).toEqual({ _tag: "ok", value: { number: 42 } });
    // The shadow ran and failed: nothing is logged and nothing rejects, and an
    // unhandled rejection here would fail this run.
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    expect(entries).toEqual([]);
  });

  it("never waits for the shadow before answering", async () => {
    const pending = new Promise<Result<unknown, CommandFailure>>(
      () => undefined,
    );
    const { runner, transport, entries } = harness(
      exited('{"number":42}'),
      async () => pending,
    );

    // gh settles while the shadow is still in flight; awaiting the served
    // promise must not wait for it.
    const result = await runner.ghJson(profile, readRequest);

    expect(result).toEqual({ _tag: "ok", value: { number: 42 } });
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    expect(entries).toEqual([]);
  });

  it("skips a read gh projects with jq, whose answers cannot be compared", async () => {
    const { runner, transport, entries } = harness(
      exited("pmquan2cfw\n"),
      async () => ok({ login: "pmquan2cfw" }),
    );

    const result = await runner.ghText(profile, {
      kind: "rest",
      host: "github.com",
      path: "user",
      jq: ".login",
    });

    expect(result).toEqual({ _tag: "ok", value: "pmquan2cfw\n" });
    expect(await shadowMeta(entries)).toMatchObject({
      label: "api GET user",
      outcome: "skipped",
      reason: "jq_projection",
    });
    expect(transport.requests).toEqual([]);
  });

  it("skips the comparison when the shadow cannot read the credential", async () => {
    const { runner, transport, entries } = harness(
      exited('{"number":42}'),
      async () => ok({ number: 42 }),
      { credentials: new TokenlessCredentials() },
    );

    await runner.ghJson(profile, readRequest);

    expect(await shadowMeta(entries)).toMatchObject({
      label: "api GET repos/:owner/:repo/pulls/:n",
      outcome: "skipped",
      reason: "no_token",
    });
    expect(transport.requests).toEqual([]);
  });

  it("ignores GraphQL rate-limit accounting, which two requests cannot share", async () => {
    const { runner, entries } = harness(
      exited(
        '{"data":{"rateLimit":{"remaining":4987},"search":{"issueCount":3}}}',
      ),
      async () =>
        ok({
          data: { rateLimit: { remaining: 4986 }, search: { issueCount: 3 } },
        }),
    );

    await runner.ghJson(profile, inboxSearchRequest);

    expect(await shadowMeta(entries)).toMatchObject({
      label: "api graphql MaintainerInboxSearch",
      outcome: "match",
    });
  });

  it("still reports a real divergence beside the ignored rate limit", async () => {
    const { runner, entries } = harness(
      exited(
        '{"data":{"rateLimit":{"remaining":4987},"search":{"issueCount":3}}}',
      ),
      async () =>
        ok({
          data: { rateLimit: { remaining: 4986 }, search: { issueCount: 4 } },
        }),
    );

    await runner.ghJson(profile, inboxSearchRequest);

    expect(await shadowMeta(entries)).toMatchObject({
      outcome: "diverged",
      kind: "value",
      firstDifference: "$.data.search.issueCount",
    });
  });

  it("never shadows a write", async () => {
    const { runner, transport, entries } = harness(
      exited('{"id":7}'),
      async () => ok({ id: 7 }),
    );

    await runner.ghJson(profile, {
      kind: "rest",
      host: "github.com",
      path: "repos/centraldigital/patchdesk/pulls/42/reviews",
      jsonBody: '{"event":"COMMENT"}',
    });

    await vi.waitFor(() => expect(transport.requests).toEqual([]));
    expect(entries).toEqual([]);
  });
});
