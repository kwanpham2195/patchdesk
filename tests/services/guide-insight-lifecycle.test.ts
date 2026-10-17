import { projectStoredInsight } from "#src/domain/insight";
import { parseContentHash } from "#src/domain/ids";
import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { InsightStore } from "#src/adapters/storage/insight-store";
import { parseRetainedGuide } from "#src/domain/guide";
import { err, ok } from "#src/domain/result";
import {
  cleanupRoots,
  fixture,
  must,
  profileId,
  settled,
} from "./insight-run-fixture";

const output = {
  groups: [
    {
      title: "Restore request",
      explanation: "Restores pending state.",
      files: [{ fileId: "f1", relevance: "Restores the pending request." }],
    },
  ],
};
afterEach(cleanupRoots);

class CompletionFailingStore extends InsightStore {
  failNextCompletion = false;
  override async save(
    ...input: Parameters<InsightStore["save"]>
  ): ReturnType<InsightStore["save"]> {
    if (
      this.failNextCompletion &&
      input[1].activeRun === undefined &&
      input[1].retained !== undefined
    ) {
      this.failNextCompletion = false;
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    return super.save(...input);
  }
}

describe("retained Guide lifecycle", () => {
  it.each(["current", "outdated"] as const)(
    "keeps retained Guide freshness %s during replacement and failure",
    async (freshness) => {
      let attempt = 0;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const value = await fixture({
        async invoke() {
          attempt += 1;
          if (attempt === 1) return ok(output);
          await waiting;
          return err({ reason: "execution_failed" });
        },
      });
      const input = {
        profileId,
        reviewId: value.review.id,
        type: "guide" as const,
        model: "model",
        reasoning: "medium" as const,
        language: "en" as const,
      };
      const first = must(await value.coordinator.start(input));
      await settled(value.coordinator, value.review.id, first.runId, "guide");
      const prior = must(
        await value.insights.loadTyped(
          profileId,
          value.review.id,
          "guide",
          parseRetainedGuide,
        ),
      );
      if (prior.retained === undefined)
        throw new Error("Missing retained Guide");
      const representedHash =
        freshness === "current"
          ? prior.retained.revision.patchHash
          : must(parseContentHash("b".repeat(64)));
      const second = must(await value.coordinator.start(input));
      const running = must(
        await value.insights.loadTyped(
          profileId,
          value.review.id,
          "guide",
          parseRetainedGuide,
        ),
      );
      const projected = projectStoredInsight(
        running,
        value.session,
        representedHash,
      );
      expect(projected.status).toBe("running");
      expect(projected.retained?.freshness).toBe(freshness);
      release();
      await settled(value.coordinator, value.review.id, second.runId, "guide");
      const failed = must(
        await value.insights.loadTyped(
          profileId,
          value.review.id,
          "guide",
          parseRetainedGuide,
        ),
      );
      const afterFailure = projectStoredInsight(
        failed,
        value.session,
        representedHash,
      );
      expect(afterFailure.status).toBe("failed");
      expect(afterFailure.retained?.freshness).toBe(freshness);
    },
  );

  it("preserves the retained Guide when replacement persistence fails", async () => {
    let store: CompletionFailingStore | undefined;
    let attempt = 0;
    const value = await fixture(
      {
        async invoke() {
          attempt += 1;
          if (attempt === 2 && store !== undefined)
            store.failNextCompletion = true;
          return ok(output);
        },
      },
      {
        insightStore: (paths) => {
          store = new CompletionFailingStore(paths);
          return store;
        },
      },
    );
    const input = {
      profileId,
      reviewId: value.review.id,
      type: "guide" as const,
      model: "model",
      reasoning: "medium" as const,
      language: "en" as const,
    };
    const first = must(await value.coordinator.start(input));
    await settled(value.coordinator, value.review.id, first.runId, "guide");
    const replacement = must(await value.coordinator.start(input));
    await settled(
      value.coordinator,
      value.review.id,
      replacement.runId,
      "guide",
    );
    const retained = must(
      await value.insights.loadTyped(
        profileId,
        value.review.id,
        "guide",
        parseRetainedGuide,
      ),
    );
    expect(retained.retained?.runId).toBe(first.runId);
    expect(retained.activeRun).toBeUndefined();
  });

  it("captures complete evidence and reloads after source artifact deletion", async () => {
    const value = await fixture({
      async invoke(input) {
        expect(input.guide?.inventory.map((file) => file.id)).toEqual(["f1"]);
        expect(input.guide?.prompt).toContain("EVIDENCE ENTRY:");
        return ok(output);
      },
    });
    const run = must(
      await value.coordinator.start({
        profileId,
        reviewId: value.review.id,
        type: "guide",
        model: "model",
        reasoning: "medium",
        language: "vi",
      }),
    );
    expect(
      (await settled(value.coordinator, value.review.id, run.runId, "guide"))
        .status,
    ).toBe("completed");
    await rm(value.session.patchPath);
    const loaded = must(
      await new InsightStore(value.paths).loadTyped(
        profileId,
        value.review.id,
        "guide",
        parseRetainedGuide,
      ),
    );
    expect(loaded.retained?.value.inventory[0]?.newPath).toBe("a.ts");
    expect(loaded.retained?.provenance.language).toBe("vi");
    expect(
      createHash("sha256")
        .update(loaded.retained?.value.patchText ?? "")
        .digest("hex"),
    ).toBe(loaded.retained?.revision.patchHash);
  });
  it.each(["invalid", "failed", "cancelled"] as const)(
    "preserves its prior result after %s replacement",
    async (outcome) => {
      let attempt = 0;
      const value = await fixture({
        async invoke() {
          attempt += 1;
          if (attempt === 1) return ok(output);
          if (outcome === "invalid")
            return ok({
              groups: [
                {
                  ...output.groups[0],
                  files: [{ fileId: "f99", relevance: "Missing" }],
                },
              ],
            });
          return err({
            reason: outcome === "cancelled" ? "cancelled" : "execution_failed",
          });
        },
      });
      const input = {
        profileId,
        reviewId: value.review.id,
        type: "guide" as const,
        model: "model",
        reasoning: "medium" as const,
        language: "en" as const,
      };
      const first = must(await value.coordinator.start(input));
      await settled(value.coordinator, value.review.id, first.runId, "guide");
      const second = must(await value.coordinator.start(input));
      await settled(value.coordinator, value.review.id, second.runId, "guide");
      expect(
        must(
          await value.insights.loadTyped(
            profileId,
            value.review.id,
            "guide",
            parseRetainedGuide,
          ),
        ).retained?.runId,
      ).toBe(first.runId);
    },
  );
  it.each(["empty", "unindexable"] as const)(
    "fails queued %s input without invoking or replacing its prior value",
    async (size) => {
      let invocations = 0;
      const value = await fixture({
        async invoke() {
          invocations += 1;
          return ok(output);
        },
      });
      const input = {
        profileId,
        reviewId: value.review.id,
        type: "guide" as const,
        model: "model",
        reasoning: "medium" as const,
        language: "en" as const,
      };
      const first = must(await value.coordinator.start(input));
      await settled(value.coordinator, value.review.id, first.runId, "guide");
      await writeFile(
        value.session.patchPath,
        size === "empty" ? "" : "x".repeat(2 * 1024 * 1024 + 1),
      );
      const replacement = must(await value.coordinator.start(input));
      expect(replacement.status).toBe("queued");
      expect(
        await settled(
          value.coordinator,
          value.review.id,
          replacement.runId,
          "guide",
        ),
      ).toMatchObject({
        status: "failed",
        failureCategory: "guide_patch_empty",
      });
      expect(invocations).toBe(1);
      const loaded = must(
        await value.insights.loadTyped(
          profileId,
          value.review.id,
          "guide",
          parseRetainedGuide,
        ),
      );
      expect(loaded.retained?.runId).toBe(first.runId);
      expect(loaded.activeRun).toBeUndefined();
    },
  );
  it("refuses embedded evidence with a different envelope hash", async () => {
    const value = await fixture({ invoke: async () => ok(output) });
    const run = must(
      await value.coordinator.start({
        profileId,
        reviewId: value.review.id,
        type: "guide",
        model: "model",
        reasoning: "medium",
        language: "en",
      }),
    );
    await settled(value.coordinator, value.review.id, run.runId, "guide");
    const raw = must(
      await value.insights.loadTyped(
        profileId,
        value.review.id,
        "guide",
        parseRetainedGuide,
      ),
    );
    if (raw.retained === undefined) throw new Error("Missing Guide");
    await writeFile(
      value.paths.insightFile(profileId, value.review.id, "guide"),
      JSON.stringify({
        ...raw,
        retained: {
          ...raw.retained,
          revision: { ...raw.retained.revision, patchHash: "b".repeat(64) },
        },
      }),
    );
    expect(
      await new InsightStore(value.paths).loadTyped(
        profileId,
        value.review.id,
        "guide",
        parseRetainedGuide,
      ),
    ).toMatchObject({ _tag: "err", error: { reason: "invalid_stored_value" } });
  });
});
