import { useState } from "react";

import { requestJson } from "../api-client";
import { NarrativeWalkthrough } from "./narrative-walkthrough";
import type { WorkbenchResponse } from "../renderer-contracts";

type WalkthroughProgressReaderProps = Omit<
  React.ComponentProps<typeof NarrativeWalkthrough>,
  "reviewedSectionIds" | "supportReviewed" | "currentSectionId" | "actions"
> & {
  readonly initialProgress: WorkbenchResponse["insights"]["walkthrough"]["progress"];
  readonly profileId: string;
  readonly reviewId: string;
  readonly runId: string | undefined;
};
export function WalkthroughProgressReader({
  initialProgress,
  profileId,
  reviewId,
  runId,
  ...props
}: WalkthroughProgressReaderProps): React.JSX.Element {
  const [reviewedSectionIds, setReviewedSectionIds] = useState<
    ReadonlyArray<string>
  >(initialProgress?.reviewedSectionIds ?? []);
  const [supportReviewed, setSupportReviewed] = useState(
    initialProgress?.supportReviewed ?? false,
  );
  const [currentSectionId, setCurrentSectionId] = useState<string | undefined>(
    initialProgress?.currentSectionId,
  );
  const [progressError, setProgressError] = useState(false);
  const save = (progress: {
    readonly reviewedSectionIds: ReadonlyArray<string>;
    readonly supportReviewed: boolean;
    readonly currentSectionId?: string;
  }): void => {
    if (runId === undefined) return;
    void requestJson("/v1/reviews/insights/walkthrough/progress", {
      method: "POST",
      body: { profileId, reviewId, runId, ...progress },
    })
      .then(() => setProgressError(false))
      .catch(() => setProgressError(true));
  };
  return (
    <>
      {progressError ? (
        <p role="alert" className="py-2 text-sm text-destructive">
          Walkthrough progress could not be saved.
        </p>
      ) : null}
      <NarrativeWalkthrough
        {...props}
        reviewedSectionIds={reviewedSectionIds}
        supportReviewed={supportReviewed}
        {...(currentSectionId === undefined ? {} : { currentSectionId })}
        actions={{
          onMarkSectionReviewed: (sectionId) => {
            const next = reviewedSectionIds.includes(sectionId)
              ? reviewedSectionIds
              : [...reviewedSectionIds, sectionId];
            setReviewedSectionIds(next);
            const saved = { reviewedSectionIds: next, supportReviewed };
            save(
              currentSectionId === undefined
                ? saved
                : { ...saved, currentSectionId },
            );
          },
          onMarkSupportReviewed: () => {
            setSupportReviewed(true);
            const saved = { reviewedSectionIds, supportReviewed: true };
            save(
              currentSectionId === undefined
                ? saved
                : { ...saved, currentSectionId },
            );
          },
          onSelectSection: (sectionId) => {
            setCurrentSectionId(sectionId);
            save({
              reviewedSectionIds,
              supportReviewed,
              currentSectionId: sectionId,
            });
          },
        }}
      />
    </>
  );
}
