import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";

import {
  FakeGitHubAdapter,
  type GitHubReader,
} from "../../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { ok, type Result } from "../../src/domain/result";
import type { WorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { buildLocalApiContainer } from "../../src/main/local-api-container";

// The Insight context pack reads a pull request's comments and checks. Until
// issue #311 it read them through a GitHub adapter the desktop entry point
// built for itself, so an injected `configuration.github` never reached the
// pack and the process held a second credential cache.

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "ok") return result.value;
  throw new Error("Invalid test fixture");
}

const host = must(parseGitHubHost("github.com"));
const profile: WorkspaceProfileConfig = {
  id: must(parseWorkspaceProfileId("acme")),
  label: "ACME",
  githubHost: host,
  ghAccount: "profile-account",
  workspaceRoots: [],
  rulePaths: [],
  repos: [],
};
const pr = {
  host,
  owner: must(parseGitHubOwner("octo-org")),
  repo: must(parseGitHubRepoName("patchdesk")),
  number: must(parsePullRequestNumber(42)),
};
const headSha = must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12"));
const comments = { threads: [] };
const checks = { overall: "failing", checks: [] } as const;

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined)
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  root = undefined;
});

it("builds the Insight coordinator over the container's GitHub reader", async () => {
  root = await mkdtemp(join(tmpdir(), "patchdesk-insight-reader-"));
  const github = new FakeGitHubAdapter({ comments, checks });
  let packReader: GitHubReader | undefined;
  const built = await buildLocalApiContainer({
    allowedOrigin: "http://patchdesk.test",
    capability: "cap",
    paths: PatchdeskPaths.forTest(root),
    github,
    insights: (reader) => {
      packReader = reader;
      // SAFETY: this test asserts on the reader the container hands over, and
      // calls nothing on the coordinator it returns.
      return {} as never;
    },
  });

  expect(built._tag).toBe("ok");
  expect(packReader).toBe(github);
  expect(await packReader?.getPullRequestComments({ profile, pr })).toEqual(
    ok(comments),
  );
  expect(
    await packReader?.getPullRequestChecks({ profile, pr, headSha }),
  ).toEqual(ok(checks));
});
