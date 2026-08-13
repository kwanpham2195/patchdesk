import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { err, ok, type Result } from "../domain/result";
import { containsSensitiveData } from "../adapters/storage/json-file";

export type ReviewContextFailure = { readonly _tag: "ReviewContextFailed" };
type ProjectReviewCriterion = {
  readonly label: string;
  readonly text: string;
};

type LoadedProjectReviewCriteria = {
  readonly criteria: ReadonlyArray<ProjectReviewCriterion>;
  readonly failureCount: number;
};

const MAX_RULE_BYTES = 128 * 1024;
const MAX_TOTAL_RULE_BYTES = 512 * 1024;
type ContextInput = {
  readonly worktreePath: string;
  readonly preparedDirectory: string;
  readonly pr: { readonly title: string; readonly headSha: string };
  readonly comments: unknown;
  readonly checks: unknown;
  readonly changedFiles: ReadonlyArray<string>;
  readonly patch: { readonly path: string; readonly sha256: string };
  readonly rulePaths: ReadonlyArray<string>;
};

/** Produces a compact, secret-safe review bundle with bounded repository rule evidence. */
export class ReviewContextService {
  async prepare(input: ContextInput): Promise<
    Result<
      {
        readonly contextPath: string;
        readonly reviewInputPath: string;
        readonly debugPath: string;
        readonly contextHash: string;
      },
      ReviewContextFailure
    >
  > {
    if (
      input.changedFiles.some(
        (path) => path.startsWith("/") || path.split("/").includes(".."),
      )
    )
      return err({ _tag: "ReviewContextFailed" });
    if (
      containsSensitiveData({
        pr: input.pr,
        comments: input.comments,
        checks: input.checks,
        patch: input.patch,
      })
    )
      return err({ _tag: "ReviewContextFailed" });
    try {
      await mkdir(input.preparedDirectory, { recursive: true });
      const projectReviewCriteria = await this.loadProjectReviewCriteria(
        input.worktreePath,
        input.rulePaths,
      );
      const packageSummary = await this.packageSummary(input.worktreePath);
      const context = {
        pr: input.pr,
        comments: input.comments,
        checks: input.checks,
        changedFiles: input.changedFiles,
        patch: input.patch,
        projectReviewCriteria: projectReviewCriteria.criteria,
        packageSummary,
      };
      const rendered = JSON.stringify(context, null, 2);
      const contextPath = join(input.preparedDirectory, "context.json");
      const reviewInputPath = join(input.preparedDirectory, "review-input.md");
      const debugPath = join(input.preparedDirectory, "debug.json");
      await writeFile(contextPath, rendered, "utf8");
      await writeFile(
        reviewInputPath,
        `# PR review input\n\nPR: ${input.pr.title}\nHead: ${input.pr.headSha}\nChanged files: ${input.changedFiles.length}\n`,
        "utf8",
      );
      await writeFile(
        debugPath,
        JSON.stringify(
          {
            inspectedFileCount: 0,
            searchCount: 0,
            gitShowCount: 0,
            profileRuleLoadFailureCount: projectReviewCriteria.failureCount,
          },
          null,
          2,
        ),
        "utf8",
      ).catch(() => undefined);
      return ok({
        contextPath,
        reviewInputPath,
        debugPath,
        contextHash: createHash("sha256").update(rendered).digest("hex"),
      });
    } catch {
      return err({ _tag: "ReviewContextFailed" });
    }
  }

  private async loadProjectReviewCriteria(
    worktreePath: string,
    rulePaths: ReadonlyArray<string>,
  ): Promise<LoadedProjectReviewCriteria> {
    const candidates = [
      {
        label: "AGENTS.md",
        path: join(worktreePath, "AGENTS.md"),
        optional: true,
      },
      {
        label: "CONTRIBUTING.md",
        path: join(worktreePath, "CONTRIBUTING.md"),
        optional: true,
      },
      ...rulePaths.map((path, index) => ({
        label: `configured-rule-${index + 1}`,
        path,
        optional: false,
      })),
    ];
    const criteria: ProjectReviewCriterion[] = [];
    let totalBytes = 0;
    let failureCount = 0;

    for (const candidate of candidates) {
      const rule = await readRuleFile(
        candidate.path,
        candidate.label,
        totalBytes,
      );
      if (rule.criterion === undefined) {
        if (!candidate.optional || !rule.missing) failureCount += 1;
        continue;
      }
      criteria.push(rule.criterion);
      totalBytes += Buffer.byteLength(rule.criterion.text, "utf8");
    }
    return { criteria, failureCount };
  }

  private async packageSummary(
    worktreePath: string,
  ): Promise<{ readonly name?: string; readonly packageManager?: string }> {
    try {
      const raw: unknown = JSON.parse(
        await readFile(join(worktreePath, "package.json"), "utf8"),
      );
      if (typeof raw !== "object" || raw === null) return {};
      const item = raw as { name?: unknown; packageManager?: unknown };
      return {
        ...(typeof item.name === "string" ? { name: item.name } : {}),
        ...(typeof item.packageManager === "string"
          ? { packageManager: item.packageManager }
          : {}),
      };
    } catch {
      return {};
    }
  }
}

async function readRuleFile(
  path: string,
  label: string,
  usedBytes: number,
): Promise<{
  readonly criterion: ProjectReviewCriterion | undefined;
  readonly missing: boolean;
}> {
  try {
    const metadata = await lstat(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > MAX_RULE_BYTES
    )
      return { criterion: undefined, missing: false };
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const openedMetadata = await handle.stat();
      if (!openedMetadata.isFile() || openedMetadata.size > MAX_RULE_BYTES)
        return { criterion: undefined, missing: false };
      const text = await handle.readFile("utf8");
      const bytes = Buffer.byteLength(text, "utf8");
      if (
        bytes > MAX_RULE_BYTES ||
        usedBytes + bytes > MAX_TOTAL_RULE_BYTES ||
        containsSensitiveData(text)
      )
        return { criterion: undefined, missing: false };
      return { criterion: { label, text }, missing: false };
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (cause: unknown) {
    return { criterion: undefined, missing: isNotFound(cause) };
  }
}

function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}
