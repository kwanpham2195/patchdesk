import {
  parseLocalRepositoryId,
  type LocalRepositoryId,
} from "./local-repository";
import * as v from "valibot";

import { definedProps } from "./defined-props";
import {
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubLogin,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseWorkspaceProfileId,
  type AbsolutePath,
  type GitHubHost,
  type GitHubLogin,
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
  readonly localRepositoryId?: LocalRepositoryId;
};

export type AnalysisMergePolicy =
  | "advisory"
  | "require_acknowledgement"
  | "block";

export type GitHubConnection =
  | { readonly kind: "disconnected" }
  | {
      readonly kind: "connected";
      readonly host: GitHubHost;
      readonly account: GitHubLogin;
    };

export type ConnectedWorkspaceProfile = WorkspaceProfileConfig & {
  readonly github: Extract<GitHubConnection, { kind: "connected" }>;
};

export function isConnectedWorkspaceProfile(
  profile: WorkspaceProfileConfig,
): profile is ConnectedWorkspaceProfile {
  return profile.github.kind === "connected";
}

export type WorkspaceProfileConfig = {
  readonly schemaVersion: 1;
  readonly localRepositoryCatalogGeneration: string;
  readonly id: WorkspaceProfileId;
  readonly label: string;
  readonly github: GitHubConnection;
  readonly rulePaths: ReadonlyArray<AbsolutePath>;
  readonly repos: ReadonlyArray<WatchedRepoConfig>;
  readonly analysisMergePolicy?: AnalysisMergePolicy;
};

export type InvalidWorkspaceProfileConfig = {
  readonly _tag: "InvalidWorkspaceProfileConfig";
};

const rawWatchedRepoSchema = v.strictObject({
  host: v.string(),
  owner: v.string(),
  repo: v.string(),
  localPath: v.optional(v.string()),
  localRepositoryId: v.optional(v.string()),
});

/**
 * Valibot boundary schema for a persisted workspace-profile JSON record.
 * Strict, so an unrecognised key fails the record closed; every key Patchdesk
 * has retired is listed here instead.
 */
const profileFields = {
  id: v.string(),
  label: v.pipe(v.string(), v.minLength(1)),
  rulePaths: v.array(v.string()),
  repos: v.array(rawWatchedRepoSchema),
  analysisMergePolicy: v.optional(
    v.picklist(["advisory", "require_acknowledgement", "block"]),
  ),
};
const legacyWorkspaceProfileSchema = v.strictObject({
  ...profileFields,
  githubHost: v.string(),
  ghAccount: v.pipe(v.string(), v.minLength(1)),
  ownerFilters: v.optional(v.unknown()),
  workspaceRoots: v.optional(v.unknown()),
});
const workspaceProfileConfigSchema = v.strictObject({
  ...profileFields,
  schemaVersion: v.literal(1),
  localRepositoryCatalogGeneration: v.pipe(v.string(), v.uuid()),
  github: v.variant("kind", [
    v.strictObject({ kind: v.literal("disconnected") }),
    v.strictObject({
      kind: v.literal("connected"),
      host: v.string(),
      account: v.string(),
    }),
  ]),
});

/** Bootstrap input only; normal profile readers accept schema 1 exclusively. */
export function parsePreSchemaWorkspaceProfile(
  input: unknown,
): Result<
  Omit<
    WorkspaceProfileConfig,
    "schemaVersion" | "localRepositoryCatalogGeneration"
  >,
  InvalidWorkspaceProfileConfig
> {
  const parsed = v.safeParse(legacyWorkspaceProfileSchema, input);
  if (!parsed.success) return err({ _tag: "InvalidWorkspaceProfileConfig" });
  const raw = parsed.output;
  const id = parseWorkspaceProfileId(raw.id),
    github = parseConnectedGitHub({
      host: raw.githubHost,
      account: raw.ghAccount,
    });
  const rulePaths = parseAll(raw.rulePaths, parseAbsolutePath),
    repos = parseAll(raw.repos, parseWatchedRepo);
  if (
    id._tag === "err" ||
    github._tag === "err" ||
    rulePaths._tag === "err" ||
    repos._tag === "err"
  )
    return err({ _tag: "InvalidWorkspaceProfileConfig" });
  return ok({
    id: id.value,
    label: raw.label,
    github: github.value,
    rulePaths: rulePaths.value,
    repos: repos.value,
    analysisMergePolicy: raw.analysisMergePolicy ?? "require_acknowledgement",
  });
}

/** Parse unknown profile configuration into refined Patchdesk domain values. */
export function parseWorkspaceProfileConfig(
  input: unknown,
): Result<WorkspaceProfileConfig, InvalidWorkspaceProfileConfig> {
  const parsed = v.safeParse(workspaceProfileConfigSchema, input);
  if (!parsed.success) {
    return err({ _tag: "InvalidWorkspaceProfileConfig" });
  }

  const id = parseWorkspaceProfileId(parsed.output.id);
  const rawGitHub = parsed.output.github;
  const github =
    rawGitHub.kind === "disconnected"
      ? ok({ kind: "disconnected" } as const)
      : parseConnectedGitHub(rawGitHub);
  const rulePaths = parseAll(parsed.output.rulePaths, parseAbsolutePath);
  const repos = parseAll(parsed.output.repos, parseWatchedRepo);
  if (
    id._tag === "err" ||
    github._tag === "err" ||
    rulePaths._tag === "err" ||
    repos._tag === "err"
  ) {
    return err({ _tag: "InvalidWorkspaceProfileConfig" });
  }

  return ok({
    id: id.value,
    label: parsed.output.label,
    schemaVersion: 1,
    localRepositoryCatalogGeneration:
      parsed.output.localRepositoryCatalogGeneration,
    github: github.value,
    rulePaths: rulePaths.value,
    repos: repos.value,
    analysisMergePolicy:
      parsed.output.analysisMergePolicy ?? "require_acknowledgement",
  });
}

function parseWatchedRepo(
  input: v.InferOutput<typeof rawWatchedRepoSchema>,
): Result<WatchedRepoConfig, InvalidWorkspaceProfileConfig> {
  const host = parseGitHubHost(input.host);
  const owner = parseGitHubOwner(input.owner);
  const repo = parseGitHubRepoName(input.repo);
  const localRepositoryId =
    input.localRepositoryId === undefined
      ? undefined
      : parseLocalRepositoryId(input.localRepositoryId);
  const localPath =
    input.localPath === undefined
      ? undefined
      : parseAbsolutePath(input.localPath);
  if (
    localRepositoryId?._tag === "err" ||
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
    ...definedProps({
      localPath: localPath?.value,
      localRepositoryId: localRepositoryId?.value,
    }),
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

function parseConnectedGitHub(raw: {
  host: string;
  account: string;
}): Result<GitHubConnection, InvalidWorkspaceProfileConfig> {
  const host = parseGitHubHost(raw.host),
    account = parseGitHubLogin(raw.account);
  return host._tag === "ok" && account._tag === "ok"
    ? ok({ kind: "connected", host: host.value, account: account.value })
    : err({ _tag: "InvalidWorkspaceProfileConfig" });
}
