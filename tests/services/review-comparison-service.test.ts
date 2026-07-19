import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import {
  parseGitSha,
  parseIsoTimestamp,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { ReviewComparisonService } from "../../src/services/review-comparison-service";
import type { GitReadExecutor } from "../../src/services/review-worktree-service";

const baseSha = must(parseGitSha("1111111111111111111111111111111111111111"));
const headSha = must(parseGitSha("2222222222222222222222222222222222222222"));
const profileId = must(parseWorkspaceProfileId("cfw"));
const baseSessionId = must(parseReviewSessionId("github.com__centraldigital__patchdesk__pr-42__sha-11111111__000000000000"));
const targetSessionId = must(parseReviewSessionId("github.com__centraldigital__patchdesk__pr-42__sha-22222222__000000000000"));
const now = must(parseIsoTimestamp("2026-07-18T00:00:00.000Z"));

describe("ReviewComparisonService", () => {
  it("persists an exact two-tree comparison and prior evidence without switching a branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-comparison-"));
    try {
      const git = fixtureGit();
      const paths = PatchdeskPaths.forTest(root);
      const result = await new ReviewComparisonService(paths, git, () => now).prepare({
        profileId,
        targetSessionId,
        baseSessionId,
        baseHeadSha: baseSha,
        headSha,
        localPath: join(root, "repository"),
        previousFindings: [{
          token: "a".repeat(64) as never,
          findingId: "prior" as never,
          severity: "P1",
          title: "Prior issue",
          explanation: "Still needs proof.",
          file: "src/old.ts" as never,
          wasSubmitted: true,
        }],
      });

      expect(result).toMatchObject({
        _tag: "ok",
        value: {
          comparison: {
            ancestry: "fast_forward",
            additions: 3,
            deletions: 1,
            files: [
              { path: "src/new.ts", oldPath: "src/old.ts", status: "renamed", additions: 3, deletions: 1 },
            ],
            commits: [{ sha: headSha, authoredAt: "2026-07-18T03:00:00.000Z" }],
          },
        },
      });
      if (result._tag === "err") return;
      expect(await readFile(result.value.comparisonPatchPath, "utf8")).toContain("src/new.ts");
      expect(JSON.parse(await readFile(result.value.previousFindingsPath, "utf8"))).toMatchObject([{ findingId: "prior", wasSubmitted: true }]);
      expect(git.calls.some((argv) => argv.includes("checkout") || argv.includes("switch") || argv.includes("reset"))).toBe(false);
      const fetches = git.calls.filter((argv) => argv.includes("fetch"));
      expect(fetches).toHaveLength(2);
      expect(fetches[0]?.at(-2)).toContain(baseSha);
      expect(fetches[1]?.at(-2)).toContain(headSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a managed ref that does not resolve to the requested head before writing artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-comparison-"));
    try {
      const git = fixtureGit({ resolvedHead: baseSha });
      const paths = PatchdeskPaths.forTest(root);
      const result = await new ReviewComparisonService(paths, git, () => now).prepare({
        profileId,
        targetSessionId,
        baseSessionId,
        baseHeadSha: baseSha,
        headSha,
        localPath: join(root, "repository"),
        previousFindings: [],
      });
      expect(result).toEqual({ _tag: "err", error: { _tag: "ReviewComparisonFailed", reason: "head_changed" } });
      await expect(readFile(paths.comparisonPatchFile(profileId, targetSessionId), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function fixtureGit(options: { readonly resolvedHead?: string } = {}): GitReadExecutor & { readonly calls: Array<ReadonlyArray<string>> } {
  const calls: Array<ReadonlyArray<string>> = [];
  return {
    calls,
    async run(argv) {
      calls.push(argv);
      if (argv.includes("--show-toplevel")) return ok("/fixture/repository");
      if (argv.includes("fetch")) return ok("");
      if (argv.includes("rev-parse")) return ok(argv.at(-1)?.includes("/head") ? `${options.resolvedHead ?? headSha}\n` : `${baseSha}\n`);
      if (argv.includes("merge-base")) return ok("");
      if (argv.includes("--no-ext-diff")) return ok("diff --git a/src/old.ts b/src/new.ts\nsimilarity index 80%\nrename from src/old.ts\nrename to src/new.ts\n+new\n");
      if (argv.includes("--name-status")) return ok("R080\tsrc/old.ts\tsrc/new.ts\n");
      if (argv.includes("--numstat")) return ok("3\t1\tsrc/new.ts\n");
      if (argv.includes("log")) return ok(`${headSha}\u0000Alice\u00002026-07-18T10:00:00+07:00\u0000Rename file\n`);
      return { _tag: "err", error: { _tag: "GitReadFailed" } };
    },
  };
}

function ok(stdout: string) {
  return { _tag: "ok" as const, value: { stdout } };
}

function must<T>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" }): T {
  if (result._tag === "err") throw new Error("invalid fixture");
  return result.value;
}
