import { useRef, useState } from "react";
import * as v from "valibot";
import { requestJson } from "../api-client";
import {
  DIFF_DARK_THEMES,
  DIFF_LIGHT_THEMES,
  type DiffThemePreferences,
} from "../diff-theme-preferences";
import type { AppearancePreference } from "../appearance-preferences";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { cleanupCopy } from "../review-copy";
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
import { useApiProbe } from "../hooks/use-api-probe";
import { NotificationsCard } from "./settings-notifications-card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import type { Dashboard, Profile } from "../renderer-models";
import type {
  ProfileSwitchResult,
  ProfileSwitchState,
} from "../hooks/use-profile-switch";
import { WorkspaceProfileSection } from "./settings-workspace-section";

export type SettingsSection = "general" | "workspace" | "data";

type CleanupState = {
  readonly requestId: number;
  readonly action?: "cache" | "local";
  readonly pending: boolean;
  readonly error?: string;
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
  readonly onCleanupSuccess?: (action: "cache" | "local") => void;
  readonly profileSwitchState?: ProfileSwitchState;
  readonly onProfileSwitch?: (
    profileId: string,
  ) => Promise<ProfileSwitchResult>;
};

type StorageRow = {
  readonly title: string;
  readonly description: string;
  readonly bytes: number | undefined;
  readonly action?: {
    readonly label: string;
    readonly testId?: string;
    readonly onClick: () => void;
  };
};

// Without an active workspace the route reports only the app-wide logs size.
const storageUsageSchema = v.object({
  cacheBytes: v.optional(v.number()),
  localReviewDataBytes: v.optional(v.number()),
  logsBytes: v.number(),
});

function parseStorageUsage(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the boundary parser for the usage response, handed the raw JSON body.
  value: unknown,
): v.InferOutput<typeof storageUsageSchema> | undefined {
  const parsed = v.safeParse(storageUsageSchema, value);
  return parsed.success ? parsed.output : undefined;
}

/** Decimal units, as Finder reports sizes: one decimal below 10, whole numbers above. */
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  const format = (amount: number, index: number): string =>
    amount.toFixed(index === 0 || amount >= 10 ? 0 : 1);
  // Compare the rounded figure, so 999,950 B reads 1.0 MB rather than 1000 KB.
  while (Number(format(value, unit)) >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${format(value, unit)} ${units[unit]}`;
}

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
  onCleanupSuccess,
  profileSwitchState,
  onProfileSwitch,
}: SettingsFlowProps): React.JSX.Element {
  // The Workspace section is rendered only while its tab is showing: every
  // control there saves itself on blur, on Enter, or on pick, so leaving the
  // tab leaves no draft behind for a mounted-but-hidden section to hold.
  if (section === "workspace") {
    return (
      <WorkspaceProfileSection
        dashboard={dashboard}
        profiles={profiles}
        onWorkspaceReload={onWorkspaceReload}
        profileSwitchState={profileSwitchState}
        onProfileSwitch={onProfileSwitch}
      />
    );
  }

  if (section === "data") {
    return (
      <DataSection
        dashboard={dashboard}
        onWorkspaceReload={onWorkspaceReload}
        onCleanupSuccess={onCleanupSuccess}
      />
    );
  }

  return (
    <GeneralSection
      appearance={appearance}
      onAppearanceChange={onAppearanceChange}
      diffThemePreferences={diffThemePreferences}
      onDiffThemeChange={onDiffThemeChange}
    />
  );
}

/** The Data & recovery Settings section: cache and local-data cleanup. Split out of `SettingsFlow` so that component stays a thin per-section router. */
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
  const cleanupAvailable = dashboard?.profile.id !== undefined;
  const cleanupRequestId = useRef(0);
  const [cleanupsCompleted, setCleanupsCompleted] = useState(0);
  const usage = useApiProbe(
    {
      path:
        dashboard?.profile.id === undefined
          ? "/v1/storage/usage"
          : `/v1/storage/usage?profileId=${encodeURIComponent(dashboard.profile.id)}`,
      restartKey: cleanupsCompleted,
    },
    parseStorageUsage,
  );

  const runCleanup = async (): Promise<void> => {
    const action = cleanup.action;
    if (action === undefined) return;
    if (dashboard?.profile.id === undefined) {
      setCleanup((current) => ({
        ...current,
        error: "Choose a workspace before clearing its local data.",
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
      setCleanupsCompleted((count) => count + 1);
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

  const choose = (action: "cache" | "local"): void => {
    setCleanup((current) => ({
      requestId: current.requestId,
      action,
      pending: false,
    }));
  };
  const rows: ReadonlyArray<StorageRow> = [
    {
      title: "Cache",
      description: "Rebuildable pull request checkouts. Saved reviews stay.",
      bytes: usage.kind === "loaded" ? usage.value.cacheBytes : undefined,
      action: { label: "Clear cache", onClick: () => choose("cache") },
    },
    {
      title: "Local review data",
      description:
        "Completed and failed local reviews. An active review stays.",
      bytes:
        usage.kind === "loaded" ? usage.value.localReviewDataBytes : undefined,
      action: {
        label: "Clear local review data",
        testId: "clear-local-data-button",
        onClick: () => choose("local"),
      },
    },
    {
      title: "Logs",
      description: "App activity shown in Diagnostics.",
      bytes: usage.kind === "loaded" ? usage.value.logsBytes : undefined,
    },
  ];

  return (
    <>
      <Card data-testid="local-review-data-card">
        <CardHeader>
          <CardTitle>Storage</CardTitle>
          <CardDescription>Space Patchdesk uses on this Mac.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {cleanupAvailable ? null : (
            <Alert>
              <AlertTitle>No active workspace</AlertTitle>
            </Alert>
          )}
          <ul className="flex flex-col divide-y">
            {rows.map((row) => (
              <li
                key={row.title}
                className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="font-medium">
                    {row.title}
                    {row.bytes === undefined ? null : (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        · {formatBytes(row.bytes)}
                      </span>
                    )}
                  </p>
                  <p className="text-muted-foreground">{row.description}</p>
                </div>
                {row.action === undefined ? null : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!cleanupAvailable}
                    data-testid={row.action.testId}
                    onClick={row.action.onClick}
                  >
                    {row.action.label}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {cleanup.error === undefined ? null : (
            <Alert variant="destructive">
              <AlertTitle>Cleanup failed</AlertTitle>
              <AlertDescription>{cleanup.error}</AlertDescription>
            </Alert>
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
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <SelectRow
              id="appearance"
              label="Theme"
              name="Appearance"
              value={appearance}
              options={[
                { label: "System", value: "system" },
                { label: "Light", value: "light" },
                { label: "Dark", value: "dark" },
              ]}
              onChange={(value) => {
                if (value === "system" || value === "light" || value === "dark")
                  onAppearanceChange(value);
              }}
            />
          </FieldGroup>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Diff theme</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <SelectRow
              id="light-diff-theme"
              label="Light appearance"
              name="Light diff theme"
              value={diffThemePreferences.light}
              options={DIFF_LIGHT_THEMES.map((theme) => ({
                label: theme.label,
                value: theme.id,
              }))}
              onChange={(value) => {
                if (DIFF_LIGHT_THEMES.some((theme) => theme.id === value))
                  onDiffThemeChange({ ...diffThemePreferences, light: value });
              }}
            />
            <SelectRow
              id="dark-diff-theme"
              label="Dark appearance"
              name="Dark diff theme"
              value={diffThemePreferences.dark}
              options={DIFF_DARK_THEMES.map((theme) => ({
                label: theme.label,
                value: theme.id,
              }))}
              onChange={(value) => {
                if (DIFF_DARK_THEMES.some((theme) => theme.id === value))
                  onDiffThemeChange({ ...diffThemePreferences, dark: value });
              }}
            />
          </FieldGroup>
        </CardContent>
      </Card>
      <NotificationsCard />
    </div>
  );
}

/** One labelled General setting with its Select on the right, at the width every Settings select shares. */
function SelectRow({
  id,
  label,
  name,
  value,
  options,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  /** The Select's accessible name, when it differs from the visible label. */
  readonly name: string;
  readonly value: string;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly value: string;
  }>;
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <Field orientation="horizontal">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        value={value}
        items={options}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger id={id} className="w-56" aria-label={name}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
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
