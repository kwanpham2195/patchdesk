import { useEffect, useRef, useState } from "react";
import { requestJson, selectDirectory } from "../api-client";
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
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import type { Dashboard, Profile, Repo } from "../renderer-models";

export type SettingsSection = "general" | "review" | "data";

type ProfileDraft = {
  readonly id: string;
  readonly label: string;
  readonly githubHost: string;
  readonly ghAccount: string;
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly ownerFilters: ReadonlyArray<string>;
  readonly rulePaths: ReadonlyArray<string>;
};

type SettingsFlowProps = {
  readonly dashboard?: Dashboard;
  readonly appearance: AppearancePreference;
  readonly onAppearanceChange: (value: AppearancePreference) => void;
  readonly diffThemePreferences: DiffThemePreferences;
  readonly onDiffThemeChange: (value: DiffThemePreferences) => void;
  readonly profiles: ReadonlyArray<Profile>;
  readonly onWorkspaceReload: () => Promise<void>;
  readonly onRepositoryRefresh?: (value: unknown, repo: Repo) => void;
  readonly section?: SettingsSection;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly onProfileSwitchRequest?: (profileId: string, proceed: () => void) => void;
  readonly onCleanupSuccess?: () => void;
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
  onRepositoryRefresh,
  section = "general",
  onDirtyChange,
  onProfileSwitchRequest,
  onCleanupSuccess,
}: SettingsFlowProps): React.JSX.Element {
  void onRepositoryRefresh;
  const [profileDraft, setProfileDraft] = useState(() => profileDraftFor(dashboard?.profile));
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string>();
  const [savingProfile, setSavingProfile] = useState(false);
  const [environment, setEnvironment] = useState<Record<string, string>>();
  const [githubAccess, setGithubAccess] = useState<string>();
  const [cleanupAction, setCleanupAction] = useState<"cache" | "local">();
  const [cleanupPending, setCleanupPending] = useState(false);
  const [cleanupError, setCleanupError] = useState<string>();
  const profileBaseline = useRef(profileDraft);
  const profileDirty = JSON.stringify(profileDraft) !== JSON.stringify(profileBaseline.current);

  useEffect(() => {
    onDirtyChange?.(profileDirty);
  }, [onDirtyChange, profileDirty]);

  useEffect(() => {
    if (creatingProfile || dashboard === undefined || dashboard.profile.id === profileDraft.id) return;
    const next = profileDraftFor(dashboard.profile);
    profileBaseline.current = next;
    setProfileDraft(next);
  }, [creatingProfile, dashboard, profileDraft.id]);

  useEffect(() => {
    void loadEnvironment();
  }, []);

  const loadEnvironment = async (): Promise<void> => {
    try {
      const value = await requestJson("/v1/environment");
      if (!record(value)) return;
      setEnvironment(
        Object.fromEntries(
          Object.entries(value).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      );
    } catch {
      setEnvironment(undefined);
    }
  };

  const testGitHubAccess = async (): Promise<void> => {
    try {
      const value = await requestJson("/v1/github/access", { method: "POST" });
      if (record(value) && typeof value.state === "string") setGithubAccess(value.state);
    } catch {
      setGithubAccess("unavailable");
    }
  };

  const saveProfile = async (): Promise<void> => {
    setProfileError(undefined);
    const normalized = normalizeProfileDraft(profileDraft);
    if (typeof normalized === "string") {
      setProfileError(normalized);
      return;
    }
    if (creatingProfile && profiles.some((profile) => profile.id === normalized.id)) {
      setProfileError("A profile with this ID already exists.");
      return;
    }
    setSavingProfile(true);
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
      profileBaseline.current = next;
      setProfileDraft(next);
      setCreatingProfile(false);
      onDirtyChange?.(false);
      await onWorkspaceReload();
    } catch (cause: unknown) {
      setProfileError(cause instanceof Error ? cause.message : "Patchdesk could not save the local review state.");
    } finally {
      setSavingProfile(false);
    }
  };

  const performSelectProfile = async (id: string): Promise<void> => {
    const selected = profiles.find((profile) => profile.id === id);
    if (selected === undefined) return;
    setCreatingProfile(false);
    setProfileError(undefined);
    const next = profileDraftFor(selected);
    profileBaseline.current = next;
    setProfileDraft(next);
    await requestJson("/v1/profiles/select", { method: "POST", body: { id } });
    await onWorkspaceReload();
  };

  const selectProfile = (id: string): void => {
    const proceed = (): void => {
      void performSelectProfile(id);
    };
    if (profileDirty) onProfileSwitchRequest?.(id, proceed);
    else proceed();
  };

  const updateProfileList = (field: ProfileListField, index: number, value: string): void => {
    setProfileDraft((current) => ({
      ...current,
      [field]: current[field].map((entry, entryIndex) => entryIndex === index ? value : entry),
    }));
  };

  const addProfileListEntry = (field: ProfileListField): void => {
    setProfileDraft((current) => ({ ...current, [field]: [...current[field], ""] }));
  };

  const removeProfileListEntry = (field: ProfileListField, index: number): void => {
    setProfileDraft((current) => ({
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
    setProfileDraft(next);
  };

  const runCleanup = async (): Promise<void> => {
    if (cleanupAction === undefined || dashboard?.profile.id === undefined) return;
    setCleanupPending(true);
    setCleanupError(undefined);
    try {
      await requestJson(cleanupAction === "cache" ? "/v1/storage/cache/clear" : "/v1/storage/clear-local-data", {
        method: "POST",
        body: { profileId: dashboard.profile.id },
      });
      setCleanupAction(undefined);
      await onWorkspaceReload();
      onCleanupSuccess?.();
    } catch {
      setCleanupError(cleanupAction === "cache" ? "Could not clear cache. Try again." : "Could not clear local review data. Try again.");
    } finally {
      setCleanupPending(false);
    }
  };

  if (section === "review") {
    return (
      <ReviewPreferences profileId={dashboard?.profile.id} />
    );
  }

  if (section === "data") {
    return (
      <>
        <Card data-testid="local-review-data-card">
          <CardHeader>
            <CardTitle>Local review data</CardTitle>
            <CardDescription>Two global actions, ordered by severity. Confirmations state what stays and what goes.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Alert>
              <AlertTitle>Stored reviews stay readable</AlertTitle>
              <AlertDescription>Reviews you can still open, resume, retry, or prepare remain on this Mac until you remove them yourself.</AlertDescription>
            </Alert>
            <div className="flex flex-col gap-2">
              <Button variant="outline" onClick={() => { setCleanupError(undefined); setCleanupAction("cache"); }}>Clear cache</Button>
              <Button variant="outline" data-testid="clear-local-data-button" onClick={() => { setCleanupError(undefined); setCleanupAction("local"); }}>Clear local review data</Button>
            </div>
            {cleanupError === undefined ? null : <Alert variant="destructive"><AlertTitle>Cleanup failed</AlertTitle><AlertDescription role="alert">{cleanupError}</AlertDescription></Alert>}
          </CardContent>
        </Card>
        <CleanupConfirmation
          action={cleanupAction}
          pending={cleanupPending}
          error={cleanupError}
          onCancel={() => { if (!cleanupPending) setCleanupAction(undefined); }}
          onConfirm={() => { void runCleanup(); }}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Follow the system setting, or keep Patchdesk in light or dark mode.</CardDescription>
        </CardHeader>
        <CardContent>
          <Label className="grid gap-1.5">Theme
            <Select value={appearance} onValueChange={(value) => { if (value === "system" || value === "light" || value === "dark") onAppearanceChange(value); }}>
              <SelectTrigger aria-label="Appearance"><SelectValue /></SelectTrigger>
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
        <CardHeader><CardTitle>Diff theme</CardTitle><CardDescription>Choose the Pierre theme used for light and dark appearance.</CardDescription></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Label className="grid gap-1.5">Light appearance
            <Select value={diffThemePreferences.light} onValueChange={(value) => { if (value !== null && DIFF_LIGHT_THEMES.some((theme) => theme.id === value)) onDiffThemeChange({ ...diffThemePreferences, light: value }); }}>
              <SelectTrigger aria-label="Light diff theme"><SelectValue /></SelectTrigger>
              <SelectContent>{DIFF_LIGHT_THEMES.map((theme) => <SelectItem key={theme.id} value={theme.id}>{theme.label}</SelectItem>)}</SelectContent>
            </Select>
          </Label>
          <Label className="grid gap-1.5">Dark appearance
            <Select value={diffThemePreferences.dark} onValueChange={(value) => { if (value !== null && DIFF_DARK_THEMES.some((theme) => theme.id === value)) onDiffThemeChange({ ...diffThemePreferences, dark: value }); }}>
              <SelectTrigger aria-label="Dark diff theme"><SelectValue /></SelectTrigger>
              <SelectContent>{DIFF_DARK_THEMES.map((theme) => <SelectItem key={theme.id} value={theme.id}>{theme.label}</SelectItem>)}</SelectContent>
            </Select>
          </Label>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Workspace profile</CardTitle><CardDescription>GitHub reads and configured workspace and rule paths are scoped to the selected profile.</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Label>Active profile
            <Select value={dashboard?.profile.id ?? profileDraft.id} onValueChange={(value) => { if (value !== null) selectProfile(value); }}>
              <SelectTrigger aria-label="Active profile"><SelectValue placeholder="Select a profile" /></SelectTrigger>
              <SelectContent>{profiles.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.label}</SelectItem>)}</SelectContent>
            </Select>
          </Label>
          <Button variant="outline" onClick={startNewProfile}>New profile</Button>
          {([ ["Profile ID", "id"], ["Label", "label"], ["GitHub host", "githubHost"], ["GitHub account", "ghAccount"] ] as const).map(([label, field]) => (
            <Label key={field}>{label}
              <Input className="mt-1.5" aria-label={label} value={profileDraft[field]} disabled={field === "id" && !creatingProfile} onChange={(event) => setProfileDraft((current) => ({ ...current, [field]: event.target.value }))} />
            </Label>
          ))}
          <ProfileListEditor label="Workspace roots" field="workspaceRoots" entries={profileDraft.workspaceRoots} placeholder="/absolute/workspace/path" onChange={updateProfileList} onAdd={addProfileListEntry} onRemove={removeProfileListEntry} onChoose={(index) => { void chooseWorkspaceRoot(index); }} />
          <ProfileListEditor label="Owner filters" field="ownerFilters" entries={profileDraft.ownerFilters} placeholder="github-owner" onChange={updateProfileList} onAdd={addProfileListEntry} onRemove={removeProfileListEntry} />
          <ProfileListEditor label="Rule paths" field="rulePaths" entries={profileDraft.rulePaths} placeholder="/absolute/path/to/AGENTS.md" onChange={updateProfileList} onAdd={addProfileListEntry} onRemove={removeProfileListEntry} />
          {profileError === undefined ? null : <p role="alert" className="text-sm text-destructive">{profileError}</p>}
          <Button disabled={savingProfile} onClick={() => { void saveProfile(); }}>{savingProfile ? "Saving profile…" : "Save profile"}</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Environment diagnostics</CardTitle><CardDescription>Readiness only; Patchdesk never displays token values or command output.</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { void loadEnvironment(); }}>Check environment</Button><Button variant="outline" onClick={() => { void testGitHubAccess(); }}>Test GitHub access</Button></div>
          {githubAccess === undefined ? null : <p className="text-sm" role="status">GitHub access: {githubAccess}</p>}
          {environment === undefined ? <p className="text-sm text-muted-foreground">Loading safe environment diagnostics.</p> : <div className="grid grid-cols-2 gap-2 text-sm">{Object.entries(environment).filter(([name]) => ["productName", "version", "architecture", "distribution"].includes(name)).map(([name, value]) => <div key={name} className="rounded-md border p-2"><dt className="text-muted-foreground">{name}</dt><dd>{value}</dd></div>)}</div>}
        </CardContent>
      </Card>
    </div>
  );
}

function ReviewPreferences({ profileId }: { readonly profileId: string | undefined }): React.JSX.Element {
  const [preference, setPreference] = useState(() => profileId === undefined ? { model: "pi-design", reasoning: "medium" as ReviewReasoningPreference } : loadReviewExecutionPreference(profileId) ?? { model: "pi-design", reasoning: "medium" as ReviewReasoningPreference });
  useEffect(() => {
    setPreference(profileId === undefined ? { model: "pi-design", reasoning: "medium" } : loadReviewExecutionPreference(profileId) ?? { model: "pi-design", reasoning: "medium" });
  }, [profileId]);
  const update = (next: { readonly model: string; readonly reasoning: ReviewReasoningPreference }): void => {
    setPreference(next);
    if (profileId !== undefined) saveReviewExecutionPreference(profileId, next);
  };
  return <Card data-testid="settings-section-review"><CardHeader><CardTitle>Review preferences</CardTitle><CardDescription>Profile-scoped defaults for the next review run. They never start work.</CardDescription></CardHeader><CardContent className="flex flex-col gap-3"><Label>Default model<Input aria-label="Default model" value={preference.model} onChange={(event) => update({ ...preference, model: event.target.value })} /></Label><Label>Default reasoning<Select value={preference.reasoning} onValueChange={(value) => { if (value === "low" || value === "medium" || value === "high") update({ ...preference, reasoning: value }); }}><SelectTrigger aria-label="Default reasoning"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="low">Low</SelectItem><SelectItem value="medium">Medium</SelectItem><SelectItem value="high">High</SelectItem></SelectContent></Select></Label></CardContent></Card>;
}

function CleanupConfirmation({ action, pending, error, onCancel, onConfirm }: { readonly action: "cache" | "local" | undefined; readonly pending: boolean; readonly error: string | undefined; readonly onCancel: () => void; readonly onConfirm: () => void }): React.JSX.Element {
  if (action === undefined) return <></>;
  const local = action === "local";
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent data-testid={`cleanup-dialog-${local ? "clear_local_review_data" : "clear_cache"}`} aria-busy={pending}>
        <AlertDialogHeader>
          <AlertDialogTitle>{local ? "Clear local review data?" : "Clear cache?"}</AlertDialogTitle>
          <AlertDialogDescription>{local ? "This removes discarded and unusable local review data. Reviews you can still open or resume, and diagnostic reports, stay." : "This removes rebuildable local files. Your saved reviews and diagnostic reports stay."}</AlertDialogDescription>
        </AlertDialogHeader>
        {error === undefined ? null : <Alert variant="destructive"><AlertTitle>Cleanup failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={local ? "destructive" : "default"} disabled={pending} onClick={(event) => { event.preventDefault(); onConfirm(); }}>{local ? "Clear local data" : "Clear cache"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type ProfileListField = "workspaceRoots" | "ownerFilters" | "rulePaths";

function profileDraftFor(profile: Profile | undefined): ProfileDraft {
  return { id: profile?.id ?? "", label: profile?.label ?? "", githubHost: profile?.githubHost ?? "github.com", ghAccount: profile?.ghAccount ?? "", workspaceRoots: profile === undefined ? [""] : (profile.workspaceRoots ?? []), ownerFilters: profile === undefined ? [""] : (profile.ownerFilters ?? []), rulePaths: profile?.rulePaths ?? [] };
}

function profileDraftFromNormalized(profile: { readonly id: string; readonly label: string; readonly githubHost: string; readonly ghAccount: string; readonly workspaceRoots: ReadonlyArray<string>; readonly ownerFilters: ReadonlyArray<string>; readonly rulePaths: ReadonlyArray<string> }): ProfileDraft {
  return { ...profile };
}

function normalizeProfileDraft(draft: ProfileDraft): { readonly id: string; readonly label: string; readonly githubHost: string; readonly ghAccount: string; readonly workspaceRoots: ReadonlyArray<string>; readonly ownerFilters: ReadonlyArray<string>; readonly rulePaths: ReadonlyArray<string> } | string {
  const workspaceRoots = trimEntries(draft.workspaceRoots, "Workspace roots");
  if (typeof workspaceRoots === "string") return workspaceRoots;
  const ownerFilters = trimEntries(draft.ownerFilters, "Owner filters");
  if (typeof ownerFilters === "string") return ownerFilters;
  const rulePaths = trimEntries(draft.rulePaths, "Rule paths");
  if (typeof rulePaths === "string") return rulePaths;
  return { id: draft.id.trim(), label: draft.label.trim(), githubHost: draft.githubHost.trim(), ghAccount: draft.ghAccount.trim(), workspaceRoots, ownerFilters, rulePaths };
}

function trimEntries(entries: ReadonlyArray<string>, label: string): ReadonlyArray<string> | string {
  const trimmed = entries.map((entry) => entry.trim());
  return trimmed.some((entry) => entry.length === 0) ? `${label} cannot contain blank entries.` : trimmed;
}

function ProfileListEditor({ label, field, entries, placeholder, onChange, onAdd, onRemove, onChoose }: { readonly label: string; readonly field: ProfileListField; readonly entries: ReadonlyArray<string>; readonly placeholder: string; readonly onChange: (field: ProfileListField, index: number, value: string) => void; readonly onAdd: (field: ProfileListField) => void; readonly onRemove: (field: ProfileListField, index: number) => void; readonly onChoose?: (index: number) => void }): React.JSX.Element {
  const singular = label.slice(0, -1).toLowerCase();
  return <fieldset className="flex flex-col gap-2"><legend className="text-sm font-medium">{label}</legend>{entries.map((entry, index) => <div key={`${field}-${index + 1}`} className="flex gap-2"><Input aria-label={`${singular} ${index + 1}`} value={entry} placeholder={placeholder} onChange={(event) => onChange(field, index, event.target.value)} />{onChoose === undefined ? null : <Button type="button" variant="outline" onClick={() => onChoose(index)}>{`Choose ${singular} ${index + 1}`}</Button>}<Button type="button" variant="outline" onClick={() => onRemove(field, index)}>{`Remove ${singular} ${index + 1}`}</Button></div>)}<Button type="button" variant="outline" onClick={() => onAdd(field)}>{`Add ${singular}`}</Button></fieldset>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
