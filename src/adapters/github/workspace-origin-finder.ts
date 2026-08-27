import { dirname } from "node:path";

import type {
  DiscoveredWorkspaceOrigin,
  OriginFinder,
} from "../../services/dashboard-service";
import { mapConcurrent } from "../../domain/map-concurrent";
import type { CommandRunner } from "./command-runner";

/** Main-process-only discovery of Git remotes below explicitly configured workspace roots. */
export class WorkspaceOriginFinder implements OriginFinder {
  constructor(private readonly commands: CommandRunner) {}

  async findOrigins(
    roots: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<DiscoveredWorkspaceOrigin>> {
    const origins = new Map<string, string>();
    const directoryResults = await mapConcurrent(roots, 3, (root) =>
      this.commands.runText({
        argv: [
          "find",
          root,
          "-maxdepth",
          "4",
          "-type",
          "d",
          "-name",
          ".git",
          "-print",
        ],
        timeoutMs: 5_000,
      }),
    );
    const gitDirectories = directoryResults.flatMap((result) =>
      result._tag === "ok"
        ? result.value.split("\n").filter((directory) => directory.length > 0)
        : [],
    );
    const remoteOrigins = await mapConcurrent(gitDirectories, 4, (directory) =>
      this.commands.runText({
        argv: [
          "git",
          "-C",
          dirname(directory),
          "config",
          "--get",
          "remote.origin.url",
        ],
        timeoutMs: 5_000,
      }),
    );
    for (const [index, origin] of remoteOrigins.entries()) {
      const directory = gitDirectories[index];
      if (directory === undefined || origin._tag === "err") continue;
      const value = origin.value.trim();
      if (value.length > 0 && !origins.has(value))
        origins.set(value, dirname(directory));
    }
    return [...origins].map(([origin, localPath]) => ({ origin, localPath }));
  }
}
