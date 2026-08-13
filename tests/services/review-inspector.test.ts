import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewInspector } from "../../src/services/review-inspector";

describe("ReviewInspector", () => {
  it("allows narrow worktree reads and records only bounded telemetry counters", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-inspector-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "a.ts"), "one\ntwo\nthree\n", "utf8");
      const debugPath = join(root, "debug.json");
      await writeFile(
        debugPath,
        JSON.stringify({
          inspectedFileCount: 0,
          searchCount: 0,
          gitShowCount: 0,
          profileRuleLoadFailureCount: 1,
        }),
        "utf8",
      );
      const inspector = new ReviewInspector({
        worktreePath: root,
        changedFiles: ["src/a.ts"],
        debugPath,
        gitShow: async () => "commit summary",
      });
      expect(await inspector.readFileRange("src/a.ts", 2, 2)).toEqual({
        _tag: "ok",
        value: "two",
      });
      expect(await inspector.readFileRange("../etc/passwd", 1, 1)).toEqual({
        _tag: "err",
        error: { _tag: "InspectorDenied", reason: "invalid_input" },
      });
      expect(await inspector.searchFiles("two")).toEqual({
        _tag: "ok",
        value: ["src/a.ts"],
      });
      expect(await inspector.gitShow("HEAD")).toEqual({
        _tag: "ok",
        value: "commit summary",
      });
      expect(inspector.debug()).toEqual({
        inspectedFileCount: 2,
        searchCount: 1,
        gitShowCount: 1,
        profileRuleLoadFailureCount: 0,
      });
      const serializedDebug = await readFile(debugPath, "utf8");
      expect(JSON.parse(serializedDebug)).toEqual({
        inspectedFileCount: 2,
        searchCount: 1,
        gitShowCount: 1,
        profileRuleLoadFailureCount: 1,
      });
      expect(serializedDebug).not.toContain(root);
      expect(serializedDebug).not.toContain("src/a.ts");
      expect(serializedDebug).not.toContain("two");
      expect(serializedDebug).not.toContain('"git"');
      expect(serializedDebug).not.toContain("HEAD");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds git_show to the session revisions and output size", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-inspector-git-show-"));
    try {
      const calls: Array<ReadonlyArray<string>> = [];
      const inspector = new ReviewInspector({
        worktreePath: root,
        changedFiles: [],
        allowedRevisions: ["HEAD", "a".repeat(40)],
        gitShow: async (argv) => {
          calls.push(argv);
          return "small";
        },
      });
      expect(await inspector.gitShow("b".repeat(40))).toEqual({
        _tag: "err",
        error: { _tag: "InspectorDenied", reason: "invalid_input" },
      });
      expect(await inspector.gitShow("a".repeat(40))).toEqual({
        _tag: "ok",
        value: "small",
      });
      expect(calls[0]).toEqual([
        "git",
        "--no-replace-objects",
        "-C",
        await realpath(root),
        "show",
        "--format=",
        "--no-ext-diff",
        "a".repeat(40),
      ]);

      const oversized = new ReviewInspector({
        worktreePath: root,
        changedFiles: [],
        gitShow: async () => "x".repeat(512 * 1024 + 1),
      });
      expect(await oversized.gitShow("HEAD")).toEqual({
        _tag: "err",
        error: { _tag: "InspectorDenied", reason: "outside_snapshot" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies a missing authoritative snapshot instead of reading live disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-inspector-snapshot-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(
        join(root, "src", "live.ts"),
        "LIVE_DISK_CONTENT\n",
        "utf8",
      );
      const inspector = new ReviewInspector({
        worktreePath: root,
        changedFiles: ["src/live.ts"],
        fileSnapshots: {},
        gitShow: async () => "commit summary",
      });

      expect(await inspector.readFileRange("src/live.ts", 1, 1)).toEqual({
        _tag: "err",
        error: { _tag: "InspectorDenied", reason: "outside_snapshot" },
      });
      expect(inspector.debug()).toEqual({
        inspectedFileCount: 0,
        searchCount: 0,
        gitShowCount: 0,
        profileRuleLoadFailureCount: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps inspection results available when debug persistence fails", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "patchdesk-inspector-debug-failure-"),
    );
    try {
      const inspector = new ReviewInspector({
        worktreePath: root,
        changedFiles: ["src/a.ts"],
        fileSnapshots: { "src/a.ts": "fixture source" },
        debugPath: join(root, "missing", "debug.json"),
        gitShow: async () => "commit summary",
      });

      await expect(inspector.searchFiles("fixture")).resolves.toEqual({
        _tag: "ok",
        value: ["src/a.ts"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists only authoritative snapshot paths", async () => {
    const inspector = new ReviewInspector({
      worktreePath: "/unused",
      changedFiles: ["src/snapshot.ts", "src/skipped.ts"],
      fileSnapshots: { "src/snapshot.ts": "prepared content" },
      gitShow: async () => "commit summary",
    });

    expect(await inspector.listChangedFiles()).toEqual({
      _tag: "ok",
      value: ["src/snapshot.ts"],
    });
  });

  it("denies backslash traversal in the no-snapshot fallback", async () => {
    const parent = await mkdtemp(join(tmpdir(), "patchdesk-inspector-path-"));
    const root = join(parent, "worktree");
    const path = "..\\outside.ts";
    try {
      await mkdir(root);
      await writeFile(
        process.platform === "win32"
          ? join(parent, "outside.ts")
          : join(root, path),
        "BACKSLASH_PROTECTED_CONTENT\n",
        "utf8",
      );
      const inspector = new ReviewInspector({
        worktreePath: root,
        changedFiles: [path],
        gitShow: async () => "commit summary",
      });

      expect(await inspector.readFileRange(path, 1, 1)).toEqual({
        _tag: "err",
        error: { _tag: "InspectorDenied", reason: "invalid_input" },
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("enforces one shared eight-call inspection budget", async () => {
    const inspector = new ReviewInspector({
      worktreePath: "/unused",
      changedFiles: ["src/a.ts"],
      fileSnapshots: { "src/a.ts": "fixture" },
      gitShow: async () => "commit summary",
    });
    for (let index = 0; index < 8; index += 1)
      expect((await inspector.listChangedFiles())._tag).toBe("ok");
    expect(await inspector.searchFiles("fixture")).toEqual({
      _tag: "err",
      error: { _tag: "InspectorDenied", reason: "budget_exhausted" },
    });
    expect(await inspector.gitShow("HEAD")).toEqual({
      _tag: "err",
      error: { _tag: "InspectorDenied", reason: "budget_exhausted" },
    });
  });

  it("denies drive-relative paths in the no-snapshot fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-inspector-drive-"));
    const path = "C:drive-relative.ts";
    try {
      if (process.platform !== "win32")
        await writeFile(
          join(root, path),
          "DRIVE_RELATIVE_PROTECTED_CONTENT\n",
          "utf8",
        );
      const inspector = new ReviewInspector({
        worktreePath: root,
        changedFiles: [path],
        gitShow: async () => "commit summary",
      });

      expect(await inspector.readFileRange(path, 1, 1)).toEqual({
        _tag: "err",
        error: { _tag: "InspectorDenied", reason: "invalid_input" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
