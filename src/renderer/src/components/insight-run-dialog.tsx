import type {
  InsightLanguage,
  InsightProvider,
  InsightReasoning,
} from "../../../domain/insight-provider";

import {
  CodexModelsControl,
  InsightLanguageSelect,
  InsightProviderSelect,
  InsightReasoningSelect,
  ModelListPrice,
  type InsightModelOption,
} from "./insight-run-option-controls";
import { modelReasoningOptions } from "../insight-run-options";
import { ModelCombobox } from "./model-combobox";
import { Button } from "./ui/button";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Spinner } from "./ui/spinner";

export type InsightRunDialogType = "analysis" | "walkthrough" | "brief";
/** The one spelling of each Insight type's name, for headings, buttons, and run copy. */
export const INSIGHT_NOUNS = {
  analysis: "Analysis",
  walkthrough: "Walkthrough",
  brief: "Brief",
} as const satisfies Record<InsightRunDialogType, string>;

/** Collects the provider choice and final disclosure before one Insight starts. */
export function InsightRunDialog({
  open,
  type,
  action,
  provider,
  models,
  model,
  reasoning,
  language,
  codexActivationPending,
  codexActivationError,
  pending,
  errorMessage,
  runsOnCombined = false,
  onOpenChange,
  onProviderChange,
  onActivateCodex,
  onRefreshCodexModels,
  onModelChange,
  onReasoningChange,
  onLanguageChange,
  onConfirm,
}: {
  readonly open: boolean;
  readonly type: InsightRunDialogType;
  readonly action: "run" | "retry" | "regenerate";
  readonly provider: InsightProvider;
  readonly models: ReadonlyArray<InsightModelOption>;
  readonly model: string | null;
  readonly reasoning: InsightReasoning;
  readonly language: InsightLanguage;
  readonly codexActivationPending: boolean;
  readonly codexActivationError: boolean;
  readonly pending: boolean;
  readonly errorMessage?: string;
  /** A shared local Review: the run reads its Combined patch whichever view the diff shows. */
  readonly runsOnCombined?: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onProviderChange: (provider: InsightProvider) => void;
  readonly onActivateCodex: () => void;
  readonly onRefreshCodexModels: () => void;
  readonly onModelChange: (model: string | null) => void;
  readonly onReasoningChange: (reasoning: InsightReasoning) => void;
  readonly onLanguageChange: (language: InsightLanguage) => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const noun = INSIGHT_NOUNS[type];
  const actionLabel =
    action === "regenerate"
      ? `Regenerate ${noun}`
      : action === "retry"
        ? `Run ${noun} again`
        : `Run ${noun}`;
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!pending) onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        data-testid="insight-run-dialog"
        showCloseButton={!pending}
      >
        <DialogHeader>
          <DialogTitle>{actionLabel}</DialogTitle>
          <DialogDescription>
            {noun} for this revision.
            {runsOnCombined ? " It runs on the Combined view." : null}
          </DialogDescription>
        </DialogHeader>
        {errorMessage === undefined ? null : (
          <Alert variant="destructive">
            <AlertTitle>Insight run did not start.</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-4">
          <label
            className="grid gap-1.5 text-sm font-medium"
            htmlFor="insight-run-provider"
          >
            Provider
            <InsightProviderSelect
              id="insight-run-provider"
              ariaLabel="Insight provider"
              value={provider}
              disabled={pending}
              onValueChange={onProviderChange}
            />
          </label>
          {provider === "codex-cli-account" ? (
            <CodexModelsControl
              loaded={models.length > 0}
              loading={codexActivationPending}
              failed={codexActivationError}
              disabled={pending}
              onLoad={
                models.length > 0 ? onRefreshCodexModels : onActivateCodex
              }
            />
          ) : null}
          <label
            className="grid gap-1.5 text-sm font-medium"
            htmlFor="insight-run-model"
          >
            Model
            <ModelCombobox
              id="insight-run-model"
              ariaLabel="Insight model"
              options={models}
              value={model}
              onValueChange={onModelChange}
              disabled={pending}
            />
          </label>
          <div className="flex flex-wrap gap-4">
            <label
              className="grid gap-1.5 text-sm font-medium"
              htmlFor="insight-run-reasoning"
            >
              Reasoning
              <InsightReasoningSelect
                id="insight-run-reasoning"
                ariaLabel="Insight reasoning"
                options={modelReasoningOptions(models, model)}
                value={reasoning}
                disabled={pending}
                onValueChange={onReasoningChange}
              />
            </label>
            <label
              className="grid gap-1.5 text-sm font-medium"
              htmlFor="insight-run-language"
            >
              Language
              <InsightLanguageSelect
                id="insight-run-language"
                ariaLabel="Insight language"
                value={language}
                disabled={pending}
                onValueChange={onLanguageChange}
              />
            </label>
          </div>
          <ModelListPrice models={models} model={model} />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            data-testid="insight-run-confirm"
            disabled={
              pending ||
              model === null ||
              (provider === "codex-cli-account" && models.length === 0)
            }
            onClick={onConfirm}
          >
            {pending ? (
              <>
                <Spinner data-icon="inline-start" aria-hidden="true" />
                Starting…
              </>
            ) : (
              "Start run"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
