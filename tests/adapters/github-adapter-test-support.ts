import { readFile } from "node:fs/promises";
import { join } from "node:path";

import * as v from "valibot";

import { StubCredentials } from "./stub-github-credentials";
import type {
  CommandRunner,
  CommandExecution,
  CommandExecutor,
  CommandRequest,
} from "../../src/adapters/github/command-runner";
import type { GitHubServedTransport } from "../../src/adapters/github/gh-request-runner";
import {
  ghInvocationFor,
  type GhInvocation,
} from "../../src/adapters/github/github-request";
import {
  noChildProcesses,
  type HttpTransportDouble,
} from "./github-transport-doubles";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import type { GitHubCredentials } from "../../src/adapters/github/github-credentials";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import type { PullRequestRef } from "../../src/domain/pull-request";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";

const fixtureRoot = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "github",
  "argv",
);
const payloadRoot = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "github",
  "payloads",
);
export const headSha = "abcdef1234567890abcdef1234567890abcdef12";
export const baseSha = "1234567890abcdef1234567890abcdef12345678";

export function mustParse<T, E>(
  result:
    | { readonly _tag: "ok"; readonly value: T }
    | { readonly _tag: "err"; readonly error: E },
): T {
  if (result._tag === "err") throw new Error("Expected test value to parse");
  return result.value;
}

export const profile = mustParse(
  parseWorkspaceProfileConfig({
    id: "acme",
    label: "ACME",
    githubHost: "github.com",
    ghAccount: "octo-dev",
    workspaceRoots: [],
    rulePaths: [],
    repos: [],
  }),
);

export const pr: PullRequestRef = {
  host: mustParse(parseGitHubHost("github.com")),
  owner: mustParse(parseGitHubOwner("octo-org")),
  repo: mustParse(parseGitHubRepoName("patchdesk")),
  number: mustParse(parsePullRequestNumber(42)),
};

/** The create receipt for a REST response carrying only `node_id`: both ids are it. */
export const created = {
  commentId: "PRRC_comment",
  commentNodeId: "PRRC_comment",
};

/** The child-process double the `CommandRunner` and local-git suites still need. */
export class FakeProcessExecutor implements CommandExecutor {
  readonly requests: Array<ReadonlyArray<string>> = [];

  constructor(private readonly responses: ReadonlyArray<CommandExecution>) {}

  async execute(input: CommandRequest): Promise<CommandExecution> {
    this.requests.push(input.argv);
    const response = this.responses[this.requests.length - 1];
    if (response === undefined)
      throw new Error("Missing fake command response");
    return response;
  }
}

export function testAdapter(
  http: GitHubServedTransport,
  commands: CommandRunner = noChildProcesses(),
  credentials: GitHubCredentials = new StubCredentials(),
): GitHubAdapter {
  return new GitHubAdapter(commands, credentials, http);
}

/**
 * The gh invocation one recorded request describes. The golden argv fixtures
 * still state what the adapter asks GitHub for, whatever carries it.
 */
export function sent(
  transport: HttpTransportDouble,
  index: number,
): GhInvocation {
  const request = transport.requests[index];
  if (request === undefined)
    throw new Error(`No GitHub request at index ${index}`);
  return ghInvocationFor(request);
}

export function sentArgv(
  transport: HttpTransportDouble,
): Array<ReadonlyArray<string>> {
  return transport.requests.map((request) => ghInvocationFor(request).argv);
}

export async function golden(name: string): Promise<ReadonlyArray<string>> {
  const parsed = v.safeParse(
    v.array(v.string()),
    JSON.parse(await readFile(join(fixtureRoot, `${name}.json`), "utf8")),
  );
  if (!parsed.success) throw new Error(`Malformed golden argv fixture ${name}`);
  return parsed.output;
}

export async function payload(name: string): Promise<string> {
  return readFile(join(payloadRoot, name), "utf8");
}

/** GraphQL response fixture for `confirmPublishedCommentThread`'s read-back. */
export function confirmThreadResponse(
  nodes: ReadonlyArray<{
    readonly id: string;
    readonly comments: ReadonlyArray<{
      readonly id: string;
      readonly body: string;
    }>;
  }>,
): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: nodes.map((node) => ({
              id: node.id,
              isResolved: false,
              isOutdated: false,
              comments: {
                nodes: node.comments.map((comment) => ({
                  id: comment.id,
                  body: comment.body,
                  createdAt: "2026-08-17T00:00:00Z",
                })),
              },
            })),
          },
        },
      },
    },
  });
}

/** The REST pull-request payload shape these tests feed to the adapter. */
export type PullRequestPayload = {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly draft: boolean;
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string; readonly sha?: string };
  readonly user: { readonly login: string };
  readonly updated_at: string;
  readonly body?: string | null;
  readonly mergeable_state?: string | undefined;
  readonly labels?: ReadonlyArray<{
    readonly name: string;
    readonly color: string;
  }>;
  readonly requested_reviewers?: ReadonlyArray<{ readonly login: string }>;
  readonly assignees?: ReadonlyArray<{ readonly login: string }>;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
  readonly changed_files?: number | undefined;
};

export function pullRequestPayload(
  overrides: Partial<PullRequestPayload> = {},
): PullRequestPayload {
  return {
    number: 42,
    title: "Add safe GitHub reads",
    state: "open",
    draft: false,
    head: { ref: "feat/github-read", sha: headSha },
    base: { ref: "sit" },
    user: { login: "reviewer" },
    updated_at: "2026-07-16T12:00:00Z",
    mergeable_state: "clean",
    labels: [{ name: "review", color: "0e8a16" }],
    requested_reviewers: [{ login: "octo-dev" }],
    assignees: [{ login: "octo-dev" }],
    additions: 12,
    deletions: 3,
    changed_files: 2,
    ...overrides,
  };
}
