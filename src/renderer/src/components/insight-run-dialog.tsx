import type {
  InsightProvider,
  InsightReasoning,
} from "../../../domain/insight-provider";

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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Spinner } from "./ui/spinner";

export type InsightRunDialogType = "analysis" | "walkthrough" | "brief";
/** The one spelling of each Insight type's name, for headings, buttons, and run copy. */
export const INSIGHT_NOUNS = {
  analysis: "Analysis",
  walkthrough: "Walkthrough",
  brief: "Brief",
} as const satisfies Record<InsightRunDialogType, string>;
export type InsightModelOption = {
  readonly id: string;
  readonly label: string;
  readonly reasoning?: ReadonlyArray<InsightReasoning>;
};

/** Collects the provider choice and final disclosure before one Insight starts. */
export function InsightRunDialog({
  open,
  type,
  action,
  provider,
  models,
  model,
  reasoning,
  codexActivationPending,
  codexActivationError,
  pending,
  errorMessage,
  onOpenChange,
  onProviderChange,
  onActivateCodex,
  onRefreshCodexModels,
  onModelChange,
  onReasoningChange,
  onConfirm,
}: {
  readonly open: boolean;
  readonly type: InsightRunDialogType;
  readonly action: "run" | "retry" | "regenerate";
  readonly provider: InsightProvider;
  readonly models: ReadonlyArray<InsightModelOption>;
  readonly model: string | null;
  readonly reasoning: InsightReasoning;
  readonly codexActivationPending: boolean;
  readonly codexActivationError: boolean;
  readonly pending: boolean;
  readonly errorMessage?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onProviderChange: (provider: InsightProvider) => void;
  readonly onActivateCodex: () => void;
  readonly onRefreshCodexModels: () => void;
  readonly onModelChange: (model: string | null) => void;
  readonly onReasoningChange: (reasoning: InsightReasoning) => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const noun = INSIGHT_NOUNS[type];
  const actionLabel =
    action === "regenerate"
      ? `Regenerate ${noun}`
      : action === "retry"
        ? `Run ${noun} again`
        : `Run ${noun}`;
  const selectedModel = models.find((candidate) => candidate.id === model);
  const reasoningOptions = selectedModel?.reasoning ?? [
    "low",
    "medium",
    "high",
  ];
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
            Choose the provider, model, and reasoning effort before starting
            this bounded {noun} run.
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
            <Select
              value={provider}
              disabled={pending}
              items={[
                { label: "Pi", value: "pi" },
                { label: "Codex CLI account", value: "codex-cli-account" },
              ]}
              onValueChange={(value) => {
                if (value === "pi" || value === "codex-cli-account")
                  onProviderChange(value);
              }}
            >
              <SelectTrigger
                id="insight-run-provider"
                aria-label="Insight provider"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="pi">Pi</SelectItem>
                  <SelectItem value="codex-cli-account">
                    Codex CLI account
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
          {provider === "codex-cli-account" && models.length === 0 ? (
            <div className="grid gap-2 rounded-lg border border-dashed p-3 text-sm">
              <p>Codex models are loaded only after this explicit action.</p>
              <Button
                variant="outline"
                disabled={codexActivationPending || pending}
                onClick={onActivateCodex}
              >
                {codexActivationPending
                  ? "Loading Codex models…"
                  : "Load Codex models"}
              </Button>
              {codexActivationError ? (
                <Alert variant="destructive">
                  <AlertTitle>Codex models are unavailable.</AlertTitle>
                  <AlertDescription>
                    Check external login and the app launch PATH.
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
          ) : null}
          {provider === "codex-cli-account" && models.length > 0 ? (
            <div className="grid gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="justify-self-start"
                disabled={codexActivationPending || pending}
                onClick={onRefreshCodexModels}
              >
                {codexActivationPending
                  ? "Refreshing models…"
                  : "Refresh models"}
              </Button>
              {codexActivationError ? (
                <Alert variant="destructive">
                  <AlertTitle>Codex models are unavailable.</AlertTitle>
                  <AlertDescription>
                    Check external login and the app launch PATH.
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
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
          <label
            className="grid gap-1.5 text-sm font-medium"
            htmlFor="insight-run-reasoning"
          >
            Reasoning
            <Select
              value={reasoning}
              disabled={pending}
              items={reasoningOptions.map((option) => ({
                label: option,
                value: option,
              }))}
              onValueChange={(value) => {
                const nextReasoning = reasoningOptions.find(
                  (option) => option === value,
                );
                if (nextReasoning !== undefined)
                  onReasoningChange(nextReasoning);
              }}
            >
              <SelectTrigger
                id="insight-run-reasoning"
                aria-label="Insight reasoning"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {reasoningOptions.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
          <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
            Confirmation: {provider === "pi" ? "Pi" : "Codex CLI account"} using{" "}
            {selectedModel?.label ?? model ?? "no model"} with {reasoning}{" "}
            reasoning will receive the prepared pull-request artifacts
            {provider === "codex-cli-account"
              ? " and may inspect the immutable represented-review worktree with read-only tools"
              : ""}
            . Patchdesk retains all validation, Finding, publication, and merge
            authority.
          </p>
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
