import { afterEach, describe, expect, it, vi } from "vitest";
import * as v from "valibot";

import { readBoundedInsightArtifactFile } from "#src/adapters/storage/insight-artifact-files";
import { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import { InsightRunJournalReader } from "#src/adapters/storage/insight-run-journal-reader";
import { insightArtifactIdSchema } from "#src/domain/insight-artifact-scalars";
import { ok } from "#src/domain/result";
import { GuideResultReader } from "#src/services/guide-result-reader";
import type { NativeExplanationProducer } from "#src/services/explanation-producer";
import {
  analysisResult,
  cleanupRoots,
  fixture,
  must,
  profileId,
} from "./insight-run-fixture";

afterEach(cleanupRoots);

describe("Guide cancellation", () => {
  // Regression for #821: cancel raised the epoch before the stopped pass could settle it.
  it("settles a dispatched Guide cancellation after its epoch advances", async () => {
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    let child:
      | Parameters<NativeExplanationProducer["invokeGuide"]>[0]
      | undefined;
    let resolveDispatch!: () => void;
    let rejectDispatch!: (reason: Error) => void;
    const dispatched = new Promise<void>((resolve, reject) => {
      resolveDispatch = resolve;
      rejectDispatch = reject;
    });
    const value = await fixture(
      { invoke: async () => ok(analysisResult) },
      {
        guideInvoker: {
          async invokeGuide(input) {
            try {
              child = input;
              resolveDispatch();
              await stopped;
              return { _tag: "failed", reason: "cancelled", effectKnown: true };
            } catch (error) {
              rejectDispatch(
                error instanceof Error
                  ? error
                  : new Error("Guide invocation failed", { cause: error }),
              );
              throw error;
            }
          },
        },
      },
    );
    const key = {
      profileId,
      reviewId: value.review.id,
      type: "guide",
    } as const;
    const started = must(
      await value.coordinator.start({
        provider: "codex-cli-account" as const,
        ...key,
        model: "model",
        reasoning: "medium",
        language: "en",
      }),
    );
    try {
      await expect(dispatched).resolves.toBeUndefined();
      const run = must(await value.slots.status.activeRun(key));
      if (run === undefined || child === undefined)
        throw new Error("expected dispatched Guide");
      const journals = new InsightRunJournalReader(
        value.paths,
        new InsightArtifactStore(value.paths, readBoundedInsightArtifactFile),
        readBoundedInsightArtifactFile,
      );
      expect(must(await journals.read(run)).state).toMatchObject({
        status: "running",
        cancelEpoch: 0,
        nativeExecution: { starts: { count: 1 } },
      });
      expect(
        await value.coordinator.cancel({ ...key, runId: started.runId }),
      ).toMatchObject({
        _tag: "ok",
        value: { status: "cancelling" },
      });
      expect(child.signal.aborted).toBe(true);
      expect(must(await journals.read(run)).state).toMatchObject({
        status: "cancelling",
        cancelEpoch: 1,
      });
      release();
      // Joining tracked work requires disposal, which would abort this cancellation pass.
      await vi.waitFor(
        async () => {
          expect(must(await journals.read(run)).state).toMatchObject({
            status: "cancelled",
            cancelEpoch: 1,
          });
        },
        { timeout: 10_000 },
      );
      await vi.waitFor(
        () =>
          expect(
            value.resources?.ownership
              .forScope(value.paths.dataDirectory())
              .has(started.runId),
          ).toBe(false),
        { timeout: 10_000 },
      );
      expect(
        await new GuideResultReader(
          value.paths,
          readBoundedInsightArtifactFile,
        ).summarySource(profileId, value.review.id),
      ).toMatchObject({
        _tag: "ok",
        value: { failure: { reason: "cancelled" } },
      });
      expect(await value.slots.status.activeRun(key)).toEqual(ok(undefined));
      expect(
        await child.tool({
          tool: "open_group",
          input: {
            opId: v.parse(insightArtifactIdSchema, "late-group"),
            title: "Late guard",
            explanation: "The stopped pass must not write.",
          },
        }),
      ).toEqual({ status: "refused", reason: "cancelled" });
    } finally {
      release();
    }
  }, 10_000);
});
