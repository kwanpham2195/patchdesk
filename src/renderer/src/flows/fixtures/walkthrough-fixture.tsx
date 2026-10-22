import { useRef, useState } from "react";
import { CanonicalFixtureWorkbench } from "./canonical-fixture-workbench";
import type { NavigationState } from "./navigation-state";
import { WalkthroughFixtureControls } from "./walkthrough-fixture-controls";
import {
  walkthroughFixturePatch,
  workbenchFixtureData,
} from "./workbench-fixture-data";
import type { WalkthroughPage } from "#src/domain/walkthrough-progress";

const sections: ReadonlyArray<Extract<WalkthroughPage, { kind: "section" }>> = [
  {
    kind: "section",
    sectionId: "s1",
    ordinal: 0,
    title: "Keep the review local",
    prose:
      "This fixture proves a manual walkthrough without starting an Analysis run.",
    chapter: { id: "c1", title: "Read first" },
    citationCount: 1,
    previous: null,
    next: "s2",
    reviewed: false,
    navigationCursor: null,
  },
  {
    kind: "section",
    sectionId: "s2",
    ordinal: 1,
    title: "Follow the changed path",
    prose:
      "The chapter rail keeps the next section available without leaving the saved Files surface.",
    chapter: { id: "c1", title: "Read first" },
    citationCount: 1,
    previous: "s1",
    next: null,
    reviewed: false,
    navigationCursor: null,
  },
];

/** The existing browser journey uses small page-shaped fixtures without a provider. */
export function WalkthroughFixture({
  onNavigationStateChange,
}: {
  readonly onNavigationStateChange: (state: NavigationState) => void;
}): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [lifecycle, setLifecycle] = useState<"idle" | "generating" | "ready">(
    "idle",
  );
  const [model, setModel] = useState<string>();
  const [reasoning, setReasoning] = useState<"low" | "medium" | "high">(
    "medium",
  );
  const [generateRequests, setGenerateRequests] = useState(0);
  const [open, setOpen] = useState(false);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const [reviewedSectionIds, setReviewedSectionIds] = useState<
    ReadonlyArray<string>
  >([]);
  return (
    <div data-walkthrough-generate-requests={generateRequests}>
      <WalkthroughFixtureControls
        lifecycle={lifecycle}
        dialogOpen={dialogOpen}
        model={model}
        reasoning={reasoning}
        sections={sections}
        reviewedSectionIds={reviewedSectionIds}
        open={open}
        openButtonRef={openButtonRef}
        actions={{
          onOpenDialog: () => setDialogOpen(true),
          onCloseDialog: () => setDialogOpen(false),
          onModelChange: (value) => {
            if (value !== null) setModel(value);
          },
          onReasoningChange: (value) => {
            if (value === "low" || value === "medium" || value === "high")
              setReasoning(value);
          },
          onConfirm: () => {
            setDialogOpen(false);
            setGenerateRequests((value) => value + 1);
            setLifecycle("generating");
            window.setTimeout(() => setLifecycle("ready"), 50);
          },
          onOpen: () => setOpen(true),
          onToggleSectionReviewed: (id) =>
            setReviewedSectionIds((current) =>
              current.includes(id)
                ? current.filter((item) => item !== id)
                : [...current, id],
            ),
        }}
      />
      <CanonicalFixtureWorkbench
        data={{ ...workbenchFixtureData, fullPatch: walkthroughFixturePatch }}
        onNavigationStateChange={onNavigationStateChange}
      />
    </div>
  );
}
