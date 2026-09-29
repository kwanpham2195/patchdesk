import {
  INSIGHT_LANGUAGES,
  type InsightLanguage,
  type InsightProvider,
  type InsightReasoning,
} from "../../../domain/insight-provider";
import { INSIGHT_LANGUAGE_LABELS } from "../insight-contracts";

import type { ModelComboboxOption } from "./model-combobox";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

/** Shown wherever loading the Codex model list failed. */
const CODEX_MODELS_UNAVAILABLE =
  "Codex models unavailable. Check the Codex CLI login.";

export type InsightModelOption = {
  readonly id: string;
  readonly label: string;
  readonly reasoning?: ReadonlyArray<InsightReasoning>;
  readonly cost?: ModelComboboxOption["cost"];
};

export function InsightProviderSelect({
  id,
  ariaLabel,
  value,
  disabled,
  onValueChange,
}: {
  readonly id: string;
  readonly ariaLabel: string;
  readonly value: InsightProvider;
  readonly disabled: boolean;
  readonly onValueChange: (provider: InsightProvider) => void;
}): React.JSX.Element {
  return (
    <Select
      value={value}
      disabled={disabled}
      items={[
        { label: "API key", value: "pi" },
        { label: "Codex CLI account", value: "codex-cli-account" },
      ]}
      onValueChange={(next) => {
        if (next === "pi" || next === "codex-cli-account") onValueChange(next);
      }}
    >
      <SelectTrigger id={id} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="pi">API key</SelectItem>
          <SelectItem value="codex-cli-account">Codex CLI account</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** Codex models load only on an explicit action: Load Codex models first, then Refresh models. */
export function CodexModelsControl({
  loaded,
  loading,
  failed,
  disabled,
  onLoad,
}: {
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly disabled: boolean;
  readonly onLoad: () => void;
}): React.JSX.Element {
  const failure = failed ? (
    <Alert variant="destructive">
      <AlertDescription>{CODEX_MODELS_UNAVAILABLE}</AlertDescription>
    </Alert>
  ) : null;
  if (!loaded)
    return (
      <div className="grid gap-2 rounded-lg border border-dashed p-3 text-sm">
        <Button
          variant="outline"
          disabled={loading || disabled}
          onClick={onLoad}
        >
          {loading ? "Loading Codex models…" : "Load Codex models"}
        </Button>
        {failure}
      </div>
    );
  return (
    <div className="grid gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="justify-self-start"
        disabled={loading || disabled}
        onClick={onLoad}
      >
        {loading ? "Refreshing models…" : "Refresh models"}
      </Button>
      {failure}
    </div>
  );
}

export function InsightReasoningSelect({
  id,
  ariaLabel,
  options,
  value,
  disabled,
  onValueChange,
}: {
  readonly id: string;
  readonly ariaLabel: string;
  readonly options: ReadonlyArray<InsightReasoning>;
  readonly value: InsightReasoning;
  readonly disabled: boolean;
  readonly onValueChange: (reasoning: InsightReasoning) => void;
}): React.JSX.Element {
  return (
    <Select
      value={value}
      disabled={disabled}
      items={options.map((option) => ({ label: option, value: option }))}
      onValueChange={(next) => {
        const reasoning = options.find((option) => option === next);
        if (reasoning !== undefined) onValueChange(reasoning);
      }}
    >
      <SelectTrigger id={id} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function InsightLanguageSelect({
  id,
  ariaLabel,
  value,
  disabled,
  onValueChange,
}: {
  readonly id: string;
  readonly ariaLabel: string;
  readonly value: InsightLanguage;
  readonly disabled: boolean;
  readonly onValueChange: (language: InsightLanguage) => void;
}): React.JSX.Element {
  return (
    <Select
      value={value}
      disabled={disabled}
      items={INSIGHT_LANGUAGES.map((option) => ({
        label: INSIGHT_LANGUAGE_LABELS[option],
        value: option,
      }))}
      onValueChange={(next) => {
        const language = INSIGHT_LANGUAGES.find((option) => option === next);
        if (language !== undefined) onValueChange(language);
      }}
    >
      <SelectTrigger id={id} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {INSIGHT_LANGUAGES.map((option) => (
            <SelectItem key={option} value={option}>
              {INSIGHT_LANGUAGE_LABELS[option]}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** The chosen model's published list price, when the provider publishes one. */
export function ModelListPrice({
  models,
  model,
}: {
  readonly models: ReadonlyArray<InsightModelOption>;
  readonly model: string | null;
}): React.JSX.Element | null {
  const cost = models.find((candidate) => candidate.id === model)?.cost;
  if (cost === undefined) return null;
  return (
    <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
      {`List price $${cost.input.toFixed(2)} input / $${cost.output.toFixed(2)} output per million tokens; billing may differ.`}
    </p>
  );
}
