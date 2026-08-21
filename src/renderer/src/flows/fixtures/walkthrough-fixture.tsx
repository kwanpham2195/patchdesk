import { useMemo, useRef, useState } from "react";
import { CanonicalFixtureWorkbench } from "./canonical-fixture-workbench";
import type { NavigationState } from "./navigation-state";
import { WalkthroughFixtureControls } from "./walkthrough-fixture-controls";
import { walkthroughFixturePatch, workbenchFixtureData } from "./workbench-fixture-data";

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
  const [supportReviewed, setSupportReviewed] = useState(false);
  const walkthrough = useMemo(
    () => ({
      snapshot: {
        profileId: "fixture",
        sessionId: "fixture-session",
        headSha: "abcdef1234567890abcdef1234567890abcdef12",
        patchHash: "b".repeat(64),
      },
      citationStatus: "verified" as const,
      title: "Walkthrough fixture",
      focus: "The focused review path remains separate from Files mode.",
      chapters: [
        {
          id: "chapter-1",
          title: "Read first",
          sections: [
            {
              id: "section-1",
              title: "Keep the review local",
              prose:
                "This fixture proves a manual walkthrough without starting an Analysis run.",
              hunkIds: ["h1"],
              hunks: [
                {
                  id: "h1",
                  path: "src/a.ts",
                  header: "@@ -1 +1 @@",
                  raw: "@@ -1 +1 @@\\n-old\\n+new",
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                },
              ],
            },
            {
              id: "section-2",
              title: "Follow the changed path",
              prose:
                "The chapter rail keeps the next section available without leaving the saved Files surface.",
              hunkIds: ["h2"],
              hunks: [
                {
                  id: "h2",
                  path: "src/b.ts",
                  header: "@@ -1 +1 @@",
                  raw: "@@ -1 +1 @@\\n-old\\n+new",
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                },
              ],
            },
          ],
        },
      ],
      support: {
        id: "support" as const,
        title: "Support" as const,
        hunkIds: ["h3"],
        hunks: [
          {
            id: "h3",
            path: "src/c.ts",
            header: "@@ -1 +1 @@",
            raw: "@@ -1 +1 @@\\n-old\\n+new",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
          },
        ],
      },
    }),
    [],
  );
  const confirmGeneration = (): void => {
    setDialogOpen(false);
    setGenerateRequests((current) => current + 1);
    setLifecycle("generating");
    window.setTimeout(() => setLifecycle("ready"), 50);
  };
  const markSectionReviewed = (sectionId: string): void => {
    setReviewedSectionIds((current) =>
      current.includes(sectionId) ? current : [...current, sectionId],
    );
  };
  return (
    <div data-walkthrough-generate-requests={generateRequests}>
      <WalkthroughFixtureControls
        lifecycle={lifecycle}
        dialogOpen={dialogOpen}
        model={model}
        reasoning={reasoning}
        walkthrough={walkthrough}
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
          onConfirm: confirmGeneration,
          onOpen: () => {
            setOpen(true);
          },
          onMarkSectionReviewed: markSectionReviewed,
          onMarkSupportReviewed: () => setSupportReviewed(true),
          onSelectSection: () => undefined,
        }}
        reviewedSectionIds={reviewedSectionIds}
        supportReviewed={supportReviewed}
        open={open}
        openButtonRef={openButtonRef}
      />
      <CanonicalFixtureWorkbench
        data={{ ...workbenchFixtureData, fullPatch: walkthroughFixturePatch }}
        onNavigationStateChange={onNavigationStateChange}
      />
    </div>
  );
}
