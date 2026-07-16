import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

import { err, ok, type Result } from "../domain/result";
import { containsSensitiveData } from "../adapters/storage/json-file";

export type ReviewContextFailure = { readonly _tag: "ReviewContextFailed" };
type ContextInput = {
  readonly worktreePath: string;
  readonly attemptDirectory: string;
  readonly pr: { readonly title: string; readonly headSha: string };
  readonly comments: unknown;
  readonly checks: unknown;
  readonly changedFiles: ReadonlyArray<string>;
  readonly patch: { readonly path: string; readonly sha256: string };
  readonly rulePaths: ReadonlyArray<string>;
};

/** Produces a compact, secret-safe review bundle without persisting source file contents. */
export class ReviewContextService {
  async prepare(input: ContextInput): Promise<Result<{ readonly contextPath: string; readonly reviewInputPath: string; readonly debugPath: string; readonly contextHash: string }, ReviewContextFailure>> {
    if (input.changedFiles.some((path) => path.startsWith("/") || path.split("/").includes(".."))) return err({ _tag: "ReviewContextFailed" });
    if (containsSensitiveData({ pr: input.pr, comments: input.comments, checks: input.checks, patch: input.patch })) return err({ _tag: "ReviewContextFailed" });
    try {
      await mkdir(input.attemptDirectory, { recursive: true });
      const rootRules = await this.rootRuleMetadata(input.worktreePath);
      const profileRules = await this.profileRuleMetadata(input.worktreePath, input.rulePaths);
      const packageSummary = await this.packageSummary(input.worktreePath);
      const context = { pr: input.pr, comments: input.comments, checks: input.checks, changedFiles: input.changedFiles, patch: input.patch, rootRules, profileRules, packageSummary };
      const rendered = JSON.stringify(context, null, 2);
      const contextPath = join(input.attemptDirectory, "context.json");
      const reviewInputPath = join(input.attemptDirectory, "review-input.md");
      const debugPath = join(input.attemptDirectory, "debug.json");
      await writeFile(contextPath, rendered, "utf8");
      await writeFile(reviewInputPath, `# PR review input\n\nPR: ${input.pr.title}\nHead: ${input.pr.headSha}\nChanged files: ${input.changedFiles.length}\n`, "utf8");
      await writeFile(debugPath, JSON.stringify({ inspectedPaths: [], searches: [], allowedReadCommands: [], profileRuleLoadFailures: profileRules.filter((rule) => rule.status === "unavailable").map((rule) => rule.path) }, null, 2), "utf8");
      return ok({ contextPath, reviewInputPath, debugPath, contextHash: createHash("sha256").update(rendered).digest("hex") });
    } catch { return err({ _tag: "ReviewContextFailed" }); }
  }

  private async rootRuleMetadata(worktreePath: string): Promise<ReadonlyArray<{ readonly path: string; readonly status: "available" | "missing" }>> {
    return await Promise.all(["AGENTS.md", "CONTRIBUTING.md"].map(async (name) => ({ path: name, status: await exists(join(worktreePath, name)) ? "available" as const : "missing" as const })));
  }

  private async profileRuleMetadata(worktreePath: string, paths: ReadonlyArray<string>): Promise<ReadonlyArray<{ readonly path: string; readonly status: "available" | "unavailable" }>> {
    return await Promise.all(paths.map(async (path) => ({ path: relative(worktreePath, path), status: await exists(path) ? "available" as const : "unavailable" as const })));
  }

  private async packageSummary(worktreePath: string): Promise<{ readonly name?: string; readonly packageManager?: string }> {
    try {
      const raw: unknown = JSON.parse(await readFile(join(worktreePath, "package.json"), "utf8"));
      if (typeof raw !== "object" || raw === null) return {};
      const item = raw as { name?: unknown; packageManager?: unknown };
      return { ...(typeof item.name === "string" ? { name: item.name } : {}), ...(typeof item.packageManager === "string" ? { packageManager: item.packageManager } : {}) };
    } catch { return {}; }
  }
}

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
