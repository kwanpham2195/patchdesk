import { parseRetainedGuide } from "#src/domain/guide";
import {
  initialGuideReadingState,
  validateGuideReadingContent,
  type GuideReadingContent,
  type GuideReadingState,
} from "#src/domain/guide-reading-state";
import type { InsightReadingIdentity } from "#src/domain/insight-record";
import type { IsoTimestamp, ReviewSessionId } from "#src/domain/ids";
import { err, ok, type Result } from "#src/domain/result";
import type { InsightStore } from "#src/adapters/storage/insight-store";
import type { InsightCoordinatorFailure } from "./insight-run-coordinator";
import { hashReviewArtifactContent } from "./review-artifact-hash";

/** The client supplies a compare-and-save version and the represented Guide session. */
export type GuideReadingStateInput = InsightReadingIdentity & {
  readonly sessionId: ReviewSessionId;
  readonly expectedStateVersion: number;
  readonly state: GuideReadingContent;
};
/** Conflicts never authorize an automatic overwrite of newer persisted progress. */
export type GuideReadingStateFailure =
  | InsightCoordinatorFailure
  | "guide_identity_conflict"
  | "guide_version_conflict"
  | "invalid_reading_state";

/** Called only inside the coordinator's Review lock; comparison and save share the store mutation. */
export async function saveGuideReadingState(
  insights: InsightStore,
  input: GuideReadingStateInput,
  now: IsoTimestamp,
  admit: () => Promise<Result<void, InsightCoordinatorFailure>>,
): Promise<Result<GuideReadingState, GuideReadingStateFailure>> {
  const admission = await admit();
  if (admission._tag === "err") return admission;
  const changed = await insights.mutate({
    profileId: input.profileId,
    reviewId: input.reviewId,
    type: "guide",
    now,
    corruptRecordPolicy: "reject",
    operation: (record) => {
      const retained = record.retained;
      if (
        retained === undefined ||
        retained.runId !== input.runId ||
        retained.revision.sessionId !== input.sessionId
      )
        return err("guide_identity_conflict");
      const guide = parseRetainedGuide(retained.value);
      if (
        guide._tag === "err" ||
        hashReviewArtifactContent(guide.value.patchText) !==
          retained.revision.patchHash
      )
        return err("invalid_reading_state");
      const current =
        record.guideReadingState ??
        initialGuideReadingState({ ...retained, value: guide.value });
      if (current.version !== input.expectedStateVersion)
        return err("guide_version_conflict");
      const content = validateGuideReadingContent(input.state, guide.value);
      if (content._tag === "err" || !Number.isSafeInteger(current.version + 1))
        return err("invalid_reading_state");
      return ok({
        ...record,
        guideReadingState: {
          ...content.value,
          runId: input.runId,
          sessionId: input.sessionId,
          version: current.version + 1,
        },
        updatedAt: now,
      });
    },
  });
  if (changed._tag === "err") {
    switch (changed.error) {
      case "guide_identity_conflict":
      case "guide_version_conflict":
      case "invalid_reading_state":
        return err(changed.error);
      default:
        return err("storage_unavailable");
    }
  }
  return changed.value.guideReadingState === undefined
    ? err("storage_unavailable")
    : ok(changed.value.guideReadingState);
}
