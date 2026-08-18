import { useEffect, useRef, useState } from "react";
import * as v from "valibot";
import { requestJson } from "../api-client";
import { parseInsightProviderCatalog } from "../renderer-contracts";
import {
  DIFF_DARK_THEMES,
  DIFF_LIGHT_THEMES,
  type DiffThemePreferences,
} from "../diff-theme-preferences";
import type { AppearancePreference } from "../appearance-preferences";
import {
  loadInsightRunPreference,
  saveInsightRunPreference,
  type InsightRunPreference,
} from "../insight-run-preferences";
import type { InsightReasoning } from "../../../domain/insight-provider";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { cleanupCopy } from "../review-copy";
import { LogsPanel } from "../components/logs-panel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Field, FieldGroup, FieldLabel } from "../components/ui/field";
import { Label } from "../components/ui/label";
import { ModelCombobox } from "../components/model-combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import type { Dashboard, Profile } from "../renderer-models";
import { WorkspaceProfileSection } from "./settings-workspace-section";

export type SettingsSection =
  | "general"
  | "workspace"
  | "review"
  | "data"
  | "logs";

// Not `strictObject`: the redacted local-activity feed may gain fields over
// time, and this panel only ever reads this fixed set.
const activityEventSchema = v.object({
  at: v.string(),
  category: v.string(),
  phase: v.string(),
  retryable: v.boolean(),
  durationMs: v.optional(v.number()),
  detail: v.optional(v.string()),
});

type ActivityEvent = v.InferOutput<typeof activityEventSchema>;

const diagnosticsResponseSchema = v.object({
  events: v.array(v.unknown()),
});

/** Parses the local API's diagnostics response for the Settings activity log; each malformed event drops itself instead of discarding the whole feed. */
function parseDiagnosticsResponse(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): ReadonlyArray<ActivityEvent> | undefined {
  const parsed = v.safeParse(diagnosticsResponseSchema, input);
  if (!parsed.success) return undefined;
  const events: ActivityEvent[] = [];
  for (const event of parsed.output.events) {
    const item = v.safeParse(activityEventSchema, event);
    if (item.success) events.push(item.output);
  }
  return events;
}

type CleanupState = {
  readonly requestId: number;
  readonly action?: "cache" | "local";
  readonly pending: boolean;
  readonly error?: string;
};

type ActivityErrorState = {
  readonly generation: number;
  readonly message?: string;
};

type SettingsFlowProps = {
  readonly dashboard?: Dashboard;
  readonly appearance: AppearancePreference;
  readonly onAppearanceChange: (value: AppearancePreference) => void;
  readonly diffThemePreferences: DiffThemePreferences;
  readonly onDiffThemeChange: (value: DiffThemePreferences) => void;
  readonly profiles: ReadonlyArray<Profile>;
  readonly onWorkspaceReload: () => Promise<void>;
  readonly section?: SettingsSection;
  readonly onProfileDirtyChange?: (dirty: boolean) => void;
  readonly onProfileSwitchRequest?: (
    profileId: string,
    proceed: () => void,
  ) => void;
  readonly onCleanupSuccess?: (action: "cache" | "local") => void;
  readonly onSaveProfileReady?: (save: () => Promise<boolean>) => void;
  readonly onDiscardProfileReady?: (discard: () => void) => void;
  readonly onProfileSwitchStart?: (() => void) | undefined;
};

/** Renders one focused Settings section inside the global Settings overlay. */
export function SettingsFlow({
  dashboard,
  appearance,
  onAppearanceChange,
  diffThemePreferences,
  onDiffThemeChange,
  profiles,
  onWorkspaceReload,
  section = "general",
  onProfileDirtyChange,
  onProfileSwitchRequest,
  onCleanupSuccess,
  onSaveProfileReady,
  onDiscardProfileReady,
  onProfileSwitchStart,
}: SettingsFlowProps): React.JSX.Element {
  // `WorkspaceProfileSection` is always mounted — not just while the
  // Workspace tab is showing — so its profile draft, baseline/generation
  // refs, and `onSaveProfileReady`/`onDiscardProfileReady` wiring survive
  // switching to another Settings tab and back. `visible` only controls
  // whether it currently renders its cards.
  const workspaceSection = (
    <WorkspaceProfileSection
      dashboard={dashboard}
      profiles={profiles}
      onWorkspaceReload={onWorkspaceReload}
      visible={section === "workspace"}
      onProfileDirtyChange={onProfileDirtyChange}
      onProfileSwitchRequest={onProfileSwitchRequest}
      onSaveProfileReady={onSaveProfileReady}
      onDiscardProfileReady={onDiscardProfileReady}
      onProfileSwitchStart={onProfileSwitchStart}
    />
  );

  if (section === "review") {
    return (
      <>
        {workspaceSection}
        <ReviewPreferences profileId={dashboard?.profile.id} />
      </>
    );
  }

  if (section === "logs") {
    return (
      <>
        {workspaceSection}
        <LogsPanel />
      </>
    );
  }

  if (section === "workspace") {
    return <>{workspaceSection}</>;
  }

  if (section === "data") {
    return (
      <>
        {workspaceSection}
        <DataSection
          dashboard={dashboard}
          onWorkspaceReload={onWorkspaceReload}
          onCleanupSuccess={onCleanupSuccess}
        />
      </>
    );
  }

  return (
    <>
      {workspaceSection}
      <GeneralSection
        appearance={appearance}
        onAppearanceChange={onAppearanceChange}
        diffThemePreferences={diffThemePreferences}
        onDiffThemeChange={onDiffThemeChange}
      />
    </>
  );
}

/** The Data & recovery Settings section: cache/local-data cleanup and the redacted local activity log. Split out of `SettingsFlow` so that component stays a thin per-section router. */
function DataSection({
  dashboard,
  onWorkspaceReload,
  onCleanupSuccess,
}: {
  readonly dashboard: Dashboard | undefined;
  readonly onWorkspaceReload: () => Promise<void>;
  readonly onCleanupSuccess: ((action: "cache" | "local") => void) | undefined;
}): React.JSX.Element {
  const [cleanup, setCleanup] = useState<CleanupState>({
    requestId: 0,
    pending: false,
  });
  const [activity, setActivity] = useState<ReadonlyArray<ActivityEvent>>();
  const [activityLoadState, setActivityLoadState] =
    useState<ActivityErrorState>({ generation: 0 });
  const cleanupAvailable = dashboard?.profile.id !== undefined;
  const activityLoadGeneration = useRef(0);
  const cleanupRequestId = useRef(0);

  const runCleanup = async (): Promise<void> => {
    const action = cleanup.action;
    if (action === undefined) return;
    if (dashboard?.profile.id === undefined) {
      setCleanup((current) => ({
        ...current,
        error: "Choose a workspace profile before clearing its local data.",
      }));
      return;
    }
    const requestId = ++cleanupRequestId.current;
    setCleanup({ requestId, action, pending: true });
    try {
      await requestJson(
        action === "cache"
          ? "/v1/storage/cache/clear"
          : "/v1/storage/clear-local-data",
        {
          method: "POST",
          body: { profileId: dashboard.profile.id },
        },
      );
      await onWorkspaceReload();
      if (cleanupRequestId.current !== requestId) return;
      setCleanup((current) =>
        current.requestId === requestId
          ? { requestId, pending: false }
          : current,
      );
      onCleanupSuccess?.(action);
    } catch {
      const error =
        action === "cache"
          ? "Could not clear cache. Try again."
          : "Could not clear local review data. Try again.";
      setCleanup((current) =>
        current.requestId === requestId
          ? { requestId, action, pending: false, error }
          : current,
      );
    }
  };

  const loadActivity = async (): Promise<void> => {
    if (dashboard?.profile.id === undefined) return;
    const generation = ++activityLoadGeneration.current;
    setActivityLoadState({ generation });
    try {
      const value = await requestJson(
        `/v1/diagnostics?profileId=${encodeURIComponent(dashboard.profile.id)}`,
      );
      const parsed = parseDiagnosticsResponse(value);
      if (parsed === undefined) throw new Error("invalid_activity");
      const events = parsed.slice(-40).reverse();
      if (generation !== activityLoadGeneration.current) return;
      setActivity(events);
    } catch {
      if (generation !== activityLoadGeneration.current) return;
      setActivity(undefined);
      setActivityLoadState({
        generation,
        message: "Could not load local activity. Try again.",
      });
    }
  };

  return (
    <>
      <Card data-testid="local-review-data-card">
        <CardHeader>
          <CardTitle>Local review data</CardTitle>
          <CardDescription>
            Two workspace actions, ordered by severity. Confirmations state what
            stays and what goes.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Alert>
            <AlertTitle>Stored reviews stay readable</AlertTitle>
            <AlertDescription>
              Clear cache keeps review history. Clear local review data removes
              completed and failed local reviews; an active review and
              diagnostic reports stay.
            </AlertDescription>
          </Alert>
          {cleanupAvailable ? null : (
            <Alert>
              <AlertTitle>No active workspace</AlertTitle>
              <AlertDescription>
                Choose a workspace profile before clearing its local data.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              disabled={!cleanupAvailable}
              onClick={() => {
                setCleanup((current) => ({
                  requestId: current.requestId,
                  action: "cache",
                  pending: false,
                }));
              }}
            >
              Clear cache
            </Button>
            <Button
              variant="outline"
              disabled={!cleanupAvailable}
              data-testid="clear-local-data-button"
              onClick={() => {
                setCleanup((current) => ({
                  requestId: current.requestId,
                  action: "local",
                  pending: false,
                }));
              }}
            >
              Clear local review data
            </Button>
          </div>
          {cleanup.error === undefined ? null : (
            <Alert variant="destructive">
              <AlertTitle>Cleanup failed</AlertTitle>
              <AlertDescription role="alert">{cleanup.error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
      <Card data-testid="review-activity-card">
        <CardHeader>
          <CardTitle>Review activity</CardTitle>
          <CardDescription>
            Redacted local milestones for review and walkthrough runs. Patchdesk
            never shows prompts, tokens, paths, or provider output.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button
            variant="outline"
            disabled={!cleanupAvailable}
            onClick={() => {
              void loadActivity();
            }}
          >
            Load activity
          </Button>
          {activityLoadState.message === undefined ? null : (
            <Alert variant="destructive">
              <AlertTitle>Activity unavailable</AlertTitle>
              <AlertDescription role="alert">
                {activityLoadState.message}
              </AlertDescription>
            </Alert>
          )}
          {activity === undefined ? null : activity.length === 0 ? (
            <p className="text-sm text-muted-foreground" role="status">
              No local review activity yet.
            </p>
          ) : (
            <ol
              className="flex flex-col gap-2"
              aria-label="Review activity log"
            >
              {activity.map((event) => (
                <li
                  key={`${event.at}-${event.category}-${event.phase}-${event.detail ?? ""}`}
                  className="rounded-md border p-3 text-sm"
                >
                  <p className="font-medium">{activityLabel(event.phase)}</p>
                  <p className="text-muted-foreground">
                    {event.category} ·{" "}
                    {event.retryable ? "can retry" : "completed"}
                    {event.durationMs === undefined
                      ? ""
                      : ` · ${Math.round(event.durationMs / 1_000)}s`}
                  </p>
                  {event.detail === undefined ? null : (
                    <p className="mt-1 text-muted-foreground">{event.detail}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
      <CleanupConfirmation
        action={cleanup.action}
        pending={cleanup.pending}
        error={cleanup.error}
        onCancel={() => {
          if (!cleanup.pending)
            setCleanup((current) => ({
              requestId: current.requestId,
              pending: false,
            }));
        }}
        onConfirm={() => {
          void runCleanup();
        }}
      />
    </>
  );
}

/** The General Settings section: Appearance and Diff theme. Split out of `SettingsFlow` so that component stays a thin per-section router. */
function GeneralSection({
  appearance,
  onAppearanceChange,
  diffThemePreferences,
  onDiffThemeChange,
}: {
  readonly appearance: AppearancePreference;
  readonly onAppearanceChange: (value: AppearancePreference) => void;
  readonly diffThemePreferences: DiffThemePreferences;
  readonly onDiffThemeChange: (value: DiffThemePreferences) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>
            Follow the system setting, or keep Patchdesk in light or dark mode.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Label className="grid gap-1.5">
            Theme
            <Select
              value={appearance}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark")
                  onAppearanceChange(value);
              }}
            >
              <SelectTrigger className="h-12" aria-label="Appearance">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
          </Label>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Diff theme</CardTitle>
          <CardDescription>
            Choose the Pierre theme used for light and dark appearance.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Label className="grid gap-1.5">
            Light appearance
            <Select
              value={diffThemePreferences.light}
              onValueChange={(value) => {
                if (
                  value !== null &&
                  DIFF_LIGHT_THEMES.some((theme) => theme.id === value)
                )
                  onDiffThemeChange({
                    ...diffThemePreferences,
                    light: value,
                  });
              }}
            >
              <SelectTrigger className="h-12" aria-label="Light diff theme">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIFF_LIGHT_THEMES.map((theme) => (
                  <SelectItem key={theme.id} value={theme.id}>
                    {theme.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
          <Label className="grid gap-1.5">
            Dark appearance
            <Select
              value={diffThemePreferences.dark}
              onValueChange={(value) => {
                if (
                  value !== null &&
                  DIFF_DARK_THEMES.some((theme) => theme.id === value)
                )
                  onDiffThemeChange({ ...diffThemePreferences, dark: value });
              }}
            >
              <SelectTrigger className="h-12" aria-label="Dark diff theme">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIFF_DARK_THEMES.map((theme) => (
                  <SelectItem key={theme.id} value={theme.id}>
                    {theme.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
        </CardContent>
      </Card>
    </div>
  );
}

function ReviewPreferences({
  profileId,
}: {
  readonly profileId: string | undefined;
}): React.JSX.Element {
  const [preference, setPreference] = useState(() => preferenceFor(profileId));
  const [models, setModels] = useState<
    ReadonlyArray<{ readonly id: string; readonly label: string }>
  >([]);
  const [catalogUnavailable, setCatalogUnavailable] = useState(false);
  const [codexAvailable, setCodexAvailable] = useState<boolean | undefined>();
  useEffect(() => {
    let active = true;
    void requestJson("/v1/insight-providers")
      .then((value) => {
        const catalog = parseInsightProviderCatalog(value);
        if (!active) return;
        setCodexAvailable(
          catalog?.providers.find(
            (provider) => provider.id === "codex-cli-account",
          )?.available ?? false,
        );
      })
      .catch(() => {
        if (active) setCodexAvailable(false);
      });
    return () => {
      active = false;
    };
  }, [profileId]);
  useEffect(() => {
    const saved = preferenceFor(profileId);
    setPreference(saved);
    let active = true;
    void requestJson("/v1/insight-providers")
      .then((value) => {
        const catalog = parseInsightProviderCatalog(value);
        if (!active || catalog === undefined) {
          if (active) {
            setModels([]);
            setCatalogUnavailable(true);
          }
          return;
        }
        const piModels = catalog.models.flatMap((candidate) =>
          candidate.provider === "pi"
            ? [{ id: candidate.id, label: candidate.label }]
            : [],
        );
        const model = selectedModel(piModels, piModels[0]?.id, saved.model);
        setModels(piModels);
        const next = {
          provider: "pi" as const,
          model: model ?? saved.model,
          reasoning: saved.reasoning,
        };
        setPreference(next);
        setCatalogUnavailable(false);
        // A stored non-"pi" preference means the last Analysis run used
        // Codex; Settings is Pi-only, so it must not silently overwrite that
        // provider choice just by loading this screen. Only self-heal a
        // stale model id when the shared preference is already Pi-scoped
        // (or unset).
        const storedProvider =
          profileId === undefined
            ? undefined
            : loadInsightRunPreference(profileId, "analysis")?.provider;
        if (
          profileId !== undefined &&
          model !== undefined &&
          saved.model !== model &&
          (storedProvider === undefined || storedProvider === "pi")
        )
          saveInsightRunPreference(profileId, "analysis", next);
      })
      .catch(() => {
        if (!active) return;
        setModels([]);
        setCatalogUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [profileId]);
  const update = (next: {
    readonly model: string;
    readonly reasoning: InsightReasoning;
  }): void => {
    const withProvider = { provider: "pi" as const, ...next };
    setPreference(withProvider);
    if (profileId !== undefined)
      saveInsightRunPreference(profileId, "analysis", withProvider);
  };
  return (
    <Card data-testid="settings-section-review">
      <CardHeader>
        <CardTitle>Review preferences</CardTitle>
        <CardDescription>
          Profile-scoped defaults for the next Analysis run. They never start
          work.
        </CardDescription>
        <p
          className="text-sm text-muted-foreground"
          data-testid="codex-provider-status"
        >
          Codex CLI account:{" "}
          {codexAvailable === undefined
            ? "checking availability"
            : codexAvailable
              ? "available"
              : "unavailable; expose codex on the app launch PATH and log in externally"}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="default-model">Default model</FieldLabel>
            <ModelCombobox
              id="default-model"
              ariaLabel="Default model"
              options={models}
              value={preference.model}
              disabled={catalogUnavailable}
              placeholder="No enabled model available"
              onValueChange={(value) => {
                if (
                  value !== null &&
                  models.some((model) => model.id === value)
                )
                  update({ ...preference, model: value });
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="default-reasoning">
              Default reasoning
            </FieldLabel>
            <Select
              value={preference.reasoning}
              onValueChange={(value) => {
                if (
                  value === "minimal" ||
                  value === "low" ||
                  value === "medium" ||
                  value === "high" ||
                  value === "xhigh"
                )
                  update({ ...preference, reasoning: value });
              }}
            >
              <SelectTrigger
                id="default-reasoning"
                aria-label="Default reasoning"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="minimal">Minimal</SelectItem>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="xhigh">Extra high</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
        {catalogUnavailable ||
        (models.length === 0 && codexAvailable !== true) ? (
          <Alert>
            <AlertTitle>No eligible model configured</AlertTitle>
            <AlertDescription>
              Configure an API key or ambient provider credentials in the
              Electron process, then reload this screen. Your saved preference
              is kept.
            </AlertDescription>
          </Alert>
        ) : models.length === 0 ? (
          <Alert>
            <AlertTitle>No Pi model configured</AlertTitle>
            <AlertDescription>
              Codex CLI account is available. Start an Insight and select Codex
              CLI account to load its models.
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Settings is Pi-only: it never shows or writes a Codex preference. When the
 * shared Analysis default was last set by a Codex run, this falls back to
 * the ordinary Pi default rather than displaying a value Settings cannot
 * represent — see the storedProvider guard above, which keeps that fallback
 * from being persisted just because this screen loaded.
 */
function preferenceFor(profileId: string | undefined): InsightRunPreference {
  const fallback: InsightRunPreference = {
    provider: "pi",
    model: "pi-design",
    reasoning: "medium",
  };
  if (profileId === undefined) return fallback;
  const stored = loadInsightRunPreference(profileId, "analysis");
  return stored?.provider === "pi" ? stored : fallback;
}

function selectedModel(
  models: ReadonlyArray<{ readonly id: string; readonly label: string }>,
  defaultModel: string | undefined,
  savedModel: string,
): string | undefined {
  if (models.some((model) => model.id === savedModel)) return savedModel;
  if (
    defaultModel !== undefined &&
    models.some((model) => model.id === defaultModel)
  )
    return defaultModel;
  return models[0]?.id;
}

function CleanupConfirmation({
  action,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  readonly action: "cache" | "local" | undefined;
  readonly pending: boolean;
  readonly error: string | undefined;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  if (action === undefined) return <></>;
  const copy = cleanupCopy(
    action === "local" ? "clear_local_review_data" : "clear_cache",
  );
  const local = action === "local";
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent
        data-testid={`cleanup-dialog-${local ? "clear_local_review_data" : "clear_cache"}`}
        aria-busy={pending}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.body}</AlertDialogDescription>
        </AlertDialogHeader>
        {error === undefined ? null : (
          <Alert variant="destructive">
            <AlertTitle>Cleanup failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={local ? "destructive" : "default"}
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {copy.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function activityLabel(phase: string): string {
  return phase
    .split("-")
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}
