import { describe, expect, it } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
  type CommandFailure,
  type CommandRequest,
} from "../../src/adapters/github/command-runner";
import { GhRequestRunner } from "../../src/adapters/github/gh-request-runner";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import type { GitHubRestRequest } from "../../src/adapters/github/github-request";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import type { PullRequestRef } from "../../src/domain/pull-request";
import type { Result } from "../../src/domain/result";
import { hashReviewArtifactContent } from "../../src/services/review-artifact-hash";
import { normalizeReviewPatch } from "../../src/services/review-session-preparation";
import {
  errorOf,
  profile,
  useFixtureServer,
  type Handler,
} from "./github-http-fixture-server";
import { StubCredentials } from "./stub-github-credentials";

/**
 * The compare read is the one whose bytes are hashed into `canonicalPatchHash`
 * (ADR 0026), so what these tests pin is byte equality with what gh handed
 * over, and that a failed compare classifies to the tag gh classified it to
 * (issue #276).
 */

/** Fails the test if a child process is spawned for a read the client serves. */
class UnusableGhExecutor implements CommandExecutor {
  async execute(input: CommandRequest): Promise<CommandExecution> {
    throw new Error(`No gh child may run for a served read: ${input.argv[1]}`);
  }
}

function mustParse<T, E>(result: Result<T, E>): T {
  if (result._tag === "err") throw new Error("Expected test value to parse");
  return result.value;
}

const pr: PullRequestRef = {
  host: mustParse(parseGitHubHost("github.com")),
  owner: mustParse(parseGitHubOwner("octo-org")),
  repo: mustParse(parseGitHubRepoName("patchdesk")),
  number: mustParse(parsePullRequestNumber(42)),
};
const baseSha = mustParse(parseGitSha("b".repeat(40)));
const headSha = mustParse(parseGitSha("c".repeat(40)));

/**
 * A compare response carrying every byte that could survive gh and not the
 * HTTP client: a UTF-8 BOM, non-ASCII text, CRLF endings, and no trailing
 * newline.
 */
const compareBytes = Buffer.from(
  "﻿diff --git a/café.txt b/café.txt\r\n" +
    "index 1111111aa..2222222bb 100644\r\n" +
    "--- a/café.txt\r\n" +
    "+++ b/café.txt\r\n" +
    "@@ -1 +1 @@\r\n" +
    "-café\r\n" +
    "+cafés — naïve\r\n" +
    "\\ No newline at end of file",
  "utf8",
);

function diffResponse(bytes: Buffer): Handler {
  return (_request, response) => {
    response.writeHead(200, {
      "Content-Type": "application/vnd.github.v3.diff; charset=utf-8",
      "Content-Length": String(bytes.byteLength),
    });
    response.end(bytes);
  };
}

const compareRequest: GitHubRestRequest = {
  kind: "rest",
  host: "github.com",
  accept: "application/vnd.github.v3.diff",
  path: `repos/octo-org/patchdesk/compare/${baseSha}...${headSha}`,
};

const commitsRequest: GitHubRestRequest = {
  kind: "rest",
  paginate: true,
  host: "github.com",
  path: "repos/octo-org/patchdesk/pulls/42/commits?per_page=100",
};

/** One commit list entry, as `pullRequestCommitSchema` reads it. */
type RawCommit = {
  readonly sha: string;
  readonly commit: {
    readonly message: string;
    readonly author: { readonly name: string; readonly date: string };
  };
};

function commitPage(from: number, count: number): ReadonlyArray<RawCommit> {
  return Array.from({ length: count }, (_unused, index) =>
    rawCommit((from + index).toString(16).padStart(40, "0"), from + index),
  );
}

function rawCommit(sha: string, minute: number): RawCommit {
  const stamp = String(minute % 60).padStart(2, "0");
  return {
    sha,
    commit: {
      message: `Commit ${minute}`,
      author: { name: "Author", date: `2026-07-16T12:${stamp}:00Z` },
    },
  };
}

/** Two `Link`-joined pages, the shape `--paginate --slurp` followed. */
function pagedCommits(
  first: ReadonlyArray<RawCommit>,
  second: ReadonlyArray<RawCommit>,
  port: number,
): Handler {
  return (request, response) => {
    const firstPage = request.url?.includes("page=2") !== true;
    const headers = new Headers({ "Content-Type": "application/json" });
    if (firstPage) {
      headers.set(
        "Link",
        `<http://127.0.0.1:${port}/repos/octo-org/patchdesk/pulls/42/commits?per_page=100&page=2>; rel="next"`,
      );
    }
    response.writeHead(200, Object.fromEntries(headers));
    response.end(JSON.stringify(firstPage ? first : second));
  };
}

describe("the compare read over HTTP", () => {
  const server = useFixtureServer();

  function httpAdapter(): GitHubAdapter {
    const credentials = new StubCredentials();
    return new GitHubAdapter(
      new CommandRunner(new UnusableGhExecutor()),
      credentials,
      server.client(credentials),
    );
  }

  async function readDiff(adapter: GitHubAdapter): Promise<string> {
    const read = await adapter.getPullRequestDiff({
      profile,
      pr,
      snapshot: { baseSha, headSha },
    });
    return mustParse(read);
  }

  it("hands the caller the exact bytes GitHub served", async () => {
    server.respondWith(diffResponse(compareBytes));

    const diff = await readDiff(httpAdapter());

    expect(Buffer.from(diff, "utf8")).toEqual(compareBytes);
    expect(diff.charCodeAt(0)).toBe(0xfeff);
    expect(diff.includes("\r\n")).toBe(true);
    expect(diff.endsWith("\\ No newline at end of file")).toBe(true);
  });

  it("hashes to what the same bytes hashed to through gh", async () => {
    server.respondWith(diffResponse(compareBytes));

    const overHttp = await readDiff(httpAdapter());

    // gh handed its stdout over as one utf8 string; the hash is taken from the
    // same bytes, so the client must reach it without normalizing any of them.
    expect(hashReviewArtifactContent(normalizeReviewPatch(overHttp))).toBe(
      hashReviewArtifactContent(
        normalizeReviewPatch(compareBytes.toString("utf8")),
      ),
    );
  });

  it("accepts a body at the cap the gh stdout buffer allowed", async () => {
    const capped = Buffer.alloc(2 * 1024 * 1024, "d");
    server.respondWith(diffResponse(capped));

    await expect(readDiff(httpAdapter())).resolves.toHaveLength(
      capped.byteLength,
    );
  });
});

describe("a failed compare read", () => {
  const server = useFixtureServer();

  /**
   * The tag `ghText` returns for the compare request. Each expectation is the
   * tag gh produced from its own stderr for the same status, so a compare that
   * fails reads the same to every caller it used to (ADR 0046).
   */
  async function tagFor(
    status: number,
    body: { readonly message: string },
  ): Promise<CommandFailure> {
    const credentials = new StubCredentials();
    server.respondWith((_request, response) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    });
    const runner = new GhRequestRunner(server.client(credentials));
    return errorOf(await runner.ghText(profile, compareRequest));
  }

  it("reports a missing comparison the way gh reported it", async () => {
    await expect(tagFor(404, { message: "Not Found" })).resolves.toEqual({
      _tag: "CommandNotFound",
    });
  });

  it("reports a rejected comparison the way gh reported it", async () => {
    await expect(
      tagFor(422, { message: "No common ancestor between the two commits." }),
    ).resolves.toEqual({ _tag: "CommandUnsupported" });
  });

  it("reports a server error as unavailable rather than a rejection", async () => {
    await expect(tagFor(500, { message: "Server Error" })).resolves.toEqual({
      _tag: "CommandUnavailable",
    });
  });
});

/**
 * T2 moved `pulls/:n/commits`, the one allowlisted read that paginates, onto
 * the HTTP client. Its `Link` following has to produce the array of pages
 * `--paginate --slurp` produced, because that is the shape the 250-entry
 * truncation guard reads.
 */
describe("the paginated commits read over HTTP", () => {
  const server = useFixtureServer();

  function httpAdapter(): GitHubAdapter {
    const credentials = new StubCredentials();
    return new GitHubAdapter(
      new CommandRunner(new UnusableGhExecutor()),
      credentials,
      server.client(credentials),
    );
  }

  /** Answer the commits read with two `Link`-joined pages. */
  function servePages(
    first: ReadonlyArray<RawCommit>,
    second: ReadonlyArray<RawCommit>,
  ): void {
    const port = Number(new URL(server.origin().rest).port);
    server.respondWith(pagedCommits(first, second, port));
  }

  it("answers one array of pages, as --paginate --slurp did", async () => {
    const [first, second] = [commitPage(1, 2), commitPage(3, 1)];
    servePages(first, second);

    const pages = await server
      .client(new StubCredentials())
      .rest(profile, commitsRequest);

    expect(JSON.stringify(mustParse(pages))).toBe(
      JSON.stringify([first, second]),
    );
    expect(server.requests().map((request) => request.url)).toEqual([
      "/repos/octo-org/patchdesk/pulls/42/commits?per_page=100",
      "/repos/octo-org/patchdesk/pulls/42/commits?per_page=100&page=2",
    ]);
  });

  it("marks the head on a listing the adapter read without a gh child", async () => {
    servePages([rawCommit(headSha, 30)], commitPage(1, 1));

    const commits = await httpAdapter().getPullRequestCommits({
      profile,
      pr,
      headSha,
    });

    expect(mustParse(commits).map((commit) => commit.isHead)).toEqual([
      true,
      false,
    ]);
    expect(server.requests()).toHaveLength(2);
  });

  it("still trips the 250-entry guard on the pages the client followed", async () => {
    servePages(commitPage(1, 200), commitPage(201, 50));

    const commits = await httpAdapter().getPullRequestCommits({
      profile,
      pr,
      headSha,
    });

    expect(commits).toEqual({
      _tag: "err",
      error: { _tag: "GitHubResponseInvalid", operation: "get_pr_commits" },
    });
  });
});
