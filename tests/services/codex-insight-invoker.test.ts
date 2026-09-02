import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { CodexInsightInvoker } from "../../src/services/codex-insight-invoker";
import {
  MAX_ANALYSIS_CODEX_PROMPT_BYTES,
  MAX_WALKTHROUGH_PROMPT_BYTES,
  type CodexRunInput,
} from "../../src/adapters/codex/codex-app-server-client";
import { ok } from "../../src/domain/result";

// Matches PiInsightChildInvoker.invokeAnalysis's Analysis run bound.
const EXPECTED_ANALYSIS_TIMEOUT_MS = 10 * 60_000;

// Five-minute floor plus one step for this fixture's single-hunk patch.
const EXPECTED_WALKTHROUGH_TIMEOUT_MS = 6 * 60_000;

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

async function fixture(
  options: { readonly type?: "analysis" | "walkthrough" } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-codex-insight-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  // SAFETY: this fixture only exercises CodexInsightInvoker's path-ownership and provider checks,
  // never WorkspaceProfileId/ReviewSessionId's own validation, so a plain string in the right shape
  // stands in for the branded type without pulling in the parser.
  const profileId = "cfw" as never;
  // SAFETY: same as above — this fixture never exercises ReviewSessionId's own parser.
  const sessionId =
    "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__base-00000000__439aa21713b5" as never;
  const worktree = paths.worktreeDirectory(profileId, sessionId);
  const reviewInput = paths.preparedReviewInputFile(profileId, sessionId);
  const context = paths.preparedContextFile(profileId, sessionId);
  const patch = paths.patchFile(profileId, sessionId);
  await mkdir(worktree, { recursive: true });
  await mkdir(join(reviewInput, ".."), { recursive: true });
  await Promise.all([
    writeFile(reviewInput, "PR: patchdesk#42", "utf8"),
    writeFile(context, "{}", "utf8"),
    writeFile(
      patch,
      [
        "diff --git a/a.ts b/a.ts",
        "index 1111111..2222222 100644",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,1 +1,2 @@",
        "-old",
        "+new",
        "+added",
        "",
      ].join("\n"),
      "utf8",
    ),
  ]);
  const calls: Array<[CodexRunInput, { readonly signal?: AbortSignal }]> = [];
  const run = async (
    input: CodexRunInput,
    options: { readonly signal?: AbortSignal } = {},
  ) => {
    calls.push([input, options]);
    return ok({ findings: [] });
  };
  const invoker = new CodexInsightInvoker(
    paths,
    // SAFETY: CodexInsightInvoker only ever calls `.run(...)` on the client this factory returns,
    // so a plain object exposing just `run` safely stands in for the full CodexAppServerClient.
    () => ({ run }) as never,
    "/usr/bin/codex",
    async () => "a".repeat(40),
  );
  // SAFETY: CodexInsightInvoker.invoke only compares/forwards these fields (realpath checks and
  // string equality); it never calls their branded parsers, so plain strings exercise the same
  // code paths as real InsightInvocationInput values.
  const input = {
    profileId,
    reviewId:
      "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa",
    sessionId,
    runId: "insight-analysis-1-aaaaaaaaaaaa-review",
    type: options.type ?? "analysis",
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
    // SAFETY: the toHaveLength(1) assertion just above guarantees calls[0] exists.
    const invocation = value.calls[0]?.[0] as CodexRunInput;
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
    // SAFETY: value.input is already the plain fixture object built above (never a real
    // InsightInvocationInput instance), so widening it to `object` here only unlocks the spread;
    // the rebuilt literal is read the same way described for the `input` cast above.
    await expect(
      value.invoker.invoke(
        { ...(value.input as object), worktreePath: "/tmp/not-owned" } as never,
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "runtime_unavailable" },
    });
    // SAFETY: same as above.
    await expect(
      value.invoker.invoke(
        { ...(value.input as object), contextPath: value.patch } as never,
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "runtime_unavailable" },
    });
    // SAFETY: same as above.
    await expect(
      value.invoker.invoke(
        { ...(value.input as object), patchPath: value.context } as never,
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "runtime_unavailable" },
    });
    // SAFETY: same as above.
    await expect(
      value.invoker.invoke(
        { ...(value.input as object), provider: "pi" } as never,
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ _tag: "err", error: { reason: "execution_failed" } });
    expect(value.calls).toHaveLength(0);
  });

  it("builds a walkthrough prompt with the HUNK ALIAS MANIFEST and patch, and returns the run result unchanged", async () => {
    const value = await fixture({ type: "walkthrough" });
    await expect(
      value.invoker.invoke(value.input, {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ _tag: "ok", value: { findings: [] } });
    expect(value.calls).toHaveLength(1);
    // SAFETY: the fake run() above only ever receives the CodexRunInput this test's invoker builds.
    const invocation = value.calls[0]?.[0] as {
      readonly prompt?: unknown;
      readonly maxPromptBytes?: unknown;
      readonly runTimeoutMs?: unknown;
    };
    expect(invocation.prompt).toEqual(expect.any(String));
    // SAFETY: the prompt assertion just above proves invocation.prompt is a string.
    const prompt = invocation.prompt as string;
    expect(prompt).toContain("HUNK ALIAS MANIFEST");
    expect(prompt).toContain("diff --git a/a.ts b/a.ts");
    expect(invocation.maxPromptBytes).toBe(MAX_WALKTHROUGH_PROMPT_BYTES);
    expect(invocation.runTimeoutMs).toBe(EXPECTED_WALKTHROUGH_TIMEOUT_MS);
  });

  it("builds an analysis prompt with the patch and the verdict rule, and uses the analysis bounds", async () => {
    const value = await fixture({ type: "analysis" });
    await expect(
      value.invoker.invoke(value.input, {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ _tag: "ok", value: { findings: [] } });
    expect(value.calls).toHaveLength(1);
    // SAFETY: the fake run() above only ever receives the CodexRunInput this test's invoker builds.
    const invocation = value.calls[0]?.[0] as {
      readonly prompt?: unknown;
      readonly maxPromptBytes?: unknown;
      readonly runTimeoutMs?: unknown;
    };
    expect(invocation.prompt).toEqual(expect.any(String));
    // SAFETY: the prompt assertion just above proves invocation.prompt is a string.
    const prompt = invocation.prompt as string;
    expect(prompt).toContain("diff --git a/a.ts b/a.ts");
    expect(prompt).toContain(
      "The verdict must match the findings: use request_changes when any finding is P0 or P1",
    );
    expect(invocation.maxPromptBytes).toBe(MAX_ANALYSIS_CODEX_PROMPT_BYTES);
    expect(invocation.runTimeoutMs).toBe(EXPECTED_ANALYSIS_TIMEOUT_MS);
  });
});
