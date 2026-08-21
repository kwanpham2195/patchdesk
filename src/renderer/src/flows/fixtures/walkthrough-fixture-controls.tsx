import { NarrativeWalkthrough } from "../../components/narrative-walkthrough";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { ModelCombobox } from "../../components/model-combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { walkthroughFixturePatch } from "./workbench-fixture-data";

export function WalkthroughFixtureControls({
  lifecycle,
  dialogOpen,
  model,
  reasoning,
  walkthrough,
  actions,
  reviewedSectionIds,
  supportReviewed,
  open,
  openButtonRef,
}: {
  readonly lifecycle: "idle" | "generating" | "ready";
  readonly dialogOpen: boolean;
  readonly model: string | undefined;
  readonly reasoning: "low" | "medium" | "high";
  readonly walkthrough: Parameters<
    typeof NarrativeWalkthrough
  >[0]["walkthrough"];
  readonly actions: {
    readonly onOpenDialog: () => void;
    readonly onCloseDialog: () => void;
    readonly onModelChange: (value: string | null) => void;
    readonly onReasoningChange: (value: string | null) => void;
    readonly onConfirm: () => void;
    readonly onOpen: () => void;
    readonly onMarkSectionReviewed: (sectionId: string) => void;
    readonly onMarkSupportReviewed: () => void;
    readonly onSelectSection: (sectionId: string) => void;
  };
  readonly reviewedSectionIds: ReadonlyArray<string>;
  readonly supportReviewed: boolean;
  readonly open: boolean;
  readonly openButtonRef: React.RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
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
                onValueChange={actions.onReasoningChange}
              >
                <SelectTrigger
                  id="fixture-walkthrough-reasoning"
                  aria-label="Reasoning"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
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
          walkthrough={walkthrough}
          reviewedSectionIds={reviewedSectionIds}
          supportReviewed={supportReviewed}
          rawPatch={walkthroughFixturePatch}
          sourceSession={{ profileId: "fixture", sessionId: "fixture-session" }}
          actions={{
            onMarkSectionReviewed: actions.onMarkSectionReviewed,
            onMarkSupportReviewed: actions.onMarkSupportReviewed,
            onSelectSection: actions.onSelectSection,
          }}
        />
      ) : null}
    </div>
  );
}
