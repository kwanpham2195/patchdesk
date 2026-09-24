import { NarrativeWalkthrough } from "./narrative-walkthrough";
import { InlineError } from "./ui/inline-error";
import type { WalkthroughProgressControls } from "../hooks/use-walkthrough-progress";

type WalkthroughProgressReaderProps = Omit<
  React.ComponentProps<typeof NarrativeWalkthrough>,
  "reviewedSectionIds" | "supportReviewed" | "currentSectionId" | "actions"
> & {
  readonly controls: WalkthroughProgressControls;
};
export function WalkthroughProgressReader({
  controls,
  ...props
}: WalkthroughProgressReaderProps): React.JSX.Element {
  const { progress } = controls;
  return (
    <>
      {controls.saveFailed ? (
        <InlineError className="py-2">
          Walkthrough progress could not be saved.
        </InlineError>
      ) : null}
      <NarrativeWalkthrough
        {...props}
        reviewedSectionIds={progress.reviewedSectionIds}
        supportReviewed={progress.supportReviewed}
        {...(progress.currentSectionId === undefined
          ? {}
          : { currentSectionId: progress.currentSectionId })}
        actions={{
          onMarkSectionReviewed: controls.markSectionReviewed,
          onMarkSupportReviewed: controls.markSupportReviewed,
          onSelectSection: controls.selectSection,
        }}
      />
    </>
  );
}
