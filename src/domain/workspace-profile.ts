import * as v from "valibot";

import {
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseWorkspaceProfileId,
  type AbsolutePath,
  type GitHubHost,
  type GitHubOwner,
  type GitHubRepoName,
  type WorkspaceProfileId,
} from "./ids";
import { err, ok, type Result } from "./result";

export type WatchedRepoConfig = {
  readonly host: GitHubHost;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
  readonly localPath?: AbsolutePath;
  readonly archived?: boolean;
};

export type WorkspaceProfileConfig = {
  readonly id: WorkspaceProfileId;
  readonly label: string;
  readonly githubHost: GitHubHost;
  readonly ghAccount: string;
  readonly ownerFilters: ReadonlyArray<GitHubOwner>;
  readonly workspaceRoots: ReadonlyArray<AbsolutePath>;
  readonly rulePaths: ReadonlyArray<AbsolutePath>;
  readonly repos: ReadonlyArray<WatchedRepoConfig>;
};

export type InvalidWorkspaceProfileConfig = {
  readonly _tag: "InvalidWorkspaceProfileConfig";
};

const rawWatchedRepoSchema = v.strictObject({
  host: v.string(),
  owner: v.string(),
  repo: v.string(),
  localPath: v.optional(v.string()),
  archived: v.optional(v.boolean()),
});

/** Valibot boundary schema for a persisted workspace-profile JSON record. */
export const workspaceProfileConfigSchema = v.strictObject({
  id: v.string(),
  label: v.pipe(v.string(), v.minLength(1)),
  githubHost: v.string(),
  ghAccount: v.pipe(v.string(), v.minLength(1)),
  ownerFilters: v.array(v.string()),
  workspaceRoots: v.array(v.string()),
  rulePaths: v.array(v.string()),
  repos: v.array(rawWatchedRepoSchema),
});

/** Parse unknown profile configuration into refined Patchdesk domain values. */
export function parseWorkspaceProfileConfig(
  input: unknown,
): Result<WorkspaceProfileConfig, InvalidWorkspaceProfileConfig> {
  const parsed = v.safeParse(workspaceProfileConfigSchema, input);
  if (!parsed.success) {
    return err({ _tag: "InvalidWorkspaceProfileConfig" });
  }

  const id = parseWorkspaceProfileId(parsed.output.id);
  const githubHost = parseGitHubHost(parsed.output.githubHost);
  const ownerFilters = parseAll(parsed.output.ownerFilters, parseGitHubOwner);
  const workspaceRoots = parseAll(
    parsed.output.workspaceRoots,
    parseAbsolutePath,
  );
  const rulePaths = parseAll(parsed.output.rulePaths, parseAbsolutePath);
  const repos = parseAll(parsed.output.repos, parseWatchedRepo);
  if (
    id._tag === "err" ||
    githubHost._tag === "err" ||
    ownerFilters._tag === "err" ||
    workspaceRoots._tag === "err" ||
    rulePaths._tag === "err" ||
    repos._tag === "err"
  ) {
    return err({ _tag: "InvalidWorkspaceProfileConfig" });
  }

  return ok({
    id: id.value,
    label: parsed.output.label,
    githubHost: githubHost.value,
    ghAccount: parsed.output.ghAccount,
    ownerFilters: ownerFilters.value,
    workspaceRoots: workspaceRoots.value,
    rulePaths: rulePaths.value,
    repos: repos.value,
  });
}

function parseWatchedRepo(
  input: v.InferOutput<typeof rawWatchedRepoSchema>,
): Result<WatchedRepoConfig, InvalidWorkspaceProfileConfig> {
  const host = parseGitHubHost(input.host);
  const owner = parseGitHubOwner(input.owner);
  const repo = parseGitHubRepoName(input.repo);
  const localPath =
    input.localPath === undefined
      ? undefined
      : parseAbsolutePath(input.localPath);
  if (
    host._tag === "err" ||
    owner._tag === "err" ||
    repo._tag === "err" ||
    (localPath !== undefined && localPath._tag === "err")
  ) {
    return err({ _tag: "InvalidWorkspaceProfileConfig" });
  }

  return ok({
    host: host.value,
    owner: owner.value,
    repo: repo.value,
    ...(localPath === undefined ? {} : { localPath: localPath.value }),
    ...(input.archived === undefined ? {} : { archived: input.archived }),
  });
}

function parseAll<T, E, U>(
  inputs: ReadonlyArray<T>,
  parser: (input: T) => Result<U, E>,
): Result<ReadonlyArray<U>, E> {
  const values: Array<U> = [];
  for (const input of inputs) {
    const parsed = parser(input);
    if (parsed._tag === "err") {
      return parsed;
    }

    values.push(parsed.value);
  }

  return ok(values);
}
