import {
  RUN_INSIGHTS_ORDER,
  type RunInsightsDialogController,
  type RunInsightsRow,
} from "../hooks/use-run-insights-dialog";
import type { InsightRunType } from "../hooks/use-insight-run";
import { INSIGHT_NOUNS } from "./insight-run-dialog";
import {
  AccountModelsControl,
  InsightLanguageSelect,
  InsightProviderSelect,
  InsightReasoningSelect,
  ModelListPrice,
} from "./insight-run-option-controls";
import { modelReasoningOptions } from "../insight-run-options";
import {
  isAccountInsightProvider,
  type AccountInsightProvider,
} from "../../../domain/insight-provider";
import type { AccountModelsFailure } from "../hooks/use-insight-configuration";
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
  const missingModel = startable.some((type) => rows[type].model === null);
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
            Each checked Insight runs for this revision with its own options.
            {runsOnCombined ? " They run on the Combined view." : null}
          </DialogDescription>
        </DialogHeader>
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
      <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,7rem)_minmax(0,8rem)] gap-2">
        <label className={FIELD_LABEL_CLASS} htmlFor={`${id}-provider`}>
          Provider
          <InsightProviderSelect
            id={`${id}-provider`}
            ariaLabel={`${noun} provider`}
            value={row.provider}
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
      {startFailureMessage === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>{noun} did not start.</AlertTitle>
          <AlertDescription>{startFailureMessage}</AlertDescription>
        </Alert>
      )}
    </fieldset>
  );
}
