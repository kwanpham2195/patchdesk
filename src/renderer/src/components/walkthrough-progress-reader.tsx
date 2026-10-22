import { definedProps } from "#src/domain/defined-props";
import { NarrativeWalkthrough } from "./narrative-walkthrough";
import { InlineError } from "./ui/inline-error";
import type { WalkthroughProgressControls } from "#src/renderer/src/hooks/use-walkthrough-progress";

type WalkthroughProgressReaderProps = Omit<
  React.ComponentProps<typeof NarrativeWalkthrough>,
  "actions"
> & {
  readonly controls: WalkthroughProgressControls;
};
export function WalkthroughProgressReader({
  controls,
  ...props
}: WalkthroughProgressReaderProps): React.JSX.Element {
  const reviewed = new Set(controls.progress.reviewedSectionIds);
  return (
    <>
      {controls.saveFailed ? (
        <InlineError className="py-2">
          Walkthrough progress could not be saved.
        </InlineError>
      ) : null}
      <NarrativeWalkthrough
        {...props}
        counts={{ ...props.counts, reviewed: controls.progress.reviewedCount }}
        navigation={{
          ...props.navigation,
          items: props.navigation.items.map((item) => ({
            ...item,
            reviewed: reviewed.has(item.sectionId),
          })),
        }}
        activeSection={
          props.activeSection === null
            ? null
            : {
                ...props.activeSection,
                reviewed: reviewed.has(props.activeSection.sectionId),
              }
        }
        actions={{
          ...definedProps({
            onToggleSectionReviewed: controls.toggleSectionReviewed,
          }),
          onSelectSection: controls.selectSection,
        }}
      />
    </>
  );
}
