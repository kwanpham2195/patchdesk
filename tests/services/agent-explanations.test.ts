import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseAgentExplanationId,
  parseRepoRelativePath,
  parseReviewSessionId,
} from "../../src/domain/ids";
import {
  cleanupLocalApplyRoots,
  localApplyHarness,
  profileId,
  value,
} from "./local-apply-fixture";

afterEach(cleanupLocalApplyRoots);

const probe = [
  "export function sum(values: number[]): number {",
  "  let total = 0;",
  "  for (let index = 0; index <= values.length; index += 1) {",
  "    total += values[index] ?? 0;",
  "  }",
  "  return total;",
  "}",
  "",
].join("\n");
const probePath = value(parseRepoRelativePath("probe.ts"));

/** A local Review of the untracked `probe.ts`, every line of it added. */
async function probeReview() {
  const harness = await localApplyHarness();
  await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
  const workbench = await harness.open();
  const explain = (line: number, text: string) =>
    harness.explanations.explain({
      profileId,
      reviewId: workbench.review.id,
      sessionId: workbench.session.id,
      anchor: { path: probePath, side: "new", startLine: line, line },
      text,
    });
  return { harness, workbench, explain };
}

describe("Agent explanations on a local Review (#665)", () => {
  it("keeps an explanation on unchanged lines after a move, marks one on changed lines outdated, and drops one it cannot place", async () => {
    const { harness, workbench, explain } = await probeReview();
    value(await explain(6, "Returns the running total."));
    value(await explain(3, "The bound is inclusive on purpose."));
    value(await explain(2, "Starts at zero."));

    await writeFile(
      join(harness.repositoryPath, "probe.ts"),
      probe.replace("index <= values.length", "index < values.length"),
    );
    const moved = await harness.open();

    expect(moved.session.id).not.toBe(workbench.session.id);
    expect(moved.agentExplanations).toEqual([
      expect.objectContaining({
        sessionId: moved.session.id,
        startLine: 6,
        text: "Returns the running total.",
      }),
      expect.objectContaining({
        sessionId: moved.session.id,
        startLine: 3,
        text: "The bound is inclusive on purpose.",
        outdated: true,
      }),
    ]);
    expect(moved.agentExplanations?.[0]).not.toHaveProperty("outdated");
  });

  it("holds at most 10 explanations: a repeat returns the stored one, an eleventh is refused, and Dismiss frees a slot", async () => {
    const { harness, workbench, explain } = await probeReview();
    const stored = [];
    for (let index = 1; index <= 10; index += 1)
      stored.push(value(await explain(1, `Reason ${String(index)}.`)));

    const repeat = await explain(1, "Reason 3.");
    const eleventh = await explain(2, "One too many.");
    const dismissed = await harness.explanations.dismiss({
      profileId,
      reviewId: workbench.review.id,
      sessionId: workbench.session.id,
      explanationId: value(parseAgentExplanationId(stored[0]?.explanationId)),
    });
    const afterDismiss = await explain(2, "One too many.");

    expect(stored.at(-1)).toMatchObject({
      explanationCount: 10,
      sessionId: workbench.session.id,
    });
    expect(repeat).toEqual({
      _tag: "ok",
      value: expect.objectContaining({
        explanationId: stored[2]?.explanationId,
        explanationCount: 10,
      }),
    });
    expect(eleventh).toEqual({
      _tag: "err",
      error: { reason: "explanation_limit" },
    });
    expect(dismissed).toMatchObject({ _tag: "ok" });
    expect(value(dismissed).agentExplanations).toHaveLength(9);
    expect(afterDismiss).toMatchObject({
      _tag: "ok",
      value: { explanationCount: 10 },
    });
  });

  it.each([
    {
      name: "a session the Review is not on",
      otherSession: true,
      line: 1,
      text: "Explained.",
      reason: "stale_session",
    },
    {
      name: "lines outside the Combined diff",
      line: 20,
      text: "Explained.",
      reason: "lines_not_in_diff",
    },
    {
      name: "credential-shaped text",
      line: 1,
      // Assembled at runtime so the source holds no token a secret scanner would flag.
      text: `The token was ghp_${"a".repeat(36)}.`,
      reason: "explanation_sensitive",
    },
    { name: "blank text", line: 1, text: "   ", reason: "invalid_input" },
  ])(
    "refuses $name as $reason and stores nothing",
    async ({ otherSession, line, text, reason }) => {
      const { harness, workbench } = await probeReview();

      const refused = await harness.explanations.explain({
        profileId,
        reviewId: workbench.review.id,
        sessionId:
          otherSession === true
            ? value(
                parseReviewSessionId(
                  workbench.session.id.replace(
                    /[a-f0-9]{12}$/u,
                    "0".repeat(12),
                  ),
                ),
              )
            : workbench.session.id,
        anchor: { path: probePath, side: "new", startLine: line, line },
        text,
      });
      const review = value(
        await harness.reviews.load(profileId, workbench.review.id),
      );

      expect(refused).toEqual({ _tag: "err", error: { reason } });
      expect(review.agentExplanations).toBeUndefined();
    },
  );
});
