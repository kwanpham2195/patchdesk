import { useRef, useState } from "react";
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
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "../components/ui/field";
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

  return (
    <>
      <Card data-testid="local-review-data-card">
        <CardHeader>
          <CardTitle>Local review data</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {cleanupAvailable ? null : (
            <Alert>
              <AlertTitle>No active workspace</AlertTitle>
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
            <Field>
              <FieldLabel className="text-sm font-medium" htmlFor="appearance">
                Theme
              </FieldLabel>
              <Select
                value={appearance}
                items={[
                  { label: "System", value: "system" },
                  { label: "Light", value: "light" },
                  { label: "Dark", value: "dark" },
                ]}
                onValueChange={(value) => {
                  if (
                    value === "system" ||
                    value === "light" ||
                    value === "dark"
                  )
                    onAppearanceChange(value);
                }}
              >
                <SelectTrigger
                  id="appearance"
                  className="h-12"
                  aria-label="Appearance"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="system">System</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Diff theme</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldSet>
            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel
                  className="text-sm font-medium"
                  htmlFor="light-diff-theme"
                >
                  Light appearance
                </FieldLabel>
                <Select
                  value={diffThemePreferences.light}
                  items={DIFF_LIGHT_THEMES.map((theme) => ({
                    label: theme.label,
                    value: theme.id,
                  }))}
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
                  <SelectTrigger
                    id="light-diff-theme"
                    className="h-12"
                    aria-label="Light diff theme"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {DIFF_LIGHT_THEMES.map((theme) => (
                        <SelectItem key={theme.id} value={theme.id}>
                          {theme.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel
                  className="text-sm font-medium"
                  htmlFor="dark-diff-theme"
                >
                  Dark appearance
                </FieldLabel>
                <Select
                  value={diffThemePreferences.dark}
                  items={DIFF_DARK_THEMES.map((theme) => ({
                    label: theme.label,
                    value: theme.id,
                  }))}
                  onValueChange={(value) => {
                    if (
                      value !== null &&
                      DIFF_DARK_THEMES.some((theme) => theme.id === value)
                    )
                      onDiffThemeChange({
                        ...diffThemePreferences,
                        dark: value,
                      });
                  }}
                >
                  <SelectTrigger
                    id="dark-diff-theme"
                    className="h-12"
                    aria-label="Dark diff theme"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {DIFF_DARK_THEMES.map((theme) => (
                        <SelectItem key={theme.id} value={theme.id}>
                          {theme.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
          </FieldSet>
        </CardContent>
      </Card>
      <NotificationsCard />
    </div>
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
