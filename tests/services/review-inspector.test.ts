import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewInspector } from "../../src/services/review-inspector";

describe("ReviewInspector", () => {
  it("allows narrow worktree reads and records only paths, searches, and safe argv", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-inspector-"));
    try {
      await mkdir(join(root, "src")); await writeFile(join(root, "src", "a.ts"), "one\ntwo\nthree\n", "utf8");
      const debugPath = join(root, "debug.json");
      await writeFile(debugPath, JSON.stringify({ inspectedPaths: [], searches: [], allowedReadCommands: [], profileRuleLoadFailures: ["rule.md"] }), "utf8");
      const inspector = new ReviewInspector({ worktreePath: root, changedFiles: ["src/a.ts"], debugPath, gitShow: async () => "commit summary" });
      expect(await inspector.readFileRange("src/a.ts", 2, 2)).toEqual({ _tag: "ok", value: "two" });
      expect(await inspector.readFileRange("../etc/passwd", 1, 1)).toEqual({ _tag: "err", error: { _tag: "InspectorDenied" } });
      expect(await inspector.searchFiles("two")).toEqual({ _tag: "ok", value: ["src/a.ts"] });
      expect(await inspector.gitShow("HEAD")).toEqual({ _tag: "ok", value: "commit summary" });
      expect(inspector.debug()).toEqual({ inspectedPaths: ["src/a.ts"], searches: ["two"], allowedReadCommands: [["git", "-C", await realpath(root), "show", "--format=", "--no-ext-diff", "HEAD"]] });
      expect(await readFile(debugPath, "utf8")).toContain("src/a.ts");
      expect(await readFile(debugPath, "utf8")).toContain("profileRuleLoadFailures");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("denies a missing authoritative snapshot instead of reading live disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-inspector-snapshot-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "live.ts"), "LIVE_DISK_CONTENT\n", "utf8");
      const inspector = new ReviewInspector({
        worktreePath: root,
        changedFiles: ["src/live.ts"],
        fileSnapshots: {},
        gitShow: async () => "commit summary",
      });

      expect(await inspector.readFileRange("src/live.ts", 1, 1)).toEqual({ _tag: "err", error: { _tag: "InspectorDenied" } });
      expect(inspector.debug().inspectedPaths).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("lists only authoritative snapshot paths", async () => {
    const inspector = new ReviewInspector({
      worktreePath: "/unused",
      changedFiles: ["src/snapshot.ts", "src/skipped.ts"],
      fileSnapshots: { "src/snapshot.ts": "prepared content" },
      gitShow: async () => "commit summary",
    });

    expect(await inspector.listChangedFiles()).toEqual({ _tag: "ok", value: ["src/snapshot.ts"] });
  });

  it("denies backslash traversal in the no-snapshot fallback", async () => {
    const parent = await mkdtemp(join(tmpdir(), "patchdesk-inspector-path-"));
    const root = join(parent, "worktree");
    const path = "..\\outside.ts";
    try {
      await mkdir(root);
      await writeFile(process.platform === "win32" ? join(parent, "outside.ts") : join(root, path), "BACKSLASH_PROTECTED_CONTENT\n", "utf8");
      const inspector = new ReviewInspector({ worktreePath: root, changedFiles: [path], gitShow: async () => "commit summary" });

      expect(await inspector.readFileRange(path, 1, 1)).toEqual({ _tag: "err", error: { _tag: "InspectorDenied" } });
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
});
