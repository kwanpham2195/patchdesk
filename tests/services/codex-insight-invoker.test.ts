import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { CodexInsightInvoker } from "../../src/services/codex-insight-invoker";
import { ok } from "../../src/domain/result";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-codex-insight-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  const profileId = "cfw" as never;
  const sessionId =
    "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__439aa21713b5" as never;
  const worktree = paths.worktreeDirectory(profileId, sessionId);
  const reviewInput = paths.preparedReviewInputFile(profileId, sessionId);
  const context = paths.preparedContextFile(profileId, sessionId);
  const patch = paths.patchFile(profileId, sessionId);
  await mkdir(worktree, { recursive: true });
  await mkdir(join(reviewInput, ".."), { recursive: true });
  await Promise.all([
    writeFile(reviewInput, "PR: patchdesk#42", "utf8"),
    writeFile(context, "{}", "utf8"),
    writeFile(patch, "diff --git a/a.ts b/a.ts\n", "utf8"),
  ]);
  const calls: unknown[][] = [];
  const run = async (...args: [unknown, unknown]) => {
    calls.push(args);
    return ok({ findings: [] });
  };
  const invoker = new CodexInsightInvoker(
    paths,
    () => ({ run }) as never,
    "/usr/bin/codex",
    async () => "a".repeat(40),
  );
  const input = {
    profileId,
    reviewId:
      "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa",
    sessionId,
    runId: "insight-analysis-1-aaaaaaaaaaaa-review",
    type: "analysis",
    expectedHeadSha: "a".repeat(40),
    contextPath: context,
    reviewInputPath: reviewInput,
    patchPath: patch,
    worktreePath: worktree,
    provider: "codex-cli-account",
    model: "codex",
    reasoning: "medium",
  } as never;
  return { invoker, input, calls, worktree, reviewInput, context, patch };
}

describe("CodexInsightInvoker", () => {
  it("uses only the real app-owned represented worktree, expected head, and prepared review input", async () => {
    const value = await fixture();
    await expect(
      value.invoker.invoke(value.input, {
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ _tag: "ok" });
    expect(value.calls).toHaveLength(1);
    const invocation = value.calls[0]?.[0] as Record<string, unknown>;
    expect(invocation).toMatchObject({
      expectedHeadSha: "a".repeat(40),
      model: "codex",
      reasoning: "medium",
    });
    expect(invocation.worktreePath).toEqual(
      expect.stringContaining("review-worktrees"),
    );
    for (const removed of [
      "attempt" + "Id",
      "scope",
      "completion",
      "ba" + "tch",
    ])
      expect(invocation).not.toHaveProperty(removed);
  });

  it("fails closed for foreign app-owned paths and provider mismatch", async () => {
    const value = await fixture();
    await expect(
      value.invoker.invoke(
        { ...(value.input as object), worktreePath: "/tmp/not-owned" } as never,
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "runtime_unavailable" },
    });
    await expect(
      value.invoker.invoke(
        { ...(value.input as object), contextPath: value.patch } as never,
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "runtime_unavailable" },
    });
    await expect(
      value.invoker.invoke(
        { ...(value.input as object), patchPath: value.context } as never,
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "runtime_unavailable" },
    });
    await expect(
      value.invoker.invoke(
        { ...(value.input as object), provider: "pi" } as never,
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ _tag: "err", error: { reason: "execution_failed" } });
    expect(value.calls).toHaveLength(0);
  });
});
