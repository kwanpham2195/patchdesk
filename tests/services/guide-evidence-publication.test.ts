import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as v from "valibot";

import { GuideProgressStore } from "#src/adapters/storage/guide-progress-store";
import { readBoundedInsightArtifactFile } from "#src/adapters/storage/insight-artifact-files";
import { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import { InsightRunJournalReader } from "#src/adapters/storage/insight-run-journal-reader";
import { InsightSlotStore } from "#src/adapters/storage/insight-slot-store";
import { guidePreparedInputCodec } from "#src/domain/guide-preparation";
import {
  insightBlobBlockCodec,
  insightBlobIndexNodeCodec,
} from "#src/domain/insight-artifact-index";
import { insightArtifactIdSchema } from "#src/domain/insight-artifact-scalars";
import { guideFileIdSchema, guideGroupIdSchema } from "#src/domain/guide";
import { ok } from "#src/domain/result";
import { GuideCapturedFilePages } from "#src/services/guide-captured-file-pages";
import { GuideProgressService } from "#src/services/guide-result-progress";
import { GuideResultReader } from "#src/services/guide-result-reader";
import {
  analysisResult,
  cleanupRoots,
  fixture,
  must,
  profileId,
} from "./insight-run-fixture";

afterEach(cleanupRoots);

// Regression for #821: publication accepted a Guide whose captured patch was missing.
it("rejects a replacement with a missing captured patch block and preserves the retained Guide and progress", async () => {
  let passes = 0;
  const value = await fixture(
    { invoke: async () => ok(analysisResult) },
    {
      guideInvoker: {
        async invokeGuide(input) {
          passes += 1;
          expect(
            await input.handler({
              ...input.identity,
              correlation: 1,
              kind: "tool",
              call: {
                tool: "open_group",
                input: {
                  opId: v.parse(insightArtifactIdSchema, "group"),
                  title: "Guard",
                  explanation: "Review the guard.",
                },
              },
            }),
          ).toMatchObject({ status: "receipt" });
          expect(
            await input.handler({
              ...input.identity,
              correlation: 2,
              kind: "tool",
              call: {
                tool: "add_members",
                input: {
                  opId: v.parse(insightArtifactIdSchema, "member"),
                  groupId: v.parse(guideGroupIdSchema, "g1"),
                  members: [
                    {
                      fileId: v.parse(guideFileIdSchema, "f1"),
                      relevance: "Guard change.",
                    },
                  ],
                },
              },
            }),
          ).toMatchObject({ status: "receipt" });
          if (passes === 2) {
            const run = must(await value.slots.status.activeRun(key));
            if (run === undefined)
              throw new Error("expected active replacement");
            const journal = must(await journals.read(run));
            if (journal.state.guidePreparation === undefined)
              throw new Error("expected preparation");
            const prepared = must(
              await artifacts.readObject(
                profileId,
                value.review.id,
                guidePreparedInputCodec,
                journal.state.guidePreparation,
              ),
            );
            const index = must(
              await artifacts.readObject(
                profileId,
                value.review.id,
                insightBlobIndexNodeCodec,
                prepared.patch.data.blocks.root,
              ),
            );
            if (index.tag !== "leaf" || index.entries[0] === undefined)
              throw new Error("expected one patch block");
            const block = must(
              await artifacts.readObject(
                profileId,
                value.review.id,
                insightBlobBlockCodec,
                index.entries[0].value,
              ),
            );
            expect(block.bytes.hash).not.toBe(originalPatchHash);
            await unlink(
              must(
                value.paths.insightArtifactObjectFile(
                  profileId,
                  value.review.id,
                  block.bytes.hash,
                ),
              ),
            );
          }
          expect(
            await input.handler({
              ...input.identity,
              correlation: 3,
              kind: "tool",
              call: {
                tool: "finish",
                input: { opId: v.parse(insightArtifactIdSchema, "finish") },
              },
            }),
          ).toMatchObject({ status: "receipt" });
          return { _tag: "finished" };
        },
      },
    },
  );
  const key = { profileId, reviewId: value.review.id, type: "guide" } as const;
  const artifacts = new InsightArtifactStore(
    value.paths,
    readBoundedInsightArtifactFile,
  );
  const journals = new InsightRunJournalReader(
    value.paths,
    artifacts,
    readBoundedInsightArtifactFile,
  );
  const slots = new InsightSlotStore(
    value.paths,
    readBoundedInsightArtifactFile,
  );
  const reader = new GuideResultReader(
    value.paths,
    readBoundedInsightArtifactFile,
  );
  const progressStore = new GuideProgressStore(
    value.paths,
    artifacts,
    readBoundedInsightArtifactFile,
  );
  const progress = new GuideProgressService(
    progressStore,
    reader,
    value.operations,
  );
  const request = {
    ...key,
    model: "model",
    reasoning: "medium",
    language: "en",
  } as const;
  const first = must(await value.coordinator.start(request));
  await vi.waitFor(
    async () =>
      expect(
        must(await reader.current(profileId, value.review.id))?.runId,
      ).toBe(first.runId),
    { timeout: 10_000 },
  );
  const original = must(await reader.current(profileId, value.review.id));
  if (original === undefined) throw new Error("expected retained Guide");
  const originalPatchHash = createHash("sha256")
    .update(await readFile(value.session.patchPath))
    .digest("hex");
  expect(
    await new GuideCapturedFilePages().part(original, "f1", null),
  ).toMatchObject({ _tag: "ok" });
  must(
    await progress.mutate({
      ...key,
      digest: original.digest,
      expectedVersion: 0,
      mutation: {
        action: "set_expanded",
        groupId: v.parse(guideGroupIdSchema, "g1"),
        fileId: v.parse(guideFileIdSchema, "f1"),
        value: true,
      },
    }),
  );
  const priorProgress = await readFile(
    value.paths.guideProgressPointerFile(
      profileId,
      value.review.id,
      original.digest,
    ),
  );
  const priorSlot = must(await slots.read(profileId, value.review.id, "guide"));
  await writeFile(
    value.session.patchPath,
    "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -0,0 +1 @@\n+replacement\n",
  );
  const second = must(await value.coordinator.start(request));
  await vi.waitFor(
    () =>
      expect(
        value.resources?.ownership
          .forScope(value.paths.dataDirectory())
          .has(second.runId),
      ).toBe(false),
    { timeout: 10_000 },
  );
  const current = must(await reader.current(profileId, value.review.id));
  if (current === undefined)
    throw new Error("expected retained Guide after replacement");
  const file = await new GuideCapturedFilePages().part(current, "f1", null);
  console.log(
    JSON.stringify({
      replacementPublished: current.runId === second.runId,
      retainedOriginal: current.digest === original.digest,
      file,
    }),
  );
  expect(current.digest).toBe(original.digest);
  expect(current.rootReference).toEqual(original.rootReference);
  expect(file).toMatchObject({ _tag: "ok" });
  const afterSlot = must(await slots.read(profileId, value.review.id, "guide"));
  expect(afterSlot?.retained).toEqual(priorSlot?.retained);
  expect(afterSlot?.publication).toEqual(priorSlot?.publication);
  expect(
    await readFile(
      value.paths.guideProgressPointerFile(
        profileId,
        value.review.id,
        original.digest,
      ),
    ),
  ).toEqual(priorProgress);
  expect(must(await progress.describe(current))).toEqual({
    version: 1,
    anchor: { kind: "top" },
  });
  expect(
    must(await reader.summarySource(profileId, value.review.id)),
  ).toMatchObject({
    run: null,
    failure: { runId: second.runId, reason: "invalid_result" },
  });
}, 30_000);
