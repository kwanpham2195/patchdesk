import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewContextService } from "../../src/services/review-context-service";

describe("ReviewContextService", () => {
  it("writes only rule-file metadata and safe review artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-context-"));
    try {
      const worktree = join(root, "worktree");
      const attempt = join(root, "attempt");
      await mkdir(worktree); await mkdir(attempt);
      await writeFile(join(worktree, "AGENTS.md"), "secret-looking source text should not become context", "utf8");
      await writeFile(join(worktree, "package.json"), JSON.stringify({ name: "fixture", packageManager: "pnpm@8" }), "utf8");
      const service = new ReviewContextService();
      const result = await service.prepare({ worktreePath: worktree, attemptDirectory: attempt, pr: { title: "Fixture PR", headSha: "abcdef" }, comments: { threads: [] }, checks: { overall: "passing", checks: [] }, changedFiles: ["src/a.ts"], patch: { path: "patch.diff", sha256: "a".repeat(64) }, rulePaths: [] });
      expect(result).toMatchObject({ _tag: "ok", value: { contextPath: join(attempt, "context.json"), reviewInputPath: join(attempt, "review-input.md"), debugPath: join(attempt, "debug.json") } });
      const context = await readFile(join(attempt, "context.json"), "utf8");
      expect(context).toContain("AGENTS.md");
      expect(context).not.toContain("secret-looking source text");
      expect(await readFile(join(attempt, "debug.json"), "utf8")).toContain("inspectedPaths");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
