import { readFile, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { err, ok, type Result } from "../domain/result";

export type InspectorDenied = { readonly _tag: "InspectorDenied" };
type InspectorInput = { readonly worktreePath: string; readonly changedFiles: ReadonlyArray<string>; readonly gitShow: (argv: ReadonlyArray<string>) => Promise<string> };

/** Session-bound allowlist for model inspection; it intentionally has no arbitrary command method. */
export class ReviewInspector {
  private readonly inspectedPaths: Array<string> = [];
  private readonly searches: Array<string> = [];
  private readonly allowedReadCommands: Array<ReadonlyArray<string>> = [];
  constructor(private readonly input: InspectorInput) {}

  async listChangedFiles(): Promise<Result<ReadonlyArray<string>, never>> { return ok(this.input.changedFiles); }

  async searchFiles(query: string): Promise<Result<ReadonlyArray<string>, InspectorDenied>> {
    if (!safeQuery(query)) return err({ _tag: "InspectorDenied" });
    this.searches.push(query);
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
    const argv = ["git", "show", "--format=", "--no-ext-diff", revision] as const;
    this.allowedReadCommands.push(argv);
    return ok(await this.input.gitShow(argv));
  }

  debug(): { readonly inspectedPaths: ReadonlyArray<string>; readonly searches: ReadonlyArray<string>; readonly allowedReadCommands: ReadonlyArray<ReadonlyArray<string>> } {
    return { inspectedPaths: this.inspectedPaths, searches: this.searches, allowedReadCommands: this.allowedReadCommands };
  }

  private async readWhole(path: string): Promise<Result<string, InspectorDenied>> {
    if (!isRelative(path)) return err({ _tag: "InspectorDenied" });
    try {
      const root = await realpath(this.input.worktreePath);
      const candidate = resolve(root, path);
      if (relative(root, candidate).startsWith("..")) return err({ _tag: "InspectorDenied" });
      const resolved = await realpath(candidate);
      if (relative(root, resolved).startsWith("..")) return err({ _tag: "InspectorDenied" });
      if (!this.inspectedPaths.includes(path)) this.inspectedPaths.push(path);
      return ok(await readFile(resolved, "utf8"));
    } catch { return err({ _tag: "InspectorDenied" }); }
  }
}

function isRelative(path: string): boolean { return path.length > 0 && !path.startsWith("/") && !path.includes("\0") && !path.split("/").includes(".."); }
function safeQuery(query: string): boolean { return query.length > 0 && query.length <= 200 && !query.includes("\0"); }
