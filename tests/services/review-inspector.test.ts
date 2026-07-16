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
});
