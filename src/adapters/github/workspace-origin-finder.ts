import { dirname } from "node:path";

import type {
  OriginFinder,
  WorkspaceOriginRootResult,
} from "../../services/dashboard-service";
import { mapConcurrent } from "../../domain/map-concurrent";
import type { CommandRunner } from "./command-runner";

/** Main-process-only discovery of Git remotes below explicitly configured workspace roots. */
export class WorkspaceOriginFinder implements OriginFinder {
  constructor(private readonly commands: CommandRunner) {}

  /**
   * Finds each unique configured root in first-input order. A root scan failure
   * is represented separately so callers can distinguish it from no checkouts.
   */
  async find(
    roots: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<WorkspaceOriginRootResult>> {
    const uniqueRoots = [...new Set(roots)];
    const scans = await mapConcurrent(uniqueRoots, 3, async (root) => ({
      root,
      result: await this.commands.runText({
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
    }));
    const directories = scans.flatMap((scan) =>
      scan.result._tag === "ok"
        ? scan.result.value
            .split("\n")
            .filter((directory) => directory.length > 0)
            .map((directory) => ({ root: scan.root, directory }))
        : [],
    );
    const remoteResults = await mapConcurrent(directories, 4, (entry) =>
      this.commands.runText({
        argv: [
          "git",
          "-C",
          dirname(entry.directory),
          "config",
          "--get",
          "remote.origin.url",
        ],
        timeoutMs: 5_000,
      }),
    );
    const originsByRoot = new Map<string, Map<string, string>>();
    for (const [index, remote] of remoteResults.entries()) {
      const directory = directories[index];
      if (directory === undefined || remote._tag === "err") continue;
      const origin = remote.value.trim();
      if (origin.length === 0) continue;
      const origins = originsByRoot.get(directory.root) ?? new Map();
      if (!originsByRoot.has(directory.root))
        originsByRoot.set(directory.root, origins);
      if (!origins.has(origin))
        origins.set(origin, dirname(directory.directory));
    }
    return scans.map((scan) => {
      if (scan.result._tag === "err") {
        return { root: scan.root, state: "failed", reason: "scan_failed" };
      }
      const origins = originsByRoot.get(scan.root) ?? new Map();
      return {
        root: scan.root,
        state: "ready",
        origins: [...origins].map(([origin, localPath]) => ({
          origin,
          localPath,
        })),
      };
    });
  }
}
