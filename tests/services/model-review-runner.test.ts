import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as v from "valibot";

import type { modelReviewResultSchema } from "../../src/domain/review-result";
import { runModelReview } from "../../src/services/model-review-runner";
import type { ReviewModelSession } from "../../src/services/model-review-runner";

type GitObjectFixture = string | {
  readonly contents: string;
  readonly mode?: string;
  readonly type?: string;
};

function gitBlobReader(
  blobs: Readonly<Record<string, GitObjectFixture>>,
  commands?: Array<ReadonlyArray<string>>,
): (argv: ReadonlyArray<string>) => Promise<string> {
  return async (argv) => {
    commands?.push(argv);
    const lsTreeIndex = argv.indexOf("ls-tree");
    const object = lsTreeIndex === -1
      ? argv.at(-1)
      : `${argv[lsTreeIndex + 2]}:${argv.at(-1)}`;
    if (object === undefined) return "";
    const fixture = blobs[object];
    if (fixture === undefined) return "";
    const entry = typeof fixture === "string" ? { contents: fixture } : fixture;
    if (argv.includes("ls-tree")) return `${entry.mode ?? "100644"}\n`;
    if (argv.includes("-t")) return `${entry.type ?? "blob"}\n`;
    if (argv.includes("-s")) return `${Buffer.byteLength(entry.contents)}\n`;
    return entry.contents;
  };
}

describe("model review runner", () => {
  it("passes the immutable patch, prepared metadata, and only the four inspector tools to a structured model operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-model-review-"));
    try {
      const headSha = "a".repeat(40);
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "review.ts"), "export const review = true;\n", "utf8");
      const contextPath = join(root, "context.json");
      const reviewInputPath = join(root, "review-input.md");
      const patchPath = join(root, "patch.diff");
      await writeFile(contextPath, JSON.stringify({ pr: { title: "centraldigital/patchdesk#42", headSha }, changedFiles: ["src/review.ts"], checks: { overall: "passing" } }), "utf8");
      await writeFile(reviewInputPath, "# PR review input\n\nPR: centraldigital/patchdesk#42\n", "utf8");
      await writeFile(patchPath, "diff --git a/src/review.ts b/src/review.ts\n+export const review = true;\n", "utf8");
      let prompt = "";
      let toolNames: ReadonlyArray<string> = [];
      let inspected: unknown;
      let resultSchema: typeof modelReviewResultSchema | undefined;
      let malformed = false;
      const session: ReviewModelSession = {
        async prompt(input, options) {
          prompt = input;
          resultSchema = options.result;
          toolNames = options.tools.map((tool) => tool.name);
          const readTool = options.tools.find((tool) => tool.name === "read_file_range");
          inspected = await readTool?.run({ input: { path: "src/review.ts", startLine: 1, endLine: 1 } });
          return { data: malformed
            ? { changeSummary: "Review complete.", verdict: "comment" as const, summary: "One issue found.", findings: [], validationPlan: ["pnpm test"], assumptions: [], rawNotes: "must reject" }
            : { changeSummary: "Review complete.", verdict: "comment" as const, summary: "One issue found.", findings: [], validationPlan: ["pnpm test"], assumptions: [] } };
        },
      };

      const result = await runModelReview({
        session,
        worktreePath: root,
        contextPath,
        reviewInputPath,
        patchPath,
        debugPath: join(root, "debug.json"),
        gitShow: gitBlobReader({ [`${headSha}:src/review.ts`]: "export const review = true;\n" }),
      });

      expect(result).toMatchObject({ verdict: "comment", findings: [] });
      expect(prompt).toContain("centraldigital/patchdesk#42");
      expect(prompt).toContain("Prepared unified patch:");
      expect(prompt).toContain("export const review");
      expect(toolNames).toEqual(["list_changed_files", "search_files", "read_file_range", "git_show"]);
      expect(inspected).toEqual({ content: "export const review = true;" });
      if (resultSchema === undefined) throw new Error("expected result schema");
      expect(v.safeParse(resultSchema, { changeSummary: "ok", verdict: "approve", summary: "ok", findings: [], validationPlan: [], assumptions: [], rawNotes: "must reject" }).success).toBe(false);
      malformed = true;
      await expect(runModelReview({
        session,
        worktreePath: root,
        contextPath,
        reviewInputPath,
        patchPath,
        debugPath: join(root, "debug.json"),
        gitShow: gitBlobReader({ [`${headSha}:src/review.ts`]: "export const review = true;\n" }),
      })).rejects.toThrow("Invalid model review result");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("snapshots immutable Git blobs instead of following worktree paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-model-git-snapshot-"));
    try {
      const headSha = "b".repeat(40);
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "review.ts"), "WORKTREE_PROTECTED_CONTENT\n", "utf8");
      const contextPath = join(root, "context.json");
      const reviewInputPath = join(root, "review-input.md");
      const patchPath = join(root, "patch.diff");
      await writeFile(contextPath, JSON.stringify({ pr: { headSha }, changedFiles: ["src/review.ts"] }), "utf8");
      await writeFile(reviewInputPath, "# PR review input\n", "utf8");
      await writeFile(patchPath, "diff --git a/src/review.ts b/src/review.ts\n", "utf8");
      let inspected: unknown;
      const commands: Array<ReadonlyArray<string>> = [];
      const session: ReviewModelSession = {
        async prompt(_input, options) {
          const readTool = options.tools.find((tool) => tool.name === "read_file_range");
          inspected = await readTool?.run({ input: { path: "src/review.ts", startLine: 1, endLine: 1 } });
          return { data: { changeSummary: "Review complete.", verdict: "comment" as const, summary: "No issues.", findings: [], validationPlan: [], assumptions: [] } };
        },
      };

      await runModelReview({
        session,
        worktreePath: root,
        contextPath,
        reviewInputPath,
        patchPath,
        debugPath: join(root, "debug.json"),
        gitShow: gitBlobReader({ [`${headSha}:src/review.ts`]: "IMMUTABLE_GIT_SNAPSHOT\n" }, commands),
      });

      expect(inspected).toEqual({ content: "IMMUTABLE_GIT_SNAPSHOT" });
      expect(JSON.stringify(inspected)).not.toContain("WORKTREE_PROTECTED_CONTENT");
      expect(commands).not.toEqual([]);
      expect(commands.every((argv) => argv.includes("--no-replace-objects"))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("denies committed symlink and non-regular tree entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-model-git-entry-"));
    try {
      const headSha = "d".repeat(40);
      const changedFiles = ["src/regular.ts", "src/link.ts", "src/directory"];
      const contextPath = join(root, "context.json");
      const reviewInputPath = join(root, "review-input.md");
      const patchPath = join(root, "patch.diff");
      await writeFile(contextPath, JSON.stringify({ pr: { headSha }, changedFiles }), "utf8");
      await writeFile(reviewInputPath, "# PR review input\n", "utf8");
      await writeFile(patchPath, "diff --git a/src/regular.ts b/src/regular.ts\n", "utf8");
      const inspected = new Map<string, unknown>();
      const session: ReviewModelSession = {
        async prompt(_input, options) {
          const readTool = options.tools.find((tool) => tool.name === "read_file_range");
          for (const path of changedFiles) {
            inspected.set(path, await readTool?.run({ input: { path, startLine: 1, endLine: 1 } }));
          }
          return { data: { changeSummary: "Review complete.", verdict: "comment" as const, summary: "No issues.", findings: [], validationPlan: [], assumptions: [] } };
        },
      };

      await runModelReview({
        session,
        worktreePath: root,
        contextPath,
        reviewInputPath,
        patchPath,
        debugPath: join(root, "debug.json"),
        gitShow: gitBlobReader({
          [`${headSha}:src/regular.ts`]: "export const regular = true;\n",
          [`${headSha}:src/link.ts`]: { contents: "COMMITTED_SYMLINK_TARGET\n", mode: "120000" },
          [`${headSha}:src/directory`]: { contents: "NON_REGULAR_TREE_CONTENT\n", mode: "040000", type: "tree" },
        }),
      });

      expect(inspected.get("src/regular.ts")).toEqual({ content: "export const regular = true;" });
      expect(inspected.get("src/link.ts")).toEqual({ denied: true });
      expect(inspected.get("src/directory")).toEqual({ denied: true });
      expect(JSON.stringify([...inspected.values()])).not.toContain("COMMITTED_SYMLINK_TARGET");
      expect(JSON.stringify([...inspected.values()])).not.toContain("NON_REGULAR_TREE_CONTENT");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("denies root-like paths before forming Git objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-model-git-root-"));
    try {
      const headSha = "e".repeat(40);
      const changedFiles = [".", "./review.ts", "src/review.ts"];
      const contextPath = join(root, "context.json");
      const reviewInputPath = join(root, "review-input.md");
      const patchPath = join(root, "patch.diff");
      await writeFile(contextPath, JSON.stringify({ pr: { headSha }, changedFiles }), "utf8");
      await writeFile(reviewInputPath, "# PR review input\n", "utf8");
      await writeFile(patchPath, "diff --git a/src/review.ts b/src/review.ts\n", "utf8");
      const inspected = new Map<string, unknown>();
      const commands: Array<ReadonlyArray<string>> = [];
      const session: ReviewModelSession = {
        async prompt(_input, options) {
          const readTool = options.tools.find((tool) => tool.name === "read_file_range");
          for (const path of changedFiles) {
            inspected.set(path, await readTool?.run({ input: { path, startLine: 1, endLine: 1 } }));
          }
          return { data: { changeSummary: "Review complete.", verdict: "comment" as const, summary: "No issues.", findings: [], validationPlan: [], assumptions: [] } };
        },
      };

      await runModelReview({
        session,
        worktreePath: root,
        contextPath,
        reviewInputPath,
        patchPath,
        debugPath: join(root, "debug.json"),
        gitShow: gitBlobReader({
          [`${headSha}:.`]: "ROOT_PROTECTED_CONTENT\n",
          [`${headSha}:./review.ts`]: "DOT_SLASH_PROTECTED_CONTENT\n",
          [`${headSha}:src/review.ts`]: "export const review = true;\n",
        }, commands),
      });

      expect(inspected.get(".")).toEqual({ denied: true });
      expect(inspected.get("./review.ts")).toEqual({ denied: true });
      expect(inspected.get("src/review.ts")).toEqual({ content: "export const review = true;" });
      expect(commands.flat()).not.toContain(`${headSha}:.`);
      expect(commands.flat()).not.toContain(`${headSha}:./review.ts`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("denies unsafe and oversized changed-file snapshots to the model", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-model-snapshots-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "patchdesk-model-outside-"));
    try {
      const headSha = "c".repeat(40);
      const changedFiles = [
        "src/allowed.ts",
        "src/outside-link.ts",
        "src/inside-link/inside.ts",
        "src/directory",
        "src/too-large.ts",
        ...Array.from({ length: 8 }, (_, index) => `src/aggregate-${index}.ts`),
        "src/aggregate-over-limit.ts",
      ];
      await mkdir(join(root, "src"));
      await mkdir(join(root, "src", "directory"));
      await mkdir(join(root, "src", "real"));
      await writeFile(join(root, "src", "allowed.ts"), "export const allowed = true;\n", "utf8");
      await writeFile(join(outsideRoot, "protected.ts"), "OUTSIDE_PROTECTED_CONTENT\n", "utf8");
      await symlink(join(outsideRoot, "protected.ts"), join(root, "src", "outside-link.ts"));
      await writeFile(join(root, "src", "real", "inside.ts"), "ANCESTOR_SYMLINK_PROTECTED_CONTENT\n", "utf8");
      await symlink(join(root, "src", "real"), join(root, "src", "inside-link"));
      await writeFile(join(root, "src", "too-large.ts"), `OVERSIZED_PROTECTED_CONTENT${"x".repeat(512 * 1024)}\n`, "utf8");
      await Promise.all(Array.from({ length: 8 }, (_, index) => writeFile(join(root, "src", `aggregate-${index}.ts`), "a".repeat(512 * 1024), "utf8")));
      await writeFile(join(root, "src", "aggregate-over-limit.ts"), "AGGREGATE_PROTECTED_CONTENT\n", "utf8");
      const contextPath = join(root, "context.json");
      const reviewInputPath = join(root, "review-input.md");
      const patchPath = join(root, "patch.diff");
      await writeFile(contextPath, JSON.stringify({ pr: { headSha }, changedFiles }), "utf8");
      await writeFile(reviewInputPath, "# PR review input\n", "utf8");
      await writeFile(patchPath, "diff --git a/src/allowed.ts b/src/allowed.ts\n", "utf8");
      const inspected = new Map<string, unknown>();
      const session: ReviewModelSession = {
        async prompt(_input, options) {
          const readTool = options.tools.find((tool) => tool.name === "read_file_range");
          for (const path of changedFiles) {
            inspected.set(path, await readTool?.run({ input: { path, startLine: 1, endLine: 1 } }));
          }
          return { data: { changeSummary: "Review complete.", verdict: "comment" as const, summary: "No issues.", findings: [], validationPlan: [], assumptions: [] } };
        },
      };

      await runModelReview({
        session,
        worktreePath: root,
        contextPath,
        reviewInputPath,
        patchPath,
        debugPath: join(root, "debug.json"),
        gitShow: gitBlobReader({
          [`${headSha}:src/allowed.ts`]: "export const allowed = true;\n",
          ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`${headSha}:src/aggregate-${index}.ts`, "a".repeat(512 * 1024)])),
          [`${headSha}:src/too-large.ts`]: `OVERSIZED_PROTECTED_CONTENT${"x".repeat(512 * 1024)}\n`,
          [`${headSha}:src/aggregate-over-limit.ts`]: "AGGREGATE_PROTECTED_CONTENT\n",
        }),
      });

      expect(inspected.get("src/allowed.ts")).toEqual({ content: "export const allowed = true;" });
      expect(inspected.get("src/outside-link.ts")).toEqual({ denied: true });
      expect(inspected.get("src/inside-link/inside.ts")).toEqual({ denied: true });
      expect(inspected.get("src/directory")).toEqual({ denied: true });
      expect(inspected.get("src/too-large.ts")).toEqual({ denied: true });
      expect(inspected.get("src/aggregate-over-limit.ts")).toEqual({ denied: true });
      expect(JSON.stringify([...inspected.values()])).not.toContain("OUTSIDE_PROTECTED_CONTENT");
      expect(JSON.stringify([...inspected.values()])).not.toContain("ANCESTOR_SYMLINK_PROTECTED_CONTENT");
      expect(JSON.stringify([...inspected.values()])).not.toContain("OVERSIZED_PROTECTED_CONTENT");
      expect(JSON.stringify([...inspected.values()])).not.toContain("AGGREGATE_PROTECTED_CONTENT");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("uses comparison evidence as the incremental-review prompt surface without duplicating the full patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-model-incremental-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "changed.ts"), "export const changed = true;\n", "utf8");
      const contextPath = join(root, "context.json");
      const reviewInputPath = join(root, "review-input.md");
      const fullPatchPath = join(root, "patch.diff");
      const comparisonPatchPath = join(root, "comparison.diff");
      const comparisonMetadataPath = join(root, "comparison.json");
      const previousFindingsPath = join(root, "previous.json");
      await writeFile(contextPath, JSON.stringify({ changedFiles: ["src/unrelated.ts"] }), "utf8");
      await writeFile(reviewInputPath, "# Incremental input", "utf8");
      await writeFile(fullPatchPath, "FULL-PR-PATCH-MUST-NOT-APPEAR", "utf8");
      await writeFile(comparisonPatchPath, "diff --git a/src/changed.ts b/src/changed.ts\n+incremental change\n", "utf8");
      await writeFile(comparisonMetadataPath, JSON.stringify({ schemaVersion: 1, baseSessionId: "github.com__centraldigital__patchdesk__pr-42__sha-11111111__000000000000", baseHeadSha: "1".repeat(40), headSha: "2".repeat(40), ancestry: "fast_forward", source: "local_git", completeness: "complete", commits: [], files: [{ path: "src/changed.ts", status: "modified", additions: 1, deletions: 0, binary: false, textPatchAvailable: true }], additions: 1, deletions: 0, createdAt: "2026-07-18T00:00:00.000Z" }), "utf8");
      await writeFile(previousFindingsPath, JSON.stringify([{ token: "a".repeat(64), findingId: "prior", severity: "P1", title: "Prior issue", explanation: "Prior evidence.", file: "src/changed.ts", wasSubmitted: false }]), "utf8");
      let prompt = "";
      const session: ReviewModelSession = {
        async prompt(text) {
          prompt = text;
          return { data: { changeSummary: "Incremental complete.", verdict: "comment" as const, summary: "One update.", findings: [], validationPlan: [], assumptions: [], priorFindingAssessments: [{ priorFindingToken: "a".repeat(64), disposition: "unverified" as const, explanation: "Need more evidence." }] } };
        },
      };

      await runModelReview({
        session,
        worktreePath: root,
        contextPath,
        reviewInputPath,
        patchPath: fullPatchPath,
        debugPath: join(root, "debug.json"),
        scope: { kind: "incremental", baseSessionId: "github.com__centraldigital__patchdesk__pr-42__sha-11111111__000000000000" as never, baseHeadSha: "1".repeat(40) as never, headSha: "2".repeat(40) as never, comparisonPatchPath: comparisonPatchPath as never, comparisonMetadataPath: comparisonMetadataPath as never, previousFindingsPath: previousFindingsPath as never, lifecyclePath: join(root, "lifecycle.json") as never },
        gitShow: gitBlobReader({ [`${"2".repeat(40)}:src/changed.ts`]: "export const changed = true;\n" }),
      });

      expect(prompt).toContain("Prepared incremental patch:");
      expect(prompt).toContain("incremental change");
      expect(prompt).toContain("Prior finding evidence:");
      expect(prompt).not.toContain("FULL-PR-PATCH-MUST-NOT-APPEAR");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
