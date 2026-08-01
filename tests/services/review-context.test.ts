import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewContextService } from "../../src/services/review-context-service";

describe("ReviewContextService", () => {
  it("loads bounded root and configured rules as safely labeled project criteria", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-context-"));
    try {
      const worktree = join(root, "worktree");
      const attempt = join(root, "attempt");
      await mkdir(worktree); await mkdir(attempt);
      await writeFile(join(worktree, "AGENTS.md"), "Check changed error paths.", "utf8");
      await writeFile(join(worktree, "CONTRIBUTING.md"), "Keep tests focused.", "utf8");
      await writeFile(join(worktree, "package.json"), JSON.stringify({ name: "fixture", packageManager: "pnpm@8" }), "utf8");
      const configuredRulePath = join(root, "rules", "team.md");
      await mkdir(join(root, "rules"), { recursive: true });
      await writeFile(configuredRulePath, "Prefer a regression test.", "utf8");
      const service = new ReviewContextService();
      const result = await service.prepare({ worktreePath: worktree, attemptDirectory: attempt, pr: { title: "Fixture PR", headSha: "abcdef" }, comments: { threads: [] }, checks: { overall: "passing", checks: [] }, changedFiles: ["src/a.ts"], patch: { path: "patch.diff", sha256: "a".repeat(64) }, rulePaths: [configuredRulePath] });
      expect(result).toMatchObject({ _tag: "ok", value: { contextPath: join(attempt, "context.json"), reviewInputPath: join(attempt, "review-input.md"), debugPath: join(attempt, "debug.json") } });
      const context = await readFile(join(attempt, "context.json"), "utf8");
      expect(context).toContain("AGENTS.md");
      expect(context).toContain("Check changed error paths.");
      expect(context).toContain("CONTRIBUTING.md");
      expect(context).toContain("Keep tests focused.");
      expect(context).toContain("configured-rule-1");
      expect(context).toContain("Prefer a regression test.");
      const serializedDebug = await readFile(join(attempt, "debug.json"), "utf8");
      expect(JSON.parse(serializedDebug)).toEqual({ inspectedFileCount: 0, searchCount: 0, gitShowCount: 0, profileRuleLoadFailureCount: 0 });
      expect(serializedDebug).not.toContain(root);
      expect(serializedDebug).not.toContain(configuredRulePath);
      expect(serializedDebug).not.toContain("Check changed error paths.");
      expect(serializedDebug).not.toContain("Prefer a regression test.");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects missing, symlinked, non-regular, oversized, secret-like, and over-budget rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-context-"));
    try {
      const worktree = join(root, "worktree");
      const attempt = join(root, "attempt");
      const rules = join(root, "rules");
      await mkdir(worktree); await mkdir(attempt); await mkdir(rules);
      await writeFile(join(worktree, "AGENTS.md"), "Root guidance.", "utf8");
      await writeFile(join(worktree, "CONTRIBUTING.md"), "Contribution guidance.", "utf8");
      const accepted = join(rules, "accepted.md");
      const symlinked = join(rules, "symlinked.md");
      const directory = join(rules, "directory");
      const oversized = join(rules, "oversized.md");
      const sensitive = join(rules, "sensitive.md");
      const budgetOne = join(rules, "budget-one.md");
      const budgetTwo = join(rules, "budget-two.md");
      const budgetThree = join(rules, "budget-three.md");
      const budgetFour = join(rules, "budget-four.md");
      await writeFile(accepted, "Accepted configured guidance.", "utf8");
      await symlink(accepted, symlinked);
      await mkdir(directory);
      await writeFile(oversized, "x".repeat((128 * 1024) + 1), "utf8");
      await writeFile(sensitive, "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789", "utf8");
      for (const path of [budgetOne, budgetTwo, budgetThree, budgetFour]) {
        await writeFile(path, "x".repeat(128 * 1024), "utf8");
      }

      const result = await new ReviewContextService().prepare({
        worktreePath: worktree,
        attemptDirectory: attempt,
        pr: { title: "Fixture PR", headSha: "abcdef" },
        comments: { threads: [] },
        checks: { overall: "passing", checks: [] },
        changedFiles: [],
        patch: { path: "patch.diff", sha256: "a".repeat(64) },
        rulePaths: [accepted, join(rules, "missing.md"), symlinked, directory, oversized, sensitive, budgetOne, budgetTwo, budgetThree, budgetFour],
      });

      expect(result).toMatchObject({ _tag: "ok" });
      const context = await readFile(join(attempt, "context.json"), "utf8");
      expect(context).toContain("configured-rule-1");
      expect(context).toContain("Accepted configured guidance.");
      expect(context).toContain("configured-rule-7");
      expect(context).toContain("configured-rule-9");
      expect(context).not.toContain("configured-rule-2");
      expect(context).not.toContain("configured-rule-3");
      expect(context).not.toContain("configured-rule-4");
      expect(context).not.toContain("configured-rule-5");
      expect(context).not.toContain("configured-rule-6");
      expect(context).not.toContain("configured-rule-10");
      expect(context).not.toContain("ghp_");
      const debug = await readFile(join(attempt, "debug.json"), "utf8");
      expect(JSON.parse(debug)).toEqual({ inspectedFileCount: 0, searchCount: 0, gitShowCount: 0, profileRuleLoadFailureCount: 6 });
      for (const forbidden of [root, accepted, symlinked, oversized, sensitive, "Accepted configured guidance.", "ghp_"]) {
        expect(debug).not.toContain(forbidden);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects credential-like GitHub metadata before writing any artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-context-"));
    try {
      const attempt = join(root, "attempt");
      const result = await new ReviewContextService().prepare({ worktreePath: root, attemptDirectory: attempt, pr: { title: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789", headSha: "abcdef" }, comments: { threads: [] }, checks: { overall: "passing" }, changedFiles: [], patch: { path: "patch.diff", sha256: "a".repeat(64) }, rulePaths: [] });
      expect(result).toEqual({ _tag: "err", error: { _tag: "ReviewContextFailed" } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps context creation successful when the debug artifact cannot be written", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-context-"));
    try {
      const attempt = join(root, "attempt");
      await mkdir(attempt, { recursive: true });
      await mkdir(join(attempt, "debug.json"));

      const result = await new ReviewContextService().prepare({ worktreePath: root, attemptDirectory: attempt, pr: { title: "Fixture PR", headSha: "abcdef" }, comments: { threads: [] }, checks: { overall: "passing" }, changedFiles: [], patch: { path: "patch.diff", sha256: "a".repeat(64) }, rulePaths: [] });

      expect(result).toMatchObject({ _tag: "ok" });
      await expect(readFile(join(attempt, "context.json"), "utf8")).resolves.toContain("Fixture PR");
      await expect(readFile(join(attempt, "review-input.md"), "utf8")).resolves.toContain("PR review input");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
