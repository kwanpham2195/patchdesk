import { NarrativeWalkthrough } from "#src/renderer/src/components/narrative-walkthrough";
import { useState } from "react";
import type { WalkthroughPage } from "#src/domain/walkthrough-progress";
import { NarrativeWalkthroughDiff } from "#src/renderer/src/components/narrative-walkthrough-diff";
import { Button } from "#src/renderer/src/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#src/renderer/src/components/ui/dialog";
import { ModelCombobox } from "#src/renderer/src/components/model-combobox";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#src/renderer/src/components/ui/select";

export function WalkthroughFixtureControls({
  lifecycle,
  dialogOpen,
  model,
  reasoning,
  sections,
  actions,
  reviewedSectionIds,
  open,
  openButtonRef,
}: {
  readonly lifecycle: "idle" | "generating" | "ready";
  readonly dialogOpen: boolean;
  readonly model: string | undefined;
  readonly reasoning: "low" | "medium" | "high";
  readonly sections: ReadonlyArray<
    Extract<WalkthroughPage, { kind: "section" }>
  >;
  readonly actions: {
    readonly onOpenDialog: () => void;
    readonly onCloseDialog: () => void;
    readonly onModelChange: (value: string | null) => void;
    readonly onReasoningChange: (value: string | null) => void;
    readonly onConfirm: () => void;
    readonly onOpen: () => void;
    readonly onToggleSectionReviewed: (sectionId: string) => void;
  };
  readonly reviewedSectionIds: ReadonlyArray<string>;
  readonly open: boolean;
  readonly openButtonRef: React.RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  const [selected, setSelected] = useState("s1");
  const active =
    sections.find((section) => section.sectionId === selected) ?? null;
  const path = selected === "s1" ? "src/a.ts" : "src/b.ts";
  const lineCount = selected === "s1" ? 48 : 1;
  const header = `@@ -1,${lineCount} +1,${lineCount} @@`;
  const raw = `${header}\n${Array.from({ length: lineCount }, (_, index) => `-old-${index + 1}\n+new-${index + 1}`).join("\n")}`;
  return (
    <div className="border-b p-4">
      {lifecycle === "ready" && !open ? (
        <Button ref={openButtonRef} onClick={actions.onOpen}>
          Open walkthrough
        </Button>
      ) : null}
      {lifecycle !== "ready" ? (
        <Button
          onClick={actions.onOpenDialog}
          disabled={lifecycle === "generating"}
        >
          {lifecycle === "generating"
            ? "Generating walkthrough…"
            : "Generate walkthrough"}
        </Button>
      ) : null}
      <Dialog
        open={dialogOpen}
        onOpenChange={(next) =>
          next ? actions.onOpenDialog() : actions.onCloseDialog()
        }
      >
        <DialogContent data-testid="walkthrough-generate-dialog">
          <DialogHeader>
            <DialogTitle>Generate walkthrough</DialogTitle>
            <DialogDescription>
              Choose how Patchdesk should explain this Review.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label
              className="grid gap-1.5 text-sm font-medium"
              htmlFor="fixture-walkthrough-model"
            >
              Model
              <ModelCombobox
                id="fixture-walkthrough-model"
                ariaLabel="Model"
                options={[{ id: "pi-design", label: "Design model" }]}
                value={model ?? null}
                onValueChange={actions.onModelChange}
              />
            </label>
            <label
              className="grid gap-1.5 text-sm font-medium"
              htmlFor="fixture-walkthrough-reasoning"
            >
              Reasoning
              <Select
                value={reasoning}
                items={[
                  { label: "Low", value: "low" },
                  { label: "Medium", value: "medium" },
                  { label: "High", value: "high" },
                ]}
                onValueChange={actions.onReasoningChange}
              >
                <SelectTrigger
                  id="fixture-walkthrough-reasoning"
                  aria-label="Reasoning"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={actions.onCloseDialog}>
              Cancel
            </Button>
            <Button
              data-testid="walkthrough-confirm"
              disabled={model === undefined}
              onClick={actions.onConfirm}
            >
              Generate walkthrough
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {open ? (
        <NarrativeWalkthrough
          counts={{
            sections: 2,
            reviewed: reviewedSectionIds.length,
            citedHunks: 2,
            hunks: 3,
            uncited: 1,
          }}
          navigation={{
            kind: "navigation",
            items: sections.map((section) => ({
              ...section,
              reviewed: reviewedSectionIds.includes(section.sectionId),
            })),
            next: null,
            previous: null,
          }}
          activeSection={
            active === null
              ? null
              : {
                  ...active,
                  reviewed: reviewedSectionIds.includes(active.sectionId),
                }
          }
          onNavigationPage={() => undefined}
          evidence={
            <NarrativeWalkthroughDiff
              blockId={`${selected}::${selected === "s1" ? "h1" : "h2"}`}
              hunk={{
                id: selected === "s1" ? "h1" : "h2",
                path,
                filePrefix: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}`,
                header,
                raw,
                oldStart: 1,
                oldLines: lineCount,
                newStart: 1,
                newLines: lineCount,
              }}
            />
          }
          actions={{
            onToggleSectionReviewed: actions.onToggleSectionReviewed,
            onSelectSection: setSelected,
          }}
        />
      ) : null}
    </div>
  );
}
