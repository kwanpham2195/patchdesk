import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prepareModelReview } from "../../src/services/model-review-runner";

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

async function writeArtifacts(
  root: string,
  headSha: string,
  changedFiles: ReadonlyArray<string>,
): Promise<{ readonly contextPath: string; readonly reviewInputPath: string; readonly patchPath: string }> {
  const contextPath = join(root, "context.json");
  const reviewInputPath = join(root, "review-input.md");
  const patchPath = join(root, "patch.diff");
  await writeFile(contextPath, JSON.stringify({
    pr: { title: "centraldigital/patchdesk#42", headSha },
    changedFiles,
    checks: { overall: "passing" },
  }));
  await writeFile(reviewInputPath, "# PR review input\n\nPR: centraldigital/patchdesk#42\n");
  await writeFile(patchPath, "diff --git a/src/review.ts b/src/review.ts\n+export const review = true;\n");
  return { contextPath, reviewInputPath, patchPath };
}

describe("model review preparation", () => {
  it("prepares the immutable prompt and one invocation-scoped inspector", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-model-review-"));
    try {
      const headSha = "a".repeat(40);
      const artifacts = await writeArtifacts(root, headSha, ["src/review.ts"]);
      const prepared = await prepareModelReview({
        ...artifacts,
        worktreePath: root,
        debugPath: join(root, "debug.json"),
        gitShow: gitBlobReader({ [`${headSha}:src/review.ts`]: "export const review = true;\n" }),
      });

      expect(prepared.prompt).toContain("centraldigital/patchdesk#42");
      expect(prepared.prompt).toContain("Review the complete represented pull request.");
      expect(prepared.prompt).toContain("export const review");
      await expect(prepared.inspector.readFileRange("src/review.ts", 1, 1)).resolves.toEqual({
        _tag: "ok",
        value: "export const review = true;",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("snapshots immutable Git blobs instead of following worktree paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-model-git-snapshot-"));
    try {
      const headSha = "b".repeat(40);
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "review.ts"), "WORKTREE_PROTECTED_CONTENT\n");
      const artifacts = await writeArtifacts(root, headSha, ["src/review.ts"]);
      const commands: Array<ReadonlyArray<string>> = [];
      const prepared = await prepareModelReview({
        ...artifacts,
        worktreePath: root,
        debugPath: join(root, "debug.json"),
        gitShow: gitBlobReader({ [`${headSha}:src/review.ts`]: "IMMUTABLE_GIT_SNAPSHOT\n" }, commands),
      });

      const inspected = await prepared.inspector.readFileRange("src/review.ts", 1, 1);
      expect(inspected).toEqual({ _tag: "ok", value: "IMMUTABLE_GIT_SNAPSHOT" });
      expect(JSON.stringify(inspected)).not.toContain("WORKTREE_PROTECTED_CONTENT");
      expect(commands).not.toEqual([]);
      expect(commands.every((argv) => argv.includes("--no-replace-objects"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies committed symlink and non-regular tree entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-model-git-entry-"));
    try {
      const headSha = "d".repeat(40);
      const changedFiles = ["src/regular.ts", "src/link.ts", "src/directory"];
      const artifacts = await writeArtifacts(root, headSha, changedFiles);
      const prepared = await prepareModelReview({
        ...artifacts,
        worktreePath: root,
        debugPath: join(root, "debug.json"),
        gitShow: gitBlobReader({
          [`${headSha}:src/regular.ts`]: "export const regular = true;\n",
          [`${headSha}:src/link.ts`]: { contents: "COMMITTED_SYMLINK_TARGET\n", mode: "120000" },
          [`${headSha}:src/directory`]: { contents: "NON_REGULAR_TREE_CONTENT\n", mode: "040000", type: "tree" },
        }),
      });

      await expect(prepared.inspector.readFileRange("src/regular.ts", 1, 1)).resolves.toEqual({
        _tag: "ok",
        value: "export const regular = true;",
      });
      await expect(prepared.inspector.readFileRange("src/link.ts", 1, 1)).resolves.toMatchObject({ _tag: "err" });
      await expect(prepared.inspector.readFileRange("src/directory", 1, 1)).resolves.toMatchObject({ _tag: "err" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies root-like paths before forming Git objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-model-git-root-"));
    try {
      const headSha = "e".repeat(40);
      const artifacts = await writeArtifacts(root, headSha, [".", "./review.ts", "src/review.ts"]);
      const commands: Array<ReadonlyArray<string>> = [];
      const prepared = await prepareModelReview({
        ...artifacts,
        worktreePath: root,
        debugPath: join(root, "debug.json"),
        gitShow: gitBlobReader({
          [`${headSha}:.`]: "ROOT_PROTECTED_CONTENT\n",
          [`${headSha}:./review.ts`]: "DOT_SLASH_PROTECTED_CONTENT\n",
          [`${headSha}:src/review.ts`]: "export const review = true;\n",
        }, commands),
      });

      await expect(prepared.inspector.readFileRange(".", 1, 1)).resolves.toMatchObject({ _tag: "err" });
      await expect(prepared.inspector.readFileRange("./review.ts", 1, 1)).resolves.toMatchObject({ _tag: "err" });
      await expect(prepared.inspector.readFileRange("src/review.ts", 1, 1)).resolves.toEqual({
        _tag: "ok",
        value: "export const review = true;",
      });
      expect(commands.flat()).not.toContain(`${headSha}:.`);
      expect(commands.flat()).not.toContain(`${headSha}:./review.ts`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies unsafe, non-regular, and oversized snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-model-snapshots-"));
    try {
      const headSha = "c".repeat(40);
      const aggregateFiles = Array.from({ length: 8 }, (_, index) => `src/aggregate-${index}.ts`);
      const changedFiles = [
        "src/allowed.ts",
        "../outside.ts",
        "src/directory",
        "src/too-large.ts",
        ...aggregateFiles,
        "src/aggregate-over-limit.ts",
      ];
      const artifacts = await writeArtifacts(root, headSha, changedFiles);
      const prepared = await prepareModelReview({
        ...artifacts,
        worktreePath: root,
        debugPath: join(root, "debug.json"),
        gitShow: gitBlobReader({
          [`${headSha}:src/allowed.ts`]: "export const allowed = true;\n",
          [`${headSha}:src/directory`]: { contents: "NON_REGULAR_TREE_CONTENT\n", mode: "040000", type: "tree" },
          [`${headSha}:src/too-large.ts`]: `OVERSIZED_PROTECTED_CONTENT${"x".repeat(512 * 1024)}\n`,
          ...Object.fromEntries(aggregateFiles.map((path) => [`${headSha}:${path}`, "a".repeat(512 * 1024)])),
          [`${headSha}:src/aggregate-over-limit.ts`]: "AGGREGATE_PROTECTED_CONTENT\n",
        }),
      });

      await expect(prepared.inspector.readFileRange("src/allowed.ts", 1, 1)).resolves.toEqual({
        _tag: "ok",
        value: "export const allowed = true;",
      });
      for (const path of ["../outside.ts", "src/directory", "src/too-large.ts", "src/aggregate-over-limit.ts"]) {
        await expect(prepared.inspector.readFileRange(path, 1, 1)).resolves.toMatchObject({ _tag: "err" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
