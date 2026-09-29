import {
  INSIGHT_LANGUAGES,
  INSIGHT_PROVIDERS,
  type AccountInsightProvider,
  type InsightLanguage,
  type InsightProvider,
  type InsightReasoning,
} from "../../../domain/insight-provider";
import {
  INSIGHT_LANGUAGE_LABELS,
  INSIGHT_PROVIDER_LABELS,
} from "../insight-contracts";
import type { AccountModelsFailure } from "../hooks/use-insight-configuration";

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

/** How each account provider's Load models control names its CLI and login. */
const ACCOUNT_MODELS_COPY = {
  "codex-cli-account": {
    load: "Load Codex models",
    loading: "Loading Codex models…",
    unavailable: "Codex models unavailable. Check the Codex CLI login.",
  },
  "pi-cli-account": {
    load: "Load pi models",
    loading: "Loading pi models…",
    unavailable: "pi models unavailable. Check the pi login.",
  },
} as const satisfies Record<
  AccountInsightProvider,
  {
    readonly load: string;
    readonly loading: string;
    readonly unavailable: string;
  }
>;

function accountModelsFailureMessage(failure: AccountModelsFailure): string {
  return failure.requiredVersion === undefined
    ? ACCOUNT_MODELS_COPY[failure.provider].unavailable
    : `pi models unavailable. Patchdesk needs pi ${failure.requiredVersion} or later.`;
}

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
      items={INSIGHT_PROVIDERS.map((option) => ({
        label: INSIGHT_PROVIDER_LABELS[option],
        value: option,
      }))}
      onValueChange={(next) => {
        const provider = INSIGHT_PROVIDERS.find((option) => option === next);
        if (provider !== undefined) onValueChange(provider);
      }}
    >
      <SelectTrigger id={id} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {INSIGHT_PROVIDERS.map((option) => (
            <SelectItem key={option} value={option}>
              {INSIGHT_PROVIDER_LABELS[option]}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** An account provider's models load only on an explicit action: Load models first, then Refresh models. */
export function AccountModelsControl({
  provider,
  loaded,
  pending,
  failure,
  disabled,
  onLoad,
}: {
  readonly provider: AccountInsightProvider;
  readonly loaded: boolean;
  /** The account provider whose load is in flight; another provider's load disables this one. */
  readonly pending: AccountInsightProvider | null;
  readonly failure: AccountModelsFailure | null;
  readonly disabled: boolean;
  readonly onLoad: () => void;
}): React.JSX.Element {
  const copy = ACCOUNT_MODELS_COPY[provider];
  const loading = pending === provider;
  const failureAlert =
    failure?.provider === provider ? (
      <Alert variant="destructive">
        <AlertDescription>
          {accountModelsFailureMessage(failure)}
        </AlertDescription>
      </Alert>
    ) : null;
  if (!loaded)
    return (
      <div className="grid gap-2 rounded-lg border border-dashed p-3 text-sm">
        <Button
          variant="outline"
          disabled={pending !== null || disabled}
          onClick={onLoad}
        >
          {loading ? copy.loading : copy.load}
        </Button>
        {failureAlert}
      </div>
    );
  return (
    <div className="grid gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="justify-self-start"
        disabled={pending !== null || disabled}
        onClick={onLoad}
      >
        {loading ? "Refreshing models…" : "Refresh models"}
      </Button>
      {failureAlert}
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
