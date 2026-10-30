import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import { CommandRunner } from "#src/adapters/github/command-runner";
import { FakeGitHubAdapter } from "#src/adapters/github/github-adapter";
import { readBoundedInsightArtifactFile } from "#src/adapters/storage/insight-artifact-files";
import { LocalRepositoryStore } from "#src/adapters/storage/local-repository-store";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "#src/adapters/storage/profile-store";
import {
  parseLocalRepositoryId,
  type LocalRepositoryRegistration,
} from "#src/domain/local-repository";
import { ok } from "#src/domain/result";
import { createReadOnlyGitExecutor } from "#src/main/local-api-stores";
import { DashboardController } from "#src/services/dashboard-controller";
import { readCanonicalGitCommonDirectory } from "#src/services/local-checkout";
import { LocalRepositoryService } from "#src/services/local-repository-service";

/** A Review store with no saved Reviews, for tests that do not relocate. */
export const noReviews = {
  list: () => Promise.resolve(ok({ reviews: [], unreadable: 0, invalid: [] })),
};

export async function localRepositoryFixture(paths: PatchdeskPaths) {
  const profiles = new ProfileStore(paths);
  const catalog = new LocalRepositoryStore(paths);
  const git = createReadOnlyGitExecutor(new CommandRunner());
  const saved = await profiles.list();
  if (saved._tag === "err") throw new Error("Invalid fixture profiles");
  for (const profile of saved.value) {
    const current = await catalog.load(profile.id);
    if (current._tag === "err") throw new Error("Invalid fixture catalog");
    const repositories: LocalRepositoryRegistration[] = [];
    for (const repository of profile.repos) {
      if (repository.localPath === undefined) continue;
      const id = parseLocalRepositoryId(randomUUID());
      if (id._tag === "err") throw new Error("Invalid fixture registration ID");
      const common = await readCanonicalGitCommonDirectory(
        git,
        repository.localPath,
      );
      repositories.push({
        id: id.value,
        identityKey: {
          kind: "github",
          host: repository.host,
          owner: repository.owner,
          repo: repository.repo,
        },
        displayName: basename(repository.localPath),
        configuredRoot: repository.localPath,
        ...(common === undefined
          ? { state: "missing" as const }
          : { state: "resolved" as const, canonicalCommonDirectory: common }),
      });
    }
    const published = await catalog.save({
      ...current.value,
      revision: current.value.revision + 1,
      repositories,
    });
    if (published._tag === "err")
      throw new Error("Invalid fixture registrations");
  }
  return new LocalRepositoryService({
    profiles,
    catalog,
    git,
    paths,
    dashboard: new DashboardController(
      profiles,
      new FakeGitHubAdapter({}),
      git,
      paths,
      readBoundedInsightArtifactFile,
    ),
    logs: { write: () => undefined },
    reviews: noReviews,
  });
}
