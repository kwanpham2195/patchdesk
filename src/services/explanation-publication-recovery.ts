import { readdir } from "node:fs/promises";

import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import type { InsightRunJournalReader } from "#src/adapters/storage/insight-run-journal-reader";
import type { InsightSlotStore } from "#src/adapters/storage/insight-slot-store";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import {
  guidePublicationCodec,
  guideRuntimeCodec,
} from "#src/domain/guide-result";
import { ok, type Result } from "#src/domain/result";
import { encodeInsightArtifactCanonicalJson } from "#src/domain/insight-artifact-scalars";
import {
  walkthroughPublicationCodec,
  walkthroughRuntimeCodec,
} from "#src/domain/walkthrough-result";
import type { ExplanationRunTransactions } from "./explanation-run-transactions";
import type {
  InsightRunRef,
  InsightSlotFailure,
  InsightSlotKey,
} from "./insight-slot-records";

/**
 * A publication commits when the slot pointer names `{generated, root}` and `GuidePublication1` together; the slot then
 * no longer names the run, so ordinary recovery (which starts from the active run) cannot find a journal whose
 * completion write was lost. This finds that journal by the publication's run identity and, only when its validated
 * runtime names the same result, generation and cancel epoch, records the completion. It never dispatches, never turns
 * the success into a failure and never touches the retained pointer.
 */
export async function reconcilePublishedExplanation(
  deps: {
    readonly paths: PatchdeskPaths;
    readonly artifacts: InsightArtifactStore;
    readonly slots: InsightSlotStore;
    readonly journals: InsightRunJournalReader;
    readonly explanation: Pick<ExplanationRunTransactions, "recordPublication">;
  },
  key: InsightSlotKey,
): Promise<Result<void, InsightSlotFailure>> {
  if (key.type !== "guide" && key.type !== "walkthrough") return ok(undefined);
  const slot = await deps.slots.read(key.profileId, key.reviewId, key.type);
  if (slot._tag === "err") return { _tag: "err", error: "storage_unavailable" };
  if (
    slot.value === undefined ||
    slot.value.publication === null ||
    slot.value.retained?.tag !== "generated"
  )
    return ok(undefined);
  const publication =
    key.type === "guide"
      ? await deps.artifacts.readObject(
          key.profileId,
          key.reviewId,
          guidePublicationCodec,
          slot.value.publication,
        )
      : await deps.artifacts.readObject(
          key.profileId,
          key.reviewId,
          walkthroughPublicationCodec,
          slot.value.publication,
        );
  if (publication._tag === "err")
    return { _tag: "err", error: "storage_unavailable" };
  if (
    encodeInsightArtifactCanonicalJson(publication.value.result) !==
    encodeInsightArtifactCanonicalJson(slot.value.retained.root)
  )
    return { _tag: "err", error: "storage_unavailable" };
  let names: string[];
  try {
    names = await readdir(
      deps.paths.insightJournalsDirectory(key.profileId, key.reviewId),
    );
  } catch {
    return ok(undefined);
  }
  for (const name of names) {
    if (
      !deps.paths.isInsightJournalEntryName(name) ||
      name.endsWith(".intent.json")
    )
      continue;
    const journalId = name.slice(0, -".json".length);
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- one small journal pointer per run
    const journal = await deps.journals.read({
      profileId: key.profileId,
      reviewId: key.reviewId,
      journalId,
      runId: publication.value.runId,
    });
    // A journal of another run fails the run-identity check of its pointer and is not this publication's.
    if (journal._tag === "err") continue;
    const { state } = journal.value;
    const runtimeReference =
      key.type === "guide" ? state.guideRuntime : state.walkthroughRuntime;
    if (state.status !== "running" || runtimeReference === undefined)
      return ok(undefined);
    const runtime =
      key.type === "guide"
        ? await deps.artifacts.readObject(
            key.profileId,
            key.reviewId,
            guideRuntimeCodec,
            runtimeReference,
          )
        : await deps.artifacts.readObject(
            key.profileId,
            key.reviewId,
            walkthroughRuntimeCodec,
            runtimeReference,
          );
    if (
      runtime._tag !== "ok" ||
      runtime.value.phase !== "validated" ||
      runtime.value.result?.hash !== publication.value.result.hash ||
      runtime.value.result?.bytes !== publication.value.result.bytes ||
      runtime.value.frozen?.sequence !== publication.value.frozenSequence ||
      encodeInsightArtifactCanonicalJson(
        runtime.value.frozen?.receipts ?? null,
      ) !== encodeInsightArtifactCanonicalJson(publication.value.receipts) ||
      state.generation !== publication.value.generation ||
      state.cancelEpoch !== publication.value.cancelEpoch
    )
      return ok(undefined);
    const run: InsightRunRef = {
      ...key,
      runId: publication.value.runId,
      journalId,
    };
    const completed = await deps.explanation.recordPublication(
      run,
      slot.value.publication,
    );
    return completed._tag === "ok" ? ok(undefined) : completed;
  }
  return ok(undefined);
}
