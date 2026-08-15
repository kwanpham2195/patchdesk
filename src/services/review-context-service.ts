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
/** Aggregate rendered budget for context.json; matches the walkthrough consumer read cap. */
const MAX_CONTEXT_JSON_BYTES = 512 * 1024;
const MAX_CONTEXT_CHECKS_BYTES = 64 * 1024;
const MAX_CONTEXT_THREADS_BYTES = 256 * 1024;
const MAX_CONTEXT_FILES_BYTES = 128 * 1024;

/** Structural slices of the GitHub snapshots that the bundle bounds by bytes. */
type ContextComments = {
  readonly threads: ReadonlyArray<unknown>;
};
type ContextChecks = {
  readonly overall?: unknown;
  readonly checks?: ReadonlyArray<unknown>;
};
type ContextInput = {
  readonly worktreePath: string;
  readonly preparedDirectory: string;
  readonly pr: { readonly title: string; readonly headSha: string };
  readonly comments: ContextComments;
  readonly checks: ContextChecks;
  readonly changedFiles: ReadonlyArray<string>;
  readonly patch: { readonly path: string; readonly sha256: string };
  readonly rulePaths: ReadonlyArray<string>;
};

/** Keeps the longest prefix of items whose compact JSON fits one byte budget. */
function fitPrefix<T>(
  items: ReadonlyArray<T>,
  maxBytes: number,
): { readonly kept: ReadonlyArray<T>; readonly dropped: number } {
  let bytes = 0;
  const kept: Array<T> = [];
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item) ?? "", "utf8");
    if (bytes + size > maxBytes) break;
    kept.push(item);
    bytes += size;
  }
  return { kept, dropped: items.length - kept.length };
}

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
      const truncated = { checks: 0, threads: 0, files: 0, rules: 0 };
      let checks = input.checks;
      let comments = input.comments;
      let changedFiles = input.changedFiles;
      let criteria = projectReviewCriteria.criteria;
      const checksTrim = fitPrefix(
        checks.checks ?? [],
        MAX_CONTEXT_CHECKS_BYTES,
      );
      if (checksTrim.dropped > 0) {
        checks = { ...checks, checks: checksTrim.kept };
        truncated.checks = checksTrim.dropped;
      }
      const threadsTrim = fitPrefix(
        comments.threads,
        MAX_CONTEXT_THREADS_BYTES,
      );
      if (threadsTrim.dropped > 0) {
        comments = { ...comments, threads: threadsTrim.kept };
        truncated.threads = threadsTrim.dropped;
      }
      const filesTrim = fitPrefix(changedFiles, MAX_CONTEXT_FILES_BYTES);
      if (filesTrim.dropped > 0) {
        changedFiles = filesTrim.kept;
        truncated.files = filesTrim.dropped;
      }
      const render = (): string =>
        JSON.stringify(
          {
            pr: input.pr,
            comments,
            checks,
            changedFiles,
            patch: input.patch,
            projectReviewCriteria: criteria,
            packageSummary,
            truncated,
          },
          null,
          2,
        );
      let rendered = render();
      while (
        Buffer.byteLength(rendered, "utf8") > MAX_CONTEXT_JSON_BYTES &&
        criteria.length > 0
      ) {
        criteria = criteria.slice(0, -1);
        truncated.rules += 1;
        rendered = render();
      }
      if (Buffer.byteLength(rendered, "utf8") > MAX_CONTEXT_JSON_BYTES)
        return err({ _tag: "ReviewContextFailed" });
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
