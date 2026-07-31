import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

import { err, ok, type Result } from "../domain/result";

export type InspectorDenied = { readonly _tag: "InspectorDenied" };
type InspectorInput = { readonly worktreePath: string; readonly changedFiles: ReadonlyArray<string>; readonly fileSnapshots?: Readonly<Record<string, string>>; readonly debugPath?: string; readonly gitShow: (argv: ReadonlyArray<string>) => Promise<string> };

/** Session-bound allowlist for model inspection; it intentionally has no arbitrary command method. */
export class ReviewInspector {
  private readonly inspectedPaths: Array<string> = [];
  private readonly searches: Array<string> = [];
  private readonly allowedReadCommands: Array<ReadonlyArray<string>> = [];
  constructor(private readonly input: InspectorInput) {}

  async listChangedFiles(): Promise<Result<ReadonlyArray<string>, never>> {
    return ok(this.input.fileSnapshots === undefined ? this.input.changedFiles : Object.keys(this.input.fileSnapshots));
  }

  async searchFiles(query: string): Promise<Result<ReadonlyArray<string>, InspectorDenied>> {
    if (!safeQuery(query)) return err({ _tag: "InspectorDenied" });
    this.searches.push(query);
    await this.persistDebug();
    const matches: Array<string> = [];
    for (const path of this.input.changedFiles) {
      const content = await this.readWhole(path);
      if (content._tag === "ok" && content.value.includes(query)) matches.push(path);
    }
    return ok(matches);
  }

  async readFileRange(path: string, startLine: number, endLine: number): Promise<Result<string, InspectorDenied>> {
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) return err({ _tag: "InspectorDenied" });
    const file = await this.readWhole(path);
    if (file._tag === "err") return file;
    return ok(file.value.split("\n").slice(startLine - 1, endLine).join("\n"));
  }

  async gitShow(revision: string): Promise<Result<string, InspectorDenied>> {
    if (revision !== "HEAD" && !/^[a-f0-9]{40,64}$/.test(revision)) return err({ _tag: "InspectorDenied" });
    let worktreePath: string;
    try { worktreePath = await realpath(this.input.worktreePath); } catch { return err({ _tag: "InspectorDenied" }); }
    const argv = ["git", "-C", worktreePath, "show", "--format=", "--no-ext-diff", revision] as const;
    this.allowedReadCommands.push(argv);
    await this.persistDebug();
    return ok(await this.input.gitShow(argv));
  }

  debug(): { readonly inspectedPaths: ReadonlyArray<string>; readonly searches: ReadonlyArray<string>; readonly allowedReadCommands: ReadonlyArray<ReadonlyArray<string>> } {
    return { inspectedPaths: this.inspectedPaths, searches: this.searches, allowedReadCommands: this.allowedReadCommands };
  }

  private async readWhole(path: string): Promise<Result<string, InspectorDenied>> {
    if (!isRelative(path)) return err({ _tag: "InspectorDenied" });
    const { fileSnapshots } = this.input;
    if (fileSnapshots !== undefined) {
      if (!Object.hasOwn(fileSnapshots, path)) return err({ _tag: "InspectorDenied" });
      const snapshot = fileSnapshots[path];
      if (snapshot === undefined) return err({ _tag: "InspectorDenied" });
      if (!this.inspectedPaths.includes(path)) this.inspectedPaths.push(path);
      return ok(snapshot);
    }
    try {
      const root = await realpath(this.input.worktreePath);
      const candidate = resolve(root, path);
      if (!isContainedPath(root, candidate)) return err({ _tag: "InspectorDenied" });
      const resolved = await realpath(candidate);
      if (!isContainedPath(root, resolved)) return err({ _tag: "InspectorDenied" });
      if (!this.inspectedPaths.includes(path)) { this.inspectedPaths.push(path); await this.persistDebug(); }
      return ok(await readFile(resolved, "utf8"));
    } catch { return err({ _tag: "InspectorDenied" }); }
  }

  private async persistDebug(): Promise<void> {
    if (this.input.debugPath === undefined) return;
    let existing: Record<string, unknown> = {};
    try { const raw: unknown = JSON.parse(await readFile(this.input.debugPath, "utf8")); if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) existing = raw as Record<string, unknown>; } catch { /* Context owns first write; inspector only adds safe operation fields. */ }
    await writeFile(this.input.debugPath, JSON.stringify({ ...existing, ...this.debug() }, null, 2), "utf8");
  }
}

function isRelative(path: string): boolean { return path.length > 0 && !isAbsolute(path) && !win32.isAbsolute(path) && !path.includes("\0") && !path.split(/[\\/]/).includes(".."); }
function isContainedPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath.length > 0 && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}
function safeQuery(query: string): boolean { return query.length > 0 && query.length <= 200 && !query.includes("\0"); }
