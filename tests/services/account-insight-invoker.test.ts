import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { AccountInsightInvoker } from "#src/services/account-insight-invoker";
import {
  MAX_ANALYSIS_CODEX_PROMPT_BYTES,
  type CodexRunInput,
} from "#src/adapters/codex/codex-app-server-client";
import { prepareGuidePrompt } from "#src/services/guide-operation";
import type { InsightInvocationInput } from "#src/services/insight-run-coordinator";
import type { AccountInsightProvider } from "#src/domain/insight-provider";
import { ok } from "#src/domain/result";
import { hashReviewArtifactContent } from "#src/services/review-artifact-hash";
import { insightEvidenceReference } from "#src/services/insight-evidence-reference";

const EXPECTED_ANALYSIS_TIMEOUT_MS = 20 * 60_000;

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

async function fixture(
  options: {
    readonly provider?: AccountInsightProvider;
    readonly type?: "analysis" | "walkthrough" | "brief";
    readonly language?: "en" | "vi";
    readonly runValue?: Readonly<Record<string, ReadonlyArray<never> | null>>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-codex-insight-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  // SAFETY: this fixture only exercises AccountInsightInvoker's path-ownership and provider checks,
  // never WorkspaceProfileId/ReviewSessionId's own validation, so a plain string in the right shape
  // stands in for the branded type without pulling in the parser.
  const profileId = "acme" as never;
  // SAFETY: same as above — this fixture never exercises ReviewSessionId's own parser.
  const sessionId =
    "github.com__octo-org__patchdesk__pr-42__sha-abcdef12__base-00000000__439aa21713b5" as never;
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
  const complete = {
    changeSummary: "Change",
    verdict: "approve",
    summary: "Reviewed",
    findings: [],
    validationPlan: [],
    assumptions: [],
  };
  const resultValue =
    options.runValue === undefined
      ? complete
      : { ...complete, ...options.runValue };
  const runValue =
    (options.type ?? "analysis") === "analysis"
      ? { outcome: "complete", result: resultValue, incomplete: null }
      : (options.runValue ?? { findings: [] });
  const run = async (
    input: CodexRunInput,
    options: { readonly signal?: AbortSignal } = {},
  ) => {
    calls.push([input, options]);
    return ok(runValue);
  };
  const invoker = new AccountInsightInvoker(
    options.provider ?? "codex-cli-account",
    paths,
    () => ({ run }),
    "/usr/bin/codex",
    async () => "a".repeat(40),
  );
  const directory = paths.insightEvidenceDirectory(
    profileId,
    sessionId,
    "insight-analysis-1-aaaaaaaaaaaa-review" as never,
  );
  const entryPageId = `${"d".repeat(64)}-p1`;
  const entryText =
    JSON.stringify({
      kind: "page",
      bundleId: "d".repeat(64),
      pageId: entryPageId,
    }) +
    "\n" +
    JSON.stringify({ kind: "continuation", pageId: null }) +
    "\n";
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${entryPageId}.ndjson`), entryText);
  // SAFETY: AccountInsightInvoker.invoke only compares/forwards these fields (realpath checks and
  // string equality); it never calls their branded parsers, so plain strings exercise the same
  // code paths as real InsightInvocationInput values.
  const input: InsightInvocationInput = {
    profileId,
    reviewId:
      "github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa" as never,
    sessionId,
    runId: "insight-analysis-1-aaaaaaaaaaaa-review" as never,
    type: options.type ?? "analysis",
    expectedHeadSha: "a".repeat(40) as never,
    contextPath: context,
    reviewInputPath: reviewInput,
    patchPath: patch,
    worktreePath: worktree,
    provider: options.provider ?? "codex-cli-account",
    model: "codex",
    reasoning: "medium",
    language: options.language ?? "en",
    evidence: {
      identity: {
        profileId,
        reviewId: "github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
        sessionId,
        runId: "insight-analysis-1-aaaaaaaaaaaa-review",
        type: options.type ?? "analysis",
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        patchHash: "c".repeat(64),
        intentHash: null,
      },
      bundleId: "d".repeat(64),
      directory,
      entryPageId,
      pages: [
        {
          id: entryPageId,
          sha256: hashReviewArtifactContent(entryText),
          text: entryText,
          records: [],
        },
      ],
      sources: [],
      manifestText: "{}",
      patchPath: patch,
    } as never,
  };
  return { invoker, input, calls, worktree, reviewInput, context, patch };
}

describe("AccountInsightInvoker", () => {
  it.each(["codex-cli-account", "pi-cli-account"] as const)(
    "uses captured complete Guide evidence on %s without unavailable tools",
    async (provider) => {
      const value = await fixture({ provider, language: "vi" });
      if (value.input.evidence === undefined)
        throw new Error("Missing fixture evidence");
      const prepared = await prepareGuidePrompt({
        contextPath: value.context,
        patchPath: value.patch,
        language: "vi",
        evidence: insightEvidenceReference(value.input.evidence),
      });
      if (prepared._tag === "err") throw new Error("Guide preparation failed");
      await writeFile(value.context, "Changed after capture");
      await value.invoker.invoke(
        { ...value.input, type: "guide", guide: prepared.value },
        { signal: new AbortController().signal },
      );
      expect(value.calls).toHaveLength(1);
      expect(value.calls[0]?.[0].prompt).toBe(
        [
          prepared.value.prompt,
          "Inspect only the captured evidence for this Review. Do not modify files, access credentials, use network tools, or publish anything. Honor native permission decisions and report a denied required read without bypassing it.",
          `Native evidence directory: ${JSON.stringify(value.input.evidence.directory)}`,
          `Native evidence entry file: ${JSON.stringify(join(value.input.evidence.directory, `${value.input.evidence.entryPageId}.ndjson`))}`,
          `Read the entry with this complete shell command, preserving both enclosing quotes: cat -- '${join(value.input.evidence.directory, `${value.input.evidence.entryPageId}.ndjson`).replaceAll("'", "'\\''")}'`,
          "Use native inspection tools to read this NDJSON entry, then the referenced page IDs as files in the same directory with the .ndjson suffix. Read at most one captured page per native tool call and request enough output for the complete page.",
          "A shell syntax error is not a permission refusal. Correct mismatched quotes and reread the same captured page. A native permission refusal remains authoritative; do not bypass it.",
          "If page output is truncated, reread that same page in consecutive physical NDJSON line ranges, starting at its first line with one bounded record per call, for example sed -n 'N,Np' <captured-page>. Emit plain ranges without line-number decoration. Track the next unread physical line and finish every intervening record, including the continuation record, before following the continuation.",
          "If a record itself is truncated, read contiguous UTF-8-safe subranges of that same record. Subdivide further on actual truncation or omission warnings until every part is complete; never skip the middle. If complete delivery cannot be obtained, report incomplete evidence, not partial success. Fragment text and original source coordinates are the captured evidence; physical page line numbers are read cursors, not source citations.",
        ].join("\n\n"),
      );
      expect(value.calls[0]?.[0].prompt).not.toContain(
        "submit_patchdesk_result",
      );
      expect(value.calls[0]?.[0].prompt).not.toContain("Changed after capture");
      expect(value.calls[0]?.[0].outputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["groups"],
      });
    },
  );

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

  it("rejects a worktree outside the app-owned Review path", async () => {
    const value = await fixture();
    // SAFETY: the fixture input is a plain object; this changes only its worktree path.
    await expect(
      value.invoker.invoke(
        { ...(value.input as object), worktreePath: "/tmp/not-owned" } as never,
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "review_worktree_unavailable" },
    });
    expect(value.calls).toHaveLength(0);
  });

  it("rejects a context path that does not match the prepared context", async () => {
    const value = await fixture();
    // SAFETY: the fixture input is a plain object; this changes only its context path.
    await expect(
      value.invoker.invoke(
        { ...(value.input as object), contextPath: value.patch } as never,
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "review_worktree_unavailable" },
    });
    expect(value.calls).toHaveLength(0);
  });

  it("rejects a patch path that does not match the prepared patch", async () => {
    const value = await fixture();
    // SAFETY: the fixture input is a plain object; this changes only its patch path.
    await expect(
      value.invoker.invoke(
        { ...(value.input as object), patchPath: value.context } as never,
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "review_worktree_unavailable" },
    });
    expect(value.calls).toHaveLength(0);
  });

  it("rejects a provider mismatch before invoking Codex", async () => {
    const value = await fixture();
    // SAFETY: the fixture input is a plain object; this changes only its provider.
    await expect(
      value.invoker.invoke(
        { ...(value.input as object), provider: "pi" } as never,
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ _tag: "err", error: { reason: "execution_failed" } });
    expect(value.calls).toHaveLength(0);
  });

  it("rejects a missing represented worktree", async () => {
    const value = await fixture();
    await rm(value.worktree, { recursive: true, force: true });
    await expect(
      value.invoker.invoke(value.input, {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "review_worktree_unavailable" },
    });
  });

  it("rejects a represented worktree with a mismatched head", async () => {
    const value = await fixture();
    await expect(
      value.invoker.invoke(
        {
          ...(value.input as object),
          expectedHeadSha: "b".repeat(40),
        } as never,
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "review_worktree_unavailable" },
    });
  });

  it("refuses Codex account Walkthrough generation without a native turn", async () => {
    const value = await fixture({ type: "walkthrough" });
    await expect(
      value.invoker.invoke(value.input, {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "runtime_unavailable" },
    });
    expect(value.calls).toEqual([]);
  });

  it("refuses pi CLI account Walkthrough generation without a native turn", async () => {
    const value = await fixture({
      type: "walkthrough",
      provider: "pi-cli-account",
    });
    await expect(
      value.invoker.invoke(value.input, {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "runtime_unavailable" },
    });
    expect(value.calls).toHaveLength(0);
  });

  it("builds an analysis prompt with the patch and the verdict rule, and uses the analysis bounds", async () => {
    const value = await fixture({ type: "analysis" });
    await expect(
      value.invoker.invoke(value.input, {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        changeSummary: "Change",
        verdict: "approve",
        summary: "Reviewed",
        findings: [],
        validationPlan: [],
        assumptions: [],
      },
    });
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
    expect(prompt).toContain("EVIDENCE ENTRY:");
    expect(prompt).not.toContain("diff --git a/a.ts b/a.ts");
    expect(prompt).toContain(
      "The verdict must match the findings: use request_changes when any finding is P0 or P1",
    );
    expect(invocation.maxPromptBytes).toBe(MAX_ANALYSIS_CODEX_PROMPT_BYTES);
    expect(invocation.runTimeoutMs).toBe(EXPECTED_ANALYSIS_TIMEOUT_MS);
  });

  it.each([
    ["analysis", "outcome"],
    ["brief", "flow"],
  ] as const)(
    "sends the %s output schema and returns null fields as absent",
    async (type, schemaProperty) => {
      const value = await fixture({
        type,
        runValue: { findings: [], coverage: null },
      });
      await expect(
        value.invoker.invoke(value.input, {
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({
        _tag: "ok",
        value:
          type === "analysis"
            ? {
                changeSummary: "Change",
                verdict: "approve",
                summary: "Reviewed",
                findings: [],
                validationPlan: [],
                assumptions: [],
              }
            : { findings: [] },
      });
      expect(value.calls[0]?.[0].outputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: expect.arrayContaining([schemaProperty]),
      });
    },
  );

  it.each(["analysis", "brief"] as const)(
    "writes the %s prompt's language rule in the language the run chose",
    async (type) => {
      const value = await fixture({ type, language: "vi" });
      await value.invoker.invoke(value.input, {
        signal: new AbortController().signal,
      });
      const prompt = value.calls[0]?.[0].prompt;
      expect(prompt).toEqual(expect.stringContaining('BCP 47 tag "vi"'));
      expect(prompt).toEqual(
        expect.stringContaining(
          "Keep domain names in the form used by that evidence. Translate the surrounding explanation.",
        ),
      );
    },
  );
});
