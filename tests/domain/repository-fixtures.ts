import {
  parseGitHubHost,
  parseGitHubLogin,
  parseGitHubOwner,
  parseGitHubRepoName,
} from "#src/domain/ids";
import type { GitHubRepositoryKey } from "#src/domain/local-repository";
import {
  parseWorkspaceProfileConfig,
  type GitHubConnection,
} from "#src/domain/workspace-profile";

export function githubConnectionFixture(
  input: { readonly host?: string; readonly account?: string } = {},
): Extract<GitHubConnection, { kind: "connected" }> {
  const host = parseGitHubHost(input.host ?? "github.com"),
    account = parseGitHubLogin(input.account ?? "fixture");
  if (host._tag === "err" || account._tag === "err")
    throw new Error("Invalid GitHub connection fixture");
  return { kind: "connected", host: host.value, account: account.value };
}

export function githubRepositoryKeyFixture(
  input: {
    readonly host?: string;
    readonly owner?: string;
    readonly repo?: string;
  } = {},
): GitHubRepositoryKey {
  const host = parseGitHubHost(input.host ?? "github.com"),
    owner = parseGitHubOwner(input.owner ?? "octo-org"),
    repo = parseGitHubRepoName(input.repo ?? "patchdesk");
  if (host._tag === "err" || owner._tag === "err" || repo._tag === "err")
    throw new Error("Invalid repository identity fixture");
  return {
    kind: "github",
    host: host.value,
    owner: owner.value,
    repo: repo.value,
  };
}

export function parseWorkspaceProfileFixture(input: {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly account: string;
  readonly rulePaths: ReadonlyArray<string>;
  readonly repos: ReadonlyArray<{
    readonly host: string;
    readonly owner: string;
    readonly repo: string;
    readonly localPath?: string;
  }>;
}): ReturnType<typeof parseWorkspaceProfileConfig> {
  const { host, account, ...fields } = input;
  return parseWorkspaceProfileConfig({
    ...fields,
    schemaVersion: 1,
    localRepositoryCatalogGeneration: "12345678-1234-4234-8234-123456789abc",
    github: { kind: "connected", host, account },
  });
}
