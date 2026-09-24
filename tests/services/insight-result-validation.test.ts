import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseAbsolutePath,
  parseContentHash,
  parseGitSha,
  parseInsightRunId,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type { RawJsonValue } from "../../src/domain/json";
import type { Result } from "../../src/domain/result";
import {
  parseReviewResult,
  type ReviewResult,
} from "../../src/domain/review-result";
import type { InsightInvocationInput } from "../../src/services/insight-run-coordinator";
import { validateInsightResult } from "../../src/services/insight-result-validation";

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "ok") return result.value;
  throw new Error("Invalid test fixture");
}

const profileId = must(parseWorkspaceProfileId("acme"));
const reviewId = must(
  parseReviewId("acme__octo-org__patchdesk__pr-42__review-abcdef123456"),
);
const sessionId = must(
  parseReviewSessionId(
    "github.com__octo-org__patchdesk__pr-42__sha-11111111__base-22222222__abcdef123456",
  ),
);
const headSha = must(parseGitSha("1".repeat(40)));
const patchHash = must(parseContentHash("a".repeat(64)));
const runId = must(
  parseInsightRunId(`insight-analysis-1-${headSha.slice(0, 12)}-${reviewId}`),
);

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  "",
].join("\n");

/** One P2 finding on new-side line 2, which the fixture patch carries. */
function analysisResult(
  finding: Readonly<Record<string, RawJsonValue>>,
): RawJsonValue {
  return {
    changeSummary: "Adds one guarded change.",
    verdict: "comment",
    summary: "Check the guard.",
    findings: [
      {
        id: "finding-1",
        severity: "P2",
        title: "Guard runs too late",
        file: "src/a.ts",
        lineStart: 2,
        diffSide: "new",
        explanation: "The mutation runs before the guard.",
        confidence: "high",
        whyItMatters: "A stale write lands.",
        ...finding,
      },
    ],
    validationPlan: [],
    assumptions: [],
  };
}

describe("validateInsightResult retains only verified suggestions", () => {
  let root = "";
  let input: InsightInvocationInput;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "patchdesk-insight-validation-"));
    const patchPath = join(root, "session.patch");
    await writeFile(patchPath, patch, "utf8");
    input = {
      profileId,
      reviewId,
      sessionId,
      runId,
      type: "analysis",
      expectedHeadSha: headSha,
      contextPath: join(root, "context.json"),
      patchPath,
      worktreePath: must(parseAbsolutePath(root)),
      provider: "pi",
      model: "gpt-5.6-luna",
      reasoning: "medium",
      language: "en",
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function retainedFinding(
    finding: Readonly<Record<string, RawJsonValue>>,
  ): Promise<ReviewResult["findings"][number]> {
    const validated = await validateInsightResult(
      "analysis",
      analysisResult(finding),
      input,
      { sessionId, headSha, patchHash },
    );
    if (validated._tag === "err") throw new Error("expected a valid result");
    // The retained value is `unknown` at this seam; its own domain parser gives
    // the test a typed Finding without a cast.
    const parsed = parseReviewResult(validated.value);
    if (parsed._tag === "err") throw new Error("expected a review result");
    const first = parsed.value.findings[0];
    if (first === undefined) throw new Error("expected one retained finding");
    return first;
  }

  it("keeps a new-side replacement the patch backs", async () => {
    expect(
      await retainedFinding({
        suggestedReplacement: { code: "const b = requireFresh();" },
      }),
    ).toMatchObject({
      suggestedReplacement: { code: "const b = requireFresh();" },
    });
  });

  it("drops an old-side replacement and keeps the rest of the finding", async () => {
    const finding = await retainedFinding({
      diffSide: "old",
      lineStart: 2,
      suggestedReplacement: { code: "const b = requireFresh();" },
    });
    expect(finding.suggestedReplacement).toBeUndefined();
    expect("suggestedReplacement" in finding).toBe(false);
    expect(finding.whyItMatters).toBe("A stale write lands.");
  });

  it("drops a replacement whose file the patch does not carry", async () => {
    const finding = await retainedFinding({
      file: "src/absent.ts",
      suggestedReplacement: { code: "const b = requireFresh();" },
    });
    expect(finding.suggestedReplacement).toBeUndefined();
    expect(finding.whyItMatters).toBe("A stale write lands.");
  });

  it("drops a replacement whose comment prose carries a fence", async () => {
    const finding = await retainedFinding({
      suggestedComment: "Use this instead:\n\n```ts\nconst b = 3;\n```",
      suggestedReplacement: { code: "const b = requireFresh();" },
    });
    expect(finding.suggestedReplacement).toBeUndefined();
    expect(finding.whyItMatters).toBe("A stale write lands.");
  });
});
