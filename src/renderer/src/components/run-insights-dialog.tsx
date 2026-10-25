import {
  RUN_INSIGHTS_ORDER,
  type RunInsightsDialogController,
  type RunInsightsRow,
} from "#src/renderer/src/hooks/use-run-insights-dialog";
import type { InsightRunType } from "#src/renderer/src/hooks/use-insight-run";
import { INSIGHT_NOUNS } from "./insight-run-dialog";
import {
  AccountModelsControl,
  InsightLanguageSelect,
  InsightProviderSelect,
  InsightReasoningSelect,
  ModelListPrice,
} from "./insight-run-option-controls";
import { modelReasoningOptions } from "#src/renderer/src/insight-run-options";
import { supportedInsightProviders } from "#src/domain/insight-provider-capabilities";
import { insightNativeRunDisclosure } from "#src/renderer/src/insight-run-copy";
import {
  isAccountInsightProvider,
  type AccountInsightProvider,
} from "#src/domain/insight-provider";
import {
  INSIGHT_LANGUAGE_LABELS,
  INSIGHT_PROVIDER_LABELS,
} from "#src/renderer/src/insight-contracts";
import type { AccountModelsFailure } from "#src/renderer/src/hooks/use-insight-configuration";
import { ModelCombobox } from "./model-combobox";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Spinner } from "./ui/spinner";

const FIELD_LABEL_CLASS =
  "grid min-w-0 gap-1 text-xs font-medium text-muted-foreground";

/** Starts any of Brief, Walkthrough, and Analysis together, each with its own options. */
export function RunInsightsDialog({
  controller,
  accountModelsPending,
  accountModelsFailure,
  startFailureMessages,
  runsOnCombined,
}: {
  readonly controller: RunInsightsDialogController;
  readonly accountModelsPending: AccountInsightProvider | null;
  readonly accountModelsFailure: AccountModelsFailure | null;
  /** A refused start's message for each type; it shows on that type's row. */
  readonly startFailureMessages: Readonly<
    Record<InsightRunType, string | undefined>
  >;
  /** A shared local Review: every run reads its Combined patch whichever view the diff shows. */
  readonly runsOnCombined: boolean;
}): React.JSX.Element | null {
  const { rows, starting } = controller;
  if (rows === undefined) return null;
  const startable = RUN_INSIGHTS_ORDER.filter(
    (type) => rows[type].checked && !rows[type].running,
  );
  const missingModel = startable.some((type) => {
    const row = rows[type];
    const modelIds = new Set(row.models.map((model) => model.id));
    const reasons = new Set(modelReasoningOptions(row.models, row.model));
    return (
      !isAccountInsightProvider(row.provider) ||
      row.model === null ||
      !modelIds.has(row.model) ||
      !reasons.has(row.reasoning)
    );
  });
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !starting) controller.close();
      }}
    >
      <DialogContent
        data-testid="run-insights-dialog"
        showCloseButton={!starting}
        className="max-h-[min(85vh,48rem)] overflow-y-auto sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>Run Insights</DialogTitle>
          <DialogDescription>
            Shared settings apply to checked Insights. Expand an Insight to
            override its settings.
            {runsOnCombined ? " They run on the Combined view." : null}
          </DialogDescription>
        </DialogHeader>
        <SharedInsightOptions
          controller={controller}
          rows={rows}
          selected={startable}
          accountModelsPending={accountModelsPending}
          accountModelsFailure={accountModelsFailure}
        />
        {missingModel ? (
          <p role="note" className="text-sm text-muted-foreground">
            Choose a native provider and an available model for each checked
            Insight before starting.
          </p>
        ) : null}
        <div className="grid gap-3">
          {RUN_INSIGHTS_ORDER.map((type) => (
            <RunInsightsRowFields
              key={type}
              type={type}
              row={rows[type]}
              disabled={starting}
              controller={controller}
              accountModelsPending={accountModelsPending}
              accountModelsFailure={accountModelsFailure}
              {...(rows[type].running
                ? {}
                : { startFailureMessage: startFailureMessages[type] })}
            />
          ))}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={starting}
            onClick={controller.close}
          >
            Cancel
          </Button>
          <Button
            disabled={starting || startable.length === 0 || missingModel}
            onClick={controller.start}
          >
            {starting ? (
              <>
                <Spinner data-icon="inline-start" aria-hidden="true" />
                Starting…
              </>
            ) : (
              "Start runs"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function sharedValue<Value>(values: ReadonlyArray<Value>): Value | null {
  const first = values[0];
  return first !== undefined && values.every((value) => value === first)
    ? first
    : null;
}

function SharedInsightOptions({
  controller,
  rows,
  selected,
  accountModelsPending,
  accountModelsFailure,
}: {
  readonly controller: RunInsightsDialogController;
  readonly rows: Readonly<Record<InsightRunType, RunInsightsRow>>;
  readonly selected: ReadonlyArray<InsightRunType>;
  readonly accountModelsPending: AccountInsightProvider | null;
  readonly accountModelsFailure: AccountModelsFailure | null;
}): React.JSX.Element {
  const provider = sharedValue(selected.map((type) => rows[type].provider));
  const model = sharedValue(selected.map((type) => rows[type].model));
  const reasoning = sharedValue(selected.map((type) => rows[type].reasoning));
  const language = sharedValue(selected.map((type) => rows[type].language));
  const first = selected[0];
  const selections = selected.map((type) => ({
    modelIds: new Set(rows[type].models.map((candidate) => candidate.id)),
    reasons: new Set(
      modelReasoningOptions(rows[type].models, rows[type].model),
    ),
    providers: new Set(supportedInsightProviders(type)),
  }));
  const models =
    first === undefined || provider === null
      ? []
      : rows[first].models.filter((candidate) =>
          selections.every((selection) => selection.modelIds.has(candidate.id)),
        );
  const reasons =
    first === undefined
      ? []
      : modelReasoningOptions(rows[first].models, rows[first].model).filter(
          (candidate) =>
            selections.every((selection) => selection.reasons.has(candidate)),
        );
  const providers = supportedInsightProviders(first ?? "brief").filter(
    (candidate) =>
      selections.every((selection) => selection.providers.has(candidate)),
  );
  const disabled = controller.starting || selected.length === 0;
  return (
    <fieldset
      aria-label="Shared Insight settings"
      className="flex min-w-0 flex-col gap-2 rounded-lg border p-3"
    >
      <legend className="px-1 text-sm font-medium">Shared settings</legend>
      <p className="text-xs text-muted-foreground">
        {selected.length === 0
          ? "Select an Insight to edit its settings."
          : `${selected.length} selected. Mixed values stay unchanged until you choose a shared value. Running Insights are unchanged.`}
      </p>
      <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2">
        <label
          className={FIELD_LABEL_CLASS}
          htmlFor="run-insights-shared-provider"
        >
          Provider
          <InsightProviderSelect
            id="run-insights-shared-provider"
            ariaLabel="Shared provider"
            value={provider}
            providers={providers}
            disabled={disabled}
            onValueChange={(next) =>
              controller.changeShared({ provider: next })
            }
          />
        </label>
        <label
          className={FIELD_LABEL_CLASS}
          htmlFor="run-insights-shared-model"
        >
          Model
          <ModelCombobox
            id="run-insights-shared-model"
            ariaLabel="Shared model"
            options={models}
            value={model}
            placeholder={
              model === null ? "Mixed — choose a model" : "Choose a model"
            }
            disabled={disabled || provider === null}
            onValueChange={(next) => {
              if (next !== null) controller.changeShared({ model: next });
            }}
          />
        </label>
        <label
          className={FIELD_LABEL_CLASS}
          htmlFor="run-insights-shared-reasoning"
        >
          Reasoning
          <InsightReasoningSelect
            id="run-insights-shared-reasoning"
            ariaLabel="Shared reasoning"
            options={reasons}
            value={reasoning}
            disabled={disabled || reasons.length === 0}
            onValueChange={(next) =>
              controller.changeShared({ reasoning: next })
            }
          />
        </label>
        <label
          className={FIELD_LABEL_CLASS}
          htmlFor="run-insights-shared-language"
        >
          Language
          <InsightLanguageSelect
            id="run-insights-shared-language"
            ariaLabel="Shared language"
            value={language}
            disabled={disabled}
            onValueChange={(next) =>
              controller.changeShared({ language: next })
            }
          />
        </label>
      </div>
      {provider === null && selected.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Providers differ. Choose a shared provider to choose a shared model,
          or keep per-Insight overrides.
        </p>
      ) : null}
      {provider === "pi" ? (
        <p role="note" className="text-xs">
          API integration removed; choose Codex or Pi CLI. No native provider is
          selected.
        </p>
      ) : null}
      {provider !== null && isAccountInsightProvider(provider) ? (
        <AccountModelsControl
          provider={provider}
          loaded={models.length > 0}
          pending={accountModelsPending}
          failure={accountModelsFailure}
          disabled={disabled}
          onLoad={() => controller.loadAccountModels(provider)}
        />
      ) : null}
    </fieldset>
  );
}

function RunInsightsRowFields({
  type,
  row,
  disabled,
  controller,
  accountModelsPending,
  accountModelsFailure,
  startFailureMessage,
}: {
  readonly type: InsightRunType;
  readonly row: RunInsightsRow;
  readonly disabled: boolean;
  readonly controller: RunInsightsDialogController;
  readonly accountModelsPending: AccountInsightProvider | null;
  readonly accountModelsFailure: AccountModelsFailure | null;
  readonly startFailureMessage?: string | undefined;
}): React.JSX.Element {
  const noun = INSIGHT_NOUNS[type];
  const { provider } = row;
  const providers = supportedInsightProviders(type);
  const nativeDisclosure =
    row.checked && !row.running
      ? insightNativeRunDisclosure(type, provider)
      : undefined;
  const id = `run-insights-${type}`;
  const fieldsDisabled = disabled || row.running;
  return (
    <fieldset
      aria-label={noun}
      className="grid min-w-0 gap-2 rounded-lg border p-3"
    >
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-checked`}
          checked={row.checked && !row.running}
          disabled={fieldsDisabled}
          onCheckedChange={(checked) => controller.setChecked(type, checked)}
        />
        <label htmlFor={`${id}-checked`} className="text-sm font-medium">
          {noun}
        </label>
        {row.running ? (
          <span className="text-xs text-muted-foreground">
            {noun} is running
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {INSIGHT_PROVIDER_LABELS[row.provider]} ·{" "}
        {row.model ?? "No model selected"} · {row.reasoning} ·{" "}
        {INSIGHT_LANGUAGE_LABELS[row.language]}
      </p>
      {!row.running &&
      row.checked &&
      (!isAccountInsightProvider(row.provider) ||
        !row.models.some((model) => model.id === row.model) ||
        !modelReasoningOptions(row.models, row.model).includes(
          row.reasoning,
        )) ? (
        <p role="note" className="text-xs">
          {noun} cannot start with these settings. Choose a native provider,
          available model and supported reasoning level.
        </p>
      ) : null}
      {nativeDisclosure === undefined ? null : (
        <p className="text-xs text-muted-foreground">{nativeDisclosure}</p>
      )}
      <details className="min-w-0">
        <summary className="cursor-pointer text-xs">
          Per-Insight overrides
        </summary>
        <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,7rem)_minmax(0,8rem)]">
          <label className={FIELD_LABEL_CLASS} htmlFor={`${id}-provider`}>
            Provider
            <InsightProviderSelect
              id={`${id}-provider`}
              ariaLabel={`${noun} provider`}
              value={row.provider}
              providers={providers}
              disabled={fieldsDisabled}
              onValueChange={(provider) =>
                controller.changeProvider(type, provider)
              }
            />
          </label>
          <label className={FIELD_LABEL_CLASS} htmlFor={`${id}-model`}>
            Model
            <ModelCombobox
              id={`${id}-model`}
              ariaLabel={`${noun} model`}
              options={row.models}
              value={row.model}
              onValueChange={(model) => controller.changeModel(type, model)}
              disabled={fieldsDisabled}
            />
          </label>
          <label className={FIELD_LABEL_CLASS} htmlFor={`${id}-reasoning`}>
            Reasoning
            <InsightReasoningSelect
              id={`${id}-reasoning`}
              ariaLabel={`${noun} reasoning`}
              options={modelReasoningOptions(row.models, row.model)}
              value={row.reasoning}
              disabled={fieldsDisabled}
              onValueChange={(reasoning) =>
                controller.changeReasoning(type, reasoning)
              }
            />
          </label>
          <label className={FIELD_LABEL_CLASS} htmlFor={`${id}-language`}>
            Language
            <InsightLanguageSelect
              id={`${id}-language`}
              ariaLabel={`${noun} language`}
              value={row.language}
              disabled={fieldsDisabled}
              onValueChange={(language) =>
                controller.changeLanguage(type, language)
              }
            />
          </label>
        </div>
        {isAccountInsightProvider(provider) && !row.running ? (
          <AccountModelsControl
            provider={provider}
            loaded={row.models.length > 0}
            pending={accountModelsPending}
            failure={accountModelsFailure}
            disabled={disabled}
            onLoad={() => controller.loadAccountModels(provider)}
          />
        ) : null}
        {row.running ? null : (
          <ModelListPrice models={row.models} model={row.model} />
        )}
      </details>
      {row.models.length === 0 && provider === "pi" && !row.running ? (
        <Alert>
          <AlertDescription>
            API integration removed; choose Codex or Pi CLI
          </AlertDescription>
        </Alert>
      ) : null}
      {startFailureMessage === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>{noun} did not start.</AlertTitle>
          <AlertDescription>{startFailureMessage}</AlertDescription>
        </Alert>
      )}
    </fieldset>
  );
}
