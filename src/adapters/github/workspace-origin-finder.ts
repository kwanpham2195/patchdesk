import { dirname } from "node:path";

import type {
  DiscoveredWorkspaceOrigin,
  OriginFinder,
} from "../../services/dashboard-service";
import type { CommandRunner } from "./command-runner";

/** Main-process-only discovery of Git remotes below explicitly configured workspace roots. */
export class WorkspaceOriginFinder implements OriginFinder {
  constructor(private readonly commands: CommandRunner) {}

  async findOrigins(
    roots: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<DiscoveredWorkspaceOrigin>> {
    const origins = new Map<string, string>();
    for (const root of roots) {
      const gitDirectories = await this.commands.runText({
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
      });
      if (gitDirectories._tag === "err") continue;
      for (const gitDirectory of gitDirectories.value.split("\n")) {
        if (gitDirectory.length === 0) continue;
        const origin = await this.commands.runText({
          argv: [
            "git",
            "-C",
            dirname(gitDirectory),
            "config",
            "--get",
            "remote.origin.url",
          ],
          timeoutMs: 5_000,
        });
        const value = origin._tag === "ok" ? origin.value.trim() : "";
        if (value.length > 0 && !origins.has(value))
          origins.set(value, dirname(gitDirectory));
      }
    }
    return [...origins].map(([origin, localPath]) => ({ origin, localPath }));
  }
}
