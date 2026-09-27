import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { err } from "../../src/domain/result";
import {
  applyRequest,
  cleanupLocalApplyRoots,
  localApplyHarness,
  profileId,
  retainAnalysis,
  suggestionFinding,
  value,
} from "./local-apply-fixture";

afterEach(cleanupLocalApplyRoots);

const probe = "export const bound = 1;\n";
const boundFix = suggestionFinding(
  "finding-bound",
  "probe.ts",
  { start: 1, end: 1 },
  "export const bound = 2;",
);

// Insights run on Combined (ADR 0050), so a request from another patch view cannot authorize Apply.
describe("LocalApplyService patch views", () => {
  it.each(["committed", "uncommitted"] as const)(
    "refuses an Apply named %s with a Combined Analysis before the gate and writes nothing",
    async (view) => {
      const harness = await localApplyHarness();
      await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
      const workbench = await harness.open();
      const runId = await retainAnalysis(harness.insights, workbench, [
        boundFix,
      ]);
      // A changed checkout the gate would record on the Review as RevisionChanged.
      await writeFile(join(harness.repositoryPath, "tracked.txt"), "edited\n");

      const refused = await harness.service.apply({
        ...applyRequest(workbench, runId, ["finding-bound"]),
        view,
      });

      expect(refused).toEqual(err({ reason: "view_mismatch" }));
      expect(
        await readFile(join(harness.repositoryPath, "probe.ts"), "utf8"),
      ).toBe(probe);
      const review = value(
        await harness.reviews.load(profileId, workbench.review.id),
      );
      expect(review.freshness._tag).not.toBe("RevisionChanged");
      expect(
        value(await harness.operations.load(profileId, workbench.review.id)),
      ).toBeUndefined();
    },
  );
});
