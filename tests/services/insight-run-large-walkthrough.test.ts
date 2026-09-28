import { writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";
import * as v from "valibot";

import { ok } from "../../src/domain/result";
import {
  cleanupRoots,
  fixture,
  profileId,
  settled,
} from "./insight-run-fixture";

afterEach(cleanupRoots);

describe("large Walkthrough retention", () => {
  it("retains a bounded reading path and every uncited hunk for a 952-hunk patch", async () => {
    const patch =
      Array.from({ length: 200 }, (_, fileIndex) => {
        const path = `src/module-${fileIndex + 1}.ts`;
        const hunkCount = fileIndex < 152 ? 5 : 4;
        return [
          `diff --git a/${path} b/${path}`,
          `--- a/${path}`,
          `+++ b/${path}`,
          ...Array.from({ length: hunkCount }, (_, hunkIndex) =>
            [
              `@@ -${hunkIndex},0 +${hunkIndex + 1} @@`,
              `+const value${hunkIndex} = true;`,
            ].join("\n"),
          ),
        ].join("\n");
      }).join("\n") + "\n";
    const chapters = [
      {
        title: "Reading path",
        sections: Array.from({ length: 12 }, (_, sectionIndex) => ({
          title: `Decision ${sectionIndex + 1}`,
          prose: `src/module-${Math.floor((sectionIndex * 2) / 5) + 1}.ts and src/module-${Math.floor((sectionIndex * 2 + 1) / 5) + 1}.ts contain representative changes.`,
          hunkIds: [`h${sectionIndex * 2 + 1}`, `h${sectionIndex * 2 + 2}`],
        })),
      },
    ];
    const value = await fixture({
      async invoke() {
        return ok({
          citationVersion: 2,
          title: "Large patch reading path",
          focus: "Follow representative changes.",
          chapters,
        });
      },
    });
    await writeFile(value.session.patchPath, patch);
    const started = await value.coordinator.start({
      profileId,
      reviewId: value.review.id,
      type: "walkthrough",
      model: "model",
      reasoning: "medium",
      language: "en",
    });
    if (started._tag === "err") throw new Error("Expected Walkthrough run");
    expect(
      await settled(
        value.coordinator,
        value.review.id,
        started.value.runId,
        "walkthrough",
      ),
    ).toMatchObject({ status: "completed" });

    const stored = await value.insights.loadTyped(
      profileId,
      value.review.id,
      "walkthrough",
      (input) => ok(input),
    );
    if (stored._tag === "err" || stored.value.retained === undefined)
      throw new Error("Expected retained Walkthrough");
    const result = v.safeParse(
      v.object({
        citationStatus: v.literal("verified"),
        chapters: v.array(
          v.object({
            sections: v.array(v.object({ hunkIds: v.array(v.string()) })),
          }),
        ),
        support: v.object({ hunkIds: v.array(v.string()) }),
      }),
      stored.value.retained.value,
    );
    if (!result.success) throw new Error("Expected bounded retained citations");
    const cited = result.output.chapters.flatMap((chapter) =>
      chapter.sections.flatMap((section) => section.hunkIds),
    );
    expect(result.output.chapters[0]?.sections).toHaveLength(12);
    expect(cited).toHaveLength(24);
    expect(cited).toContain("h24");
    expect(result.output.support.hunkIds).toHaveLength(928);
    expect(result.output.support.hunkIds).toContain("h25");
    expect(result.output.support.hunkIds).toContain("h952");
  });
});
