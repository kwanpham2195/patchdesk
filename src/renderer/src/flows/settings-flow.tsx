import { useEffect, useRef, useState, type SetStateAction } from "react";
import { FolderOpen, Plus, X } from "lucide-react";
import { requestJson, selectDirectory } from "../api-client";
import { parseInsightProviderCatalog } from "../renderer-contracts";
import {
  DIFF_DARK_THEMES,
  DIFF_LIGHT_THEMES,
  type DiffThemePreferences,
} from "../diff-theme-preferences";
import type { AppearancePreference } from "../appearance-preferences";
import {
  loadReviewExecutionPreference,
  saveReviewExecutionPreference,
  type ReviewReasoningPreference,
} from "../review-execution-preferences";
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
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { WatchlistPanel } from "../components/watchlist-panel";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { ModelCombobox } from "../components/model-combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import type { Dashboard, Profile } from "../renderer-models";

export type SettingsSection =
  | "general"
  | "workspace"
  | "review"
  | "data"
  | "logs";

type ProfileDraft = {
  readonly id: string;
  readonly label: string;
  readonly githubHost: string;
  readonly ghAccount: string;
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly ownerFilters: ReadonlyArray<string>;
  readonly rulePaths: ReadonlyArray<string>;
};

type ActivityEvent = {
  readonly at: string;
  readonly category: string;
  readonly phase: string;
  readonly retryable: boolean;
  readonly durationMs?: number;
  readonly detail?: string;
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
  readonly onDirtyChange?: (dirty: boolean) => void;
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
  onDirtyChange,
  onProfileSwitchRequest,
  onCleanupSuccess,
  onSaveProfileReady,
  onDiscardProfileReady,
  onProfileSwitchStart,
}: SettingsFlowProps): React.JSX.Element {
  const [profileDraft, setProfileDraft] = useState(() =>
    profileDraftFor(dashboard?.profile),
  );
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string>();
  const [savingProfile, setSavingProfile] = useState(false);
  const [cleanupAction, setCleanupAction] = useState<"cache" | "local">();
  const [cleanupPending, setCleanupPending] = useState(false);
  const [cleanupError, setCleanupError] = useState<string>();
  const [activity, setActivity] = useState<ReadonlyArray<ActivityEvent>>();
  const [activityError, setActivityError] = useState<string>();
  const cleanupAvailable = dashboard?.profile.id !== undefined;
  const profileBaseline = useRef(profileDraft);
  const pendingSavedProfile = useRef<
    { readonly id: string; readonly label: string } | undefined
  >(undefined);
  const profileDraftGeneration = useRef(0);
  const updateProfileDraft = (update: SetStateAction<ProfileDraft>): void => {
    profileDraftGeneration.current += 1;
    setProfileDraft(update);
  };
  const profileDirty =
    JSON.stringify(profileDraft) !== JSON.stringify(profileBaseline.current);

  useEffect(() => {
    onDirtyChange?.(profileDirty);
  }, [onDirtyChange, profileDirty]);

  useEffect(() => {
    if (dashboard === undefined) return;
    const pending = pendingSavedProfile.current;
    if (pending !== undefined) {
      if (
        dashboard.profile.id !== pending.id ||
        dashboard.profile.label !== pending.label
      )
        return;
      pendingSavedProfile.current = undefined;
    }
    if (
      creatingProfile ||
      dashboard.profile.id === profileDraft.id ||
      profileDirty
    )
      return;
    const next = profileDraftFor(dashboard.profile);
    profileBaseline.current = next;
    setProfileDraft(next);
  }, [creatingProfile, dashboard, profileDirty, profileDraft.id]);

  const saveProfile = async (): Promise<boolean> => {
    setProfileError(undefined);
    const normalized = normalizeProfileDraft(profileDraft);
    if (typeof normalized === "string") {
      setProfileError(normalized);
      return false;
    }
    if (
      creatingProfile &&
      profiles.some((profile) => profile.id === normalized.id)
    ) {
      setProfileError("A profile with this ID already exists.");
      return false;
    }
    setSavingProfile(true);
    const draftGeneration = profileDraftGeneration.current;
    try {
      await requestJson("/v1/profiles", {
        method: creatingProfile ? "POST" : "PUT",
        body: normalized,
      });
      if (creatingProfile) {
        await requestJson("/v1/profiles/select", {
          method: "POST",
          body: { id: normalized.id },
        });
      }
      const next = profileDraftFromNormalized(normalized);
      pendingSavedProfile.current = {
        id: normalized.id,
        label: normalized.label,
      };
      profileBaseline.current = next;
      if (profileDraftGeneration.current === draftGeneration) {
        setProfileDraft(next);
        onDirtyChange?.(false);
      } else {
        onDirtyChange?.(true);
      }
      setCreatingProfile(false);
      await onWorkspaceReload();
      return true;
    } catch (cause: unknown) {
      setProfileError(
        cause instanceof Error
          ? cause.message
          : "Patchdesk could not save the local review state.",
      );
      return false;
    } finally {
      setSavingProfile(false);
    }
  };

  useEffect(() => {
    onSaveProfileReady?.(saveProfile);
  });

  const discardProfileDraft = (): void => {
    const baseline = profileBaseline.current;
    setProfileDraft(baseline);
    setCreatingProfile(false);
    setProfileError(undefined);
    onDirtyChange?.(false);
  };

  useEffect(() => {
    onDiscardProfileReady?.(discardProfileDraft);
  });

  const performSelectProfile = async (id: string): Promise<void> => {
    const selected = profiles.find((profile) => profile.id === id);
    if (selected === undefined) return;
    const previousDraft = profileDraft;
    const previousBaseline = profileBaseline.current;
    const draftGeneration = profileDraftGeneration.current;
    setCreatingProfile(false);
    setProfileError(undefined);
    const next = profileDraftFor(selected);
    try {
      await requestJson("/v1/profiles/select", {
        method: "POST",
        body: { id },
      });
      onProfileSwitchStart?.();
      if (profileDraftGeneration.current === draftGeneration) {
        profileBaseline.current = next;
        setProfileDraft(next);
      }
      await onWorkspaceReload();
    } catch (cause: unknown) {
      if (profileDraftGeneration.current === draftGeneration) {
        profileBaseline.current = previousBaseline;
        setProfileDraft(previousDraft);
        onDirtyChange?.(
          JSON.stringify(previousDraft) !== JSON.stringify(previousBaseline),
        );
      }
      setProfileError(
        cause instanceof Error
          ? cause.message
          : "Patchdesk could not switch profiles.",
      );
    }
  };

  const selectProfile = (id: string): void => {
    const proceed = (): void => {
      void performSelectProfile(id);
    };
    if (profileDirty) onProfileSwitchRequest?.(id, proceed);
    else proceed();
  };

  const updateProfileList = (
    field: ProfileListField,
    index: number,
    value: string,
  ): void => {
    updateProfileDraft((current) => ({
      ...current,
      [field]: current[field].map((entry, entryIndex) =>
        entryIndex === index ? value : entry,
      ),
    }));
  };

  const addProfileListEntry = (field: ProfileListField): void => {
    updateProfileDraft((current) => ({
      ...current,
      [field]: [...current[field], ""],
    }));
  };

  const removeProfileListEntry = (
    field: ProfileListField,
    index: number,
  ): void => {
    updateProfileDraft((current) => ({
      ...current,
      [field]: current[field].filter((_, entryIndex) => entryIndex !== index),
    }));
  };

  const chooseWorkspaceRoot = async (index: number): Promise<void> => {
    const selected = await selectDirectory(profileDraft.workspaceRoots[index]);
    if (selected === undefined) return;
    updateProfileList("workspaceRoots", index, selected);
  };

  const startNewProfile = (): void => {
    setCreatingProfile(true);
    setProfileError(undefined);
    const next = profileDraftFor(undefined);
    profileBaseline.current = next;
    updateProfileDraft(next);
  };

  const runCleanup = async (): Promise<void> => {
    if (cleanupAction === undefined) return;
    if (dashboard?.profile.id === undefined) {
      setCleanupError(
        "Choose a workspace profile before clearing its local data.",
      );
      return;
    }
    setCleanupPending(true);
    setCleanupError(undefined);
    try {
      await requestJson(
        cleanupAction === "cache"
          ? "/v1/storage/cache/clear"
          : "/v1/storage/clear-local-data",
        {
          method: "POST",
          body: { profileId: dashboard.profile.id },
        },
      );
      await onWorkspaceReload();
      setCleanupAction(undefined);
      onCleanupSuccess?.(cleanupAction);
    } catch {
      setCleanupError(
        cleanupAction === "cache"
          ? "Could not clear cache. Try again."
          : "Could not clear local review data. Try again.",
      );
    } finally {
      setCleanupPending(false);
    }
  };

  const loadActivity = async (): Promise<void> => {
    if (dashboard?.profile.id === undefined) return;
    setActivityError(undefined);
    try {
      const value = await requestJson(
        `/v1/diagnostics?profileId=${encodeURIComponent(dashboard.profile.id)}`,
      );
      if (!record(value) || !Array.isArray(value.events))
        throw new Error("invalid_activity");
      const events = value.events.filter(isActivityEvent).slice(-40).reverse();
      setActivity(events);
    } catch {
      setActivity(undefined);
      setActivityError("Could not load local activity. Try again.");
    }
  };

  if (section === "review") {
    return <ReviewPreferences profileId={dashboard?.profile.id} />;
  }

  if (section === "logs") {
    return <LogsPanel />;
  }

  if (section === "workspace") {
    return (
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
              <CardDescription>
                The active GitHub account and profile details for this
                workspace.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <FieldGroup className="gap-4">
                <Field>
                  <FieldLabel htmlFor="active-profile">
                    Active profile
                  </FieldLabel>
                  <Select
                    value={dashboard?.profile.id ?? profileDraft.id}
                    items={profiles.map((profile) => ({
                      label: profile.label,
                      value: profile.id,
                    }))}
                    onValueChange={(value) => {
                      if (value !== null) selectProfile(value);
                    }}
                  >
                    <SelectTrigger
                      id="active-profile"
                      aria-label="Active profile"
                    >
                      <SelectValue placeholder="Select a profile">
                        {profileDraft.label}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {profiles.map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>
                          {profile.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={startNewProfile}>
                    <Plus data-icon="inline-start" />
                    New profile
                  </Button>
                  {profileDirty || creatingProfile ? (
                    <Button
                      size="sm"
                      disabled={savingProfile}
                      onClick={() => {
                        void saveProfile();
                      }}
                    >
                      {savingProfile ? "Saving profile…" : "Save profile"}
                    </Button>
                  ) : null}
                </div>
                <FieldGroup className="grid gap-4 sm:grid-cols-2">
                  <Field className="sm:col-span-2">
                    <FieldLabel htmlFor="profile-id">Profile ID</FieldLabel>
                    <Input
                      id="profile-id"
                      aria-label="Profile ID"
                      value={profileDraft.id}
                      disabled={!creatingProfile}
                      onChange={(event) =>
                        updateProfileDraft((current) => ({
                          ...current,
                          id: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="profile-label">Label</FieldLabel>
                    <Input
                      id="profile-label"
                      aria-label="Label"
                      value={profileDraft.label}
                      onChange={(event) =>
                        updateProfileDraft((current) => ({
                          ...current,
                          label: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="profile-gh-account">
                      GitHub account
                    </FieldLabel>
                    <Input
                      id="profile-gh-account"
                      aria-label="GitHub account"
                      value={profileDraft.ghAccount}
                      onChange={(event) =>
                        updateProfileDraft((current) => ({
                          ...current,
                          ghAccount: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <Field className="sm:col-span-2">
                    <FieldLabel htmlFor="profile-github-host">
                      GitHub host
                    </FieldLabel>
                    <Input
                      id="profile-github-host"
                      aria-label="GitHub host"
                      value={profileDraft.githubHost}
                      onChange={(event) =>
                        updateProfileDraft((current) => ({
                          ...current,
                          githubHost: event.target.value,
                        }))
                      }
                    />
                  </Field>
                </FieldGroup>
              </FieldGroup>
              {profileError === undefined ? null : (
                <p role="alert" className="text-sm text-destructive">
                  {profileError}
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Workspace scope</CardTitle>
              <CardDescription>
                Where Patchdesk looks for repositories and the rules that apply.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <ProfileListEditor
                label="Workspace roots"
                field="workspaceRoots"
                entries={profileDraft.workspaceRoots}
                placeholder="/absolute/workspace/path"
                onChange={updateProfileList}
                onAdd={addProfileListEntry}
                onRemove={removeProfileListEntry}
                onChoose={(index) => {
                  void chooseWorkspaceRoot(index);
                }}
              />
              <ProfileListEditor
                label="Owner filters"
                field="ownerFilters"
                entries={profileDraft.ownerFilters}
                placeholder="github-owner"
                onChange={updateProfileList}
                onAdd={addProfileListEntry}
                onRemove={removeProfileListEntry}
              />
              <ProfileListEditor
                label="Rule paths"
                field="rulePaths"
                entries={profileDraft.rulePaths}
                placeholder="/absolute/path/to/AGENTS.md"
                onChange={updateProfileList}
                onAdd={addProfileListEntry}
                onRemove={removeProfileListEntry}
              />
            </CardContent>
          </Card>
        </div>
        <WatchlistPanel
          profile={
            dashboard?.profile ?? {
              id: "",
              label: "",
              githubHost: "github.com",
              ghAccount: "",
            }
          }
          onWorkspaceReload={onWorkspaceReload}
        />
      </div>
    );
  }

  if (section === "data") {
    return (
      <>
        <Card data-testid="local-review-data-card">
          <CardHeader>
            <CardTitle>Local review data</CardTitle>
            <CardDescription>
              Two workspace actions, ordered by severity. Confirmations state
              what stays and what goes.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Alert>
              <AlertTitle>Stored reviews stay readable</AlertTitle>
              <AlertDescription>
                Clear cache keeps review history. Clear local review data
                removes completed and failed local reviews; an active review and
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
                  setCleanupError(undefined);
                  setCleanupAction("cache");
                }}
              >
                Clear cache
              </Button>
              <Button
                variant="outline"
                disabled={!cleanupAvailable}
                data-testid="clear-local-data-button"
                onClick={() => {
                  setCleanupError(undefined);
                  setCleanupAction("local");
                }}
              >
                Clear local review data
              </Button>
            </div>
            {cleanupError === undefined ? null : (
              <Alert variant="destructive">
                <AlertTitle>Cleanup failed</AlertTitle>
                <AlertDescription role="alert">{cleanupError}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
        <Card data-testid="review-activity-card">
          <CardHeader>
            <CardTitle>Review activity</CardTitle>
            <CardDescription>
              Redacted local milestones for review and walkthrough runs.
              Patchdesk never shows prompts, tokens, paths, or provider output.
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
            {activityError === undefined ? null : (
              <Alert variant="destructive">
                <AlertTitle>Activity unavailable</AlertTitle>
                <AlertDescription role="alert">
                  {activityError}
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
                {activity.map((event, index) => (
                  <li
                    key={`${event.at}-${event.phase}-${index}`}
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
                      <p className="mt-1 text-muted-foreground">
                        {event.detail}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
        <CleanupConfirmation
          action={cleanupAction}
          pending={cleanupPending}
          error={cleanupError}
          onCancel={() => {
            if (!cleanupPending) setCleanupAction(undefined);
          }}
          onConfirm={() => {
            void runCleanup();
          }}
        />
      </>
    );
  }

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
                  onDiffThemeChange({ ...diffThemePreferences, light: value });
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
        const piModels = catalog.models
          .filter((candidate) => candidate.provider === "pi")
          .map((candidate) => ({ id: candidate.id, label: candidate.label }));
        const model = selectedModel(piModels, piModels[0]?.id, saved.model);
        setModels(piModels);
        const next = {
          model: model ?? saved.model,
          reasoning: saved.reasoning,
        };
        setPreference(next);
        setCatalogUnavailable(false);
        if (
          profileId !== undefined &&
          model !== undefined &&
          saved.model !== model
        )
          saveReviewExecutionPreference(profileId, next);
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
    readonly reasoning: ReviewReasoningPreference;
  }): void => {
    setPreference(next);
    if (profileId !== undefined) saveReviewExecutionPreference(profileId, next);
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
                if (value === "low" || value === "medium" || value === "high")
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
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
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

function preferenceFor(profileId: string | undefined): {
  readonly model: string;
  readonly reasoning: ReviewReasoningPreference;
} {
  return profileId === undefined
    ? { model: "pi-design", reasoning: "medium" }
    : (loadReviewExecutionPreference(profileId) ?? {
        model: "pi-design",
        reasoning: "medium",
      });
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

type ProfileListField = "workspaceRoots" | "ownerFilters" | "rulePaths";

function profileDraftFor(profile: Profile | undefined): ProfileDraft {
  return {
    id: profile?.id ?? "",
    label: profile?.label ?? "",
    githubHost: profile?.githubHost ?? "github.com",
    ghAccount: profile?.ghAccount ?? "",
    workspaceRoots:
      profile === undefined ? [""] : (profile.workspaceRoots ?? []),
    ownerFilters: profile === undefined ? [""] : (profile.ownerFilters ?? []),
    rulePaths: profile?.rulePaths ?? [],
  };
}

function profileDraftFromNormalized(profile: {
  readonly id: string;
  readonly label: string;
  readonly githubHost: string;
  readonly ghAccount: string;
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly ownerFilters: ReadonlyArray<string>;
  readonly rulePaths: ReadonlyArray<string>;
}): ProfileDraft {
  return { ...profile };
}

function normalizeProfileDraft(draft: ProfileDraft):
  | {
      readonly id: string;
      readonly label: string;
      readonly githubHost: string;
      readonly ghAccount: string;
      readonly workspaceRoots: ReadonlyArray<string>;
      readonly ownerFilters: ReadonlyArray<string>;
      readonly rulePaths: ReadonlyArray<string>;
    }
  | string {
  const workspaceRoots = trimEntries(draft.workspaceRoots, "Workspace roots");
  if (typeof workspaceRoots === "string") return workspaceRoots;
  const ownerFilters = trimEntries(draft.ownerFilters, "Owner filters");
  if (typeof ownerFilters === "string") return ownerFilters;
  const rulePaths = trimEntries(draft.rulePaths, "Rule paths");
  if (typeof rulePaths === "string") return rulePaths;
  return {
    id: draft.id.trim(),
    label: draft.label.trim(),
    githubHost: draft.githubHost.trim(),
    ghAccount: draft.ghAccount.trim(),
    workspaceRoots,
    ownerFilters,
    rulePaths,
  };
}

function trimEntries(
  entries: ReadonlyArray<string>,
  label: string,
): ReadonlyArray<string> | string {
  const trimmed = entries.map((entry) => entry.trim());
  return trimmed.some((entry) => entry.length === 0)
    ? `${label} cannot contain blank entries.`
    : trimmed;
}

function ProfileListEditor({
  label,
  field,
  entries,
  placeholder,
  onChange,
  onAdd,
  onRemove,
  onChoose,
}: {
  readonly label: string;
  readonly field: ProfileListField;
  readonly entries: ReadonlyArray<string>;
  readonly placeholder: string;
  readonly onChange: (
    field: ProfileListField,
    index: number,
    value: string,
  ) => void;
  readonly onAdd: (field: ProfileListField) => void;
  readonly onRemove: (field: ProfileListField, index: number) => void;
  readonly onChoose?: (index: number) => void;
}): React.JSX.Element {
  const singular = label.slice(0, -1).toLowerCase();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex flex-col gap-2 rounded-lg border p-2">
        {entries.map((entry, index) => (
          <div
            key={`${field}-${index + 1}`}
            className="flex min-w-0 items-center gap-2"
          >
            <Input
              aria-label={`${singular} ${index + 1}`}
              value={entry}
              placeholder={placeholder}
              onChange={(event) => onChange(field, index, event.target.value)}
            />
            {onChoose === undefined ? null : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onChoose(index)}
              >
                <FolderOpen data-icon="inline-start" />
                Choose folder
              </Button>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    aria-label={`Remove ${singular} ${index + 1}`}
                    onClick={() => onRemove(field, index)}
                  />
                }
              >
                <X />
              </TooltipTrigger>
              <TooltipContent>{`Remove ${singular}`}</TooltipContent>
            </Tooltip>
          </div>
        ))}
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onAdd(field)}
        className="w-fit"
      >
        <Plus data-icon="inline-start" />
        {`Add ${singular}`}
      </Button>
    </fieldset>
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isActivityEvent(value: unknown): value is ActivityEvent {
  return (
    record(value) &&
    typeof value.at === "string" &&
    typeof value.category === "string" &&
    typeof value.phase === "string" &&
    typeof value.retryable === "boolean" &&
    (value.durationMs === undefined || typeof value.durationMs === "number") &&
    (value.detail === undefined || typeof value.detail === "string")
  );
}

function activityLabel(phase: string): string {
  return phase
    .split("-")
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}
