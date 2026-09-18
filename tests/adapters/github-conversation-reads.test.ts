import { describe, expect, it } from "vitest";

import {
  CommandRunner,
  normalizeCommandLabel,
  type CommandExecution,
  type CommandExecutor,
  type CommandFailure,
} from "../../src/adapters/github/command-runner";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import { type GitHubCredentials } from "../../src/adapters/github/github-credentials";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import { type PullRequestRef } from "../../src/domain/pull-request";
import { ok, type Result } from "../../src/domain/result";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";

const headSha = "abcdef1234567890abcdef1234567890abcdef12";

function mustParse<T, E>(
  result:
    | { readonly _tag: "ok"; readonly value: T }
    | { readonly _tag: "err"; readonly error: E },
): T {
  if (result._tag === "err") throw new Error("Expected test value to parse");
  return result.value;
}

const profile = mustParse(
  parseWorkspaceProfileConfig({
    id: "cfw",
    label: "CFW",
    githubHost: "github.com",
    ghAccount: "pmquan2cfw",
    workspaceRoots: [],
    rulePaths: [],
    repos: [],
  }),
);

const pr: PullRequestRef = {
  host: mustParse(parseGitHubHost("github.com")),
  owner: mustParse(parseGitHubOwner("centraldigital")),
  repo: mustParse(parseGitHubRepoName("patchdesk")),
  number: mustParse(parsePullRequestNumber(42)),
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a fixture writer for whatever JSON one gh call is told to return; there is no narrower contract to parse it against.
function json(value: unknown): CommandExecution {
  return {
    _tag: "Exited",
    exitCode: 0,
    stdout: JSON.stringify(value),
    stderr: "",
  };
}

const pullRequestPayload = {
  number: 42,
  title: "Add safe GitHub reads",
  state: "open",
  draft: false,
  head: { ref: "feat/github-read", sha: headSha },
  base: { ref: "sit" },
  user: { login: "reviewer" },
  updated_at: "2026-07-16T12:00:00Z",
  mergeable_state: "clean",
};

const threadPayload = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  },
};

/**
 * Answers by endpoint rather than by position, so a test can count how many
 * gh invocations one adapter call makes without also fixing their order.
 */
class RoutingExecutor implements CommandExecutor {
  /** `normalizeCommandLabel` of every gh invocation, in call order. */
  readonly labels: Array<string> = [];

  async execute(input: {
    readonly argv: ReadonlyArray<string>;
  }): Promise<CommandExecution> {
    const label = normalizeCommandLabel(input.argv);
    this.labels.push(label);
    if (label.startsWith("api graphql")) return json(threadPayload);
    switch (label) {
      case "api GET repos/:owner/:repo/pulls/:n":
        return json(pullRequestPayload);
      case "api GET repos/:owner/:repo/pulls/:n/reviews":
      case "api GET repos/:owner/:repo/pulls/:n/comments":
      case "api GET repos/:owner/:repo/issues/:n/comments":
        return json([]);
      case "api GET user":
        return {
          _tag: "Exited",
          exitCode: 0,
          stdout: "pmquan2cfw\n",
          stderr: "",
        };
      case "api GET repos/:owner/:repo/collaborators/:user/permission":
        return json({ role_name: "write" });
      case "api GET repos/:owner/:repo/branches/:branch/protection":
        return json({ required_pull_request_reviews: null });
      default:
        throw new Error(`Unrouted gh call: ${label}`);
    }
  }
}

/** Resolves a fixed credential so command expectations stay about gh argv. */
class StubCredentials implements GitHubCredentials {
  async environmentFor(): Promise<
    Result<Readonly<Record<string, string>>, CommandFailure>
  > {
    return ok({ GH_TOKEN: "profile-token" });
  }

  forget(): void {}
}

describe("loadConversation gh cost", () => {
  /**
   * `ReviewRefreshService` and `ReviewObservationService` already read the
   * pull request, its comments, and its published feedback themselves, and
   * now assemble the Conversation from those. This records what calling
   * `loadConversation` on top of them used to cost each cycle, so a future
   * caller that reintroduces it can see the price.
   */
  it("re-reads the pull request, comments, and the whole published-feedback subtree", async () => {
    const executor = new RoutingExecutor();
    const adapter = new GitHubAdapter(
      new CommandRunner(executor),
      new StubCredentials(),
    );

    await expect(
      adapter.loadConversation({ profile, pr }),
    ).resolves.toMatchObject({ _tag: "ok" });

    expect(executor.labels.slice().sort()).toEqual([
      "api GET repos/:owner/:repo/branches/:branch/protection",
      "api GET repos/:owner/:repo/collaborators/:user/permission",
      "api GET repos/:owner/:repo/issues/:n/comments",
      "api GET repos/:owner/:repo/pulls/:n",
      "api GET repos/:owner/:repo/pulls/:n",
      "api GET repos/:owner/:repo/pulls/:n/comments",
      "api GET repos/:owner/:repo/pulls/:n/reviews",
      "api GET user",
      "api graphql PullRequestThreads",
    ]);
  });
});
