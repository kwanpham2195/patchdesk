import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { CommandRunner } from "#src/adapters/github/command-runner";
import { parseAbsolutePath } from "#src/domain/ids";
import {
  parseLocalRepositoryId,
  type GitHubRepositoryKey,
  type LocalRepositoryRegistration,
} from "#src/domain/local-repository";
import { ok, type Result } from "#src/domain/result";
import type { WorkspaceProfileConfig } from "#src/domain/workspace-profile";
import { refusal, type Refusal } from "./local-repository-upgrade-refusal";

export async function resolveRegistrations(
  commands: CommandRunner,
  profileFile: string,
  profile: Pick<WorkspaceProfileConfig, "repos">,
  keys: ReadonlyArray<GitHubRepositoryKey>,
): Promise<Result<ReadonlyArray<LocalRepositoryRegistration>, Refusal>> {
  const repositories: LocalRepositoryRegistration[] = [];
  const unreadableProfile = refusal({
    reason: "profile_unreadable",
    storageReason: "invalid_stored_value",
    file: profileFile,
  });
  for (const key of keys) {
    const id = parseLocalRepositoryId(randomUUID());
    if (id._tag === "err") return unreadableProfile;
    const base = {
      id: id.value,
      identityKey: key,
      displayName: `${key.owner}/${key.repo}`,
    };
    const watched = profile.repos.find(
      (repo) =>
        repo.host === key.host &&
        repo.owner === key.owner &&
        repo.repo === key.repo,
    );
    if (watched?.localPath === undefined) {
      repositories.push({ ...base, state: "unresolved" });
      continue;
    }
    const root = watched.localPath;
    const resolved = await commands.runText({
      argv: [
        "git",
        "rev-parse",
        "--show-toplevel",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      cwd: root,
      timeoutMs: 5_000,
    });
    if (resolved._tag === "err") {
      repositories.push({ ...base, state: "missing", configuredRoot: root });
      continue;
    }
    const [topLevel, commonDir, ...extra] = resolved.value.trim().split("\n");
    if (
      topLevel === undefined ||
      commonDir === undefined ||
      extra.length !== 0
    ) {
      repositories.push({
        ...base,
        state: "unresolved",
        configuredRoot: root,
      });
      continue;
    }
    try {
      const canonicalRoot = parseAbsolutePath(await realpath(topLevel));
      const common = parseAbsolutePath(await realpath(commonDir));
      if (canonicalRoot._tag === "err" || common._tag === "err")
        return unreadableProfile;
      repositories.push({
        ...base,
        state: "resolved",
        configuredRoot: root,
        canonicalCommonDirectory: common.value,
      });
    } catch {
      repositories.push({ ...base, state: "missing", configuredRoot: root });
    }
  }
  return ok(
    repositories.map((repo) =>
      repo.canonicalCommonDirectory !== undefined &&
      repositories.some(
        (other) =>
          other.id !== repo.id &&
          other.canonicalCommonDirectory === repo.canonicalCommonDirectory,
      )
        ? { ...repo, state: "unresolved" }
        : repo,
    ),
  );
}
