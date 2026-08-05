import { ModelCombobox } from "./model-combobox";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

export type InsightRunDialogType = "analysis" | "walkthrough";
export type InsightReasoning = "low" | "medium" | "high";
export type InsightModelOption = { readonly id: string; readonly label: string };
export type InsightCompletionOption = {
  readonly value: string;
  readonly label: string;
};

export function InsightRunDialog({
  open,
  type,
  action,
  models,
  model,
  reasoning,
  completion,
  completionOptions,
  onOpenChange,
  onModelChange,
  onReasoningChange,
  onCompletionChange,
  onConfirm,
}: {
  readonly open: boolean;
  readonly type: InsightRunDialogType;
  readonly action: "run" | "retry" | "regenerate";
  readonly models: ReadonlyArray<InsightModelOption>;
  readonly model: string | null;
  readonly reasoning: InsightReasoning;
  readonly completion?: string;
  readonly completionOptions?: ReadonlyArray<InsightCompletionOption>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onModelChange: (model: string | null) => void;
  readonly onReasoningChange: (reasoning: InsightReasoning) => void;
  readonly onCompletionChange?: (completion: string) => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const noun = type === "analysis" ? "Analysis" : "Walkthrough";
  const actionLabel = action === "regenerate" ? `Regenerate ${noun}` : action === "retry" ? `Run ${noun} again` : `Run ${noun}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="insight-run-dialog">
        <DialogHeader>
          <DialogTitle>{actionLabel}</DialogTitle>
          <DialogDescription>Choose the model and reasoning effort before starting this bounded {noun} run.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <label className="grid gap-1.5 text-sm font-medium" htmlFor="insight-run-model">
            Model
            <ModelCombobox
              id="insight-run-model"
              ariaLabel="Insight model"
              options={models}
              value={model}
              onValueChange={onModelChange}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium" htmlFor="insight-run-reasoning">
            Reasoning
            <select id="insight-run-reasoning" aria-label="Insight reasoning" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" value={reasoning} onChange={(event) => onReasoningChange(event.target.value as InsightReasoning)}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          {type === "analysis" && completion !== undefined && completionOptions !== undefined && onCompletionChange !== undefined ? (
            <label className="grid gap-1.5 text-sm font-medium" htmlFor="insight-run-completion">
              Completion
              <select id="insight-run-completion" aria-label="Analysis completion" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" value={completion} onChange={(event) => onCompletionChange(event.target.value)}>
                {completionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button data-testid="insight-run-confirm" disabled={model === null} onClick={onConfirm}>Start run</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
