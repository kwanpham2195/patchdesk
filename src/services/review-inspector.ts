import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve, win32 } from "node:path";

import { err, ok, type Result } from "../domain/result";
import { isPathContained } from "../adapters/storage/path-containment";
import { writeAtomicFile } from "../adapters/storage/json-file";

const MAX_ANALYSIS_INSPECTION_CALLS = 8;
const MAX_GIT_SHOW_BYTES = 512 * 1024;
export type InspectorDenied = {
  readonly _tag: "InspectorDenied";
  readonly reason: "invalid_input" | "outside_snapshot" | "budget_exhausted";
};
type InspectorInput = {
  readonly worktreePath: string;
  readonly changedFiles: ReadonlyArray<string>;
  readonly fileSnapshots?: Readonly<Record<string, string>>;
  readonly debugPath?: string;
  readonly allowedRevisions?: ReadonlyArray<string>;
  readonly gitShow: (argv: ReadonlyArray<string>) => Promise<string>;
};
type InspectorDebug = {
  readonly inspectedFileCount: number;
  readonly searchCount: number;
  readonly gitShowCount: number;
  readonly profileRuleLoadFailureCount: number;
};

/** Session-bound allowlist for model inspection; it intentionally has no arbitrary command method. */
export class ReviewInspector {
  private inspectedFileCount = 0;
  private searchCount = 0;
  private gitShowCount = 0;
  private inspectionCallCount = 0;
  constructor(private readonly input: InspectorInput) {}

  async listChangedFiles(): Promise<
    Result<ReadonlyArray<string>, InspectorDenied>
  > {
    if (!this.consume()) return denied("budget_exhausted");
    return ok(
      this.input.fileSnapshots === undefined
        ? this.input.changedFiles
        : Object.keys(this.input.fileSnapshots),
    );
  }

  async searchFiles(
    query: string,
  ): Promise<Result<ReadonlyArray<string>, InspectorDenied>> {
    if (!this.consume()) return denied("budget_exhausted");
    if (!safeQuery(query)) return denied("invalid_input");
    this.searchCount += 1;
    await this.persistDebug();
    const contents = await mapConcurrent(this.input.changedFiles, 4, (path) =>
      this.readWhole(path, false),
    );
    await this.persistDebug();
    return ok(
      this.input.changedFiles.flatMap((path, index) => {
        const content = contents[index];
        return content?._tag === "ok" && content.value.includes(query)
          ? [path]
          : [];
      }),
    );
  }

  async readFileRange(
    path: string,
    startLine: number,
    endLine: number,
  ): Promise<Result<string, InspectorDenied>> {
    if (!this.consume()) return denied("budget_exhausted");
    if (
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine
    )
      return denied("invalid_input");
    const file = await this.readWhole(path);
    if (file._tag === "err") return file;
    return ok(
      file.value
        .split("\n")
        .slice(startLine - 1, endLine)
        .join("\n"),
    );
  }

  async gitShow(revision: string): Promise<Result<string, InspectorDenied>> {
    if (!this.consume()) return denied("budget_exhausted");
    const allowedRevisions = this.input.allowedRevisions ?? ["HEAD"];
    if (!allowedRevisions.includes(revision)) return denied("invalid_input");
    let worktreePath: string;
    try {
      worktreePath = await realpath(this.input.worktreePath);
    } catch {
      return denied("outside_snapshot");
    }
    const argv = [
      "git",
      "--no-replace-objects",
      "-C",
      worktreePath,
      "show",
      "--format=",
      "--no-ext-diff",
      revision,
    ] as const;
    this.gitShowCount += 1;
    await this.persistDebug();
    const output = await this.input.gitShow(argv);
    return Buffer.byteLength(output, "utf8") > MAX_GIT_SHOW_BYTES
      ? denied("outside_snapshot")
      : ok(output);
  }

  debug(): InspectorDebug {
    return {
      inspectedFileCount: this.inspectedFileCount,
      searchCount: this.searchCount,
      gitShowCount: this.gitShowCount,
      profileRuleLoadFailureCount: 0,
    };
  }

  private async readWhole(
    path: string,
    persistDebug = true,
  ): Promise<Result<string, InspectorDenied>> {
    if (!isRelative(path)) return denied("invalid_input");
    const { fileSnapshots } = this.input;
    if (fileSnapshots !== undefined) {
      if (!Object.hasOwn(fileSnapshots, path))
        return denied("outside_snapshot");
      const snapshot = fileSnapshots[path];
      if (snapshot === undefined) return denied("outside_snapshot");
      this.inspectedFileCount += 1;
      if (persistDebug) await this.persistDebug();
      return ok(snapshot);
    }
    try {
      const root = await realpath(this.input.worktreePath);
      const candidate = resolve(root, path);
      if (!isContainedPath(root, candidate)) return denied("outside_snapshot");
      const resolved = await realpath(candidate);
      if (!isContainedPath(root, resolved)) return denied("outside_snapshot");
      this.inspectedFileCount += 1;
      if (persistDebug) await this.persistDebug();
      return ok(await readFile(resolved, "utf8"));
    } catch {
      return denied("outside_snapshot");
    }
  }

  private consume(): boolean {
    if (this.inspectionCallCount >= MAX_ANALYSIS_INSPECTION_CALLS) return false;
    this.inspectionCallCount += 1;
    return true;
  }

  private async persistDebug(): Promise<void> {
    if (this.input.debugPath === undefined) return;
    let profileRuleLoadFailureCount = 0;
    try {
      const raw: unknown = JSON.parse(
        await readFile(this.input.debugPath, "utf8"),
      );
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        const count = Object.getOwnPropertyDescriptor(
          raw,
          "profileRuleLoadFailureCount",
        )?.value;
        if (
          typeof count === "number" &&
          Number.isSafeInteger(count) &&
          count >= 0
        )
          profileRuleLoadFailureCount = count;
      }
    } catch {
      /* Context owns the initial diagnostic artifact. */
    }
    await writeAtomicFile(
      this.input.debugPath,
      JSON.stringify({ ...this.debug(), profileRuleLoadFailureCount }, null, 2),
    );
  }
}

async function mapConcurrent<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<ReadonlyArray<R>> {
  const values: Array<R> = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    const index = nextIndex;
    nextIndex += 1;
    const item = items[index];
    if (item === undefined) return;
    values[index] = await map(item);
    return worker();
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return values;
}

function isRelative(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !win32.isAbsolute(path) &&
    !isWindowsDriveRelative(path) &&
    !path.includes("\0") &&
    !path.split(/[\\/]/).includes("..")
  );
}
/**
 * Unlike the shared `isPathContained` predicate (which the preparation
 * journal relies on treating a path equal to its root as contained), the
 * inspector must reject the snapshot root itself: reading a file by
 * relative path must never resolve to the worktree root directory. That
 * extra condition lives here rather than in the shared predicate, which
 * cannot silently satisfy both contracts at once.
 */
function isContainedPath(root: string, candidate: string): boolean {
  return (
    resolve(root) !== resolve(candidate) && isPathContained(root, candidate)
  );
}
function isWindowsDriveRelative(path: string): boolean {
  return /^[a-z]:/i.test(path);
}
function safeQuery(query: string): boolean {
  return query.length > 0 && query.length <= 200 && !query.includes("\0");
}
function denied(
  reason: InspectorDenied["reason"],
): Result<never, InspectorDenied> {
  return err({ _tag: "InspectorDenied", reason });
}
