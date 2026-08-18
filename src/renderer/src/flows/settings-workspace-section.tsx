import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { ChevronDown, FolderOpen, Plus, X } from "lucide-react";
import { requestJson, selectDirectory } from "../api-client";
import {
  parseDiscoveredRepos,
  parseEnvironmentCheckResponse,
  type DiscoveredRepo,
  type EnvironmentCheckResponse,
  type GithubAuthAccount,
} from "../renderer-contracts";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  repositoryKey,
  type Dashboard,
  type Profile,
  type Repo,
} from "../renderer-models";
import {
  groupWatchlistEntries,
  mergeWatchlistEntries,
  RepositoryChecklist,
  useWatchlistToggle,
  WatchedOutsideRootsSection,
  WatchlistToggleStatus,
  type WatchlistEntry,
} from "./settings-workspace-repositories";

type ProfileDraft = {
  readonly id: string;
  readonly label: string;
  readonly githubHost: string;
  readonly ghAccount: string;
  readonly workspaceRoots: ReadonlyArray<ProfileListEntry>;
  readonly ownerFilters: ReadonlyArray<ProfileListEntry>;
  readonly rulePaths: ReadonlyArray<ProfileListEntry>;
};

type ProfileListEntry = {
  readonly id: string;
  readonly value: string;
};

/** Local state machine for the Reviewing-as panel's `GET /v1/environment` probe, mirroring `inbox-flow.tsx`'s `ToolsCheckState`. */
type ReviewingAsState =
  | { readonly kind: "checking" }
  | { readonly kind: "loaded"; readonly env: EnvironmentCheckResponse }
  | { readonly kind: "error" };

/** Local state machine for the workspace-root discovery scan (`GET /v1/watchlist/suggestions`), scoped to the saved profile since discovery runs server-side against it. */
type RootDiscoveryState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly repos: ReadonlyArray<DiscoveredRepo> }
  | { readonly kind: "error" };

/** What a single workspace-root row shows for its discovery result. */
type RootDiscoveryStatus =
  | { readonly kind: "unsaved" }
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | {
      readonly kind: "found";
      readonly total: number;
      readonly watched: number;
    };

type WorkspaceProfileSectionProps = {
  readonly dashboard: Dashboard | undefined;
  readonly profiles: ReadonlyArray<Profile>;
  readonly onWorkspaceReload: () => Promise<void>;
  /** Whether the Workspace tab is the currently displayed Settings section. The section's hooks and outstanding-save wiring keep running regardless, so switching tabs never loses a draft or drops the Save/Discard callbacks. */
  readonly visible: boolean;
  readonly onProfileDirtyChange: ((dirty: boolean) => void) | undefined;
  readonly onProfileSwitchRequest:
    | ((profileId: string, proceed: () => void) => void)
    | undefined;
  readonly onSaveProfileReady:
    | ((save: () => Promise<boolean>) => void)
    | undefined;
  readonly onDiscardProfileReady: ((discard: () => void) => void) | undefined;
  readonly onProfileSwitchStart: (() => void) | undefined;
};

/**
 * The Workspace settings section: the Reviewing-as probe, the Profile card,
 * and Workspace-scope editing. Kept mounted for the lifetime of the Settings
 * overlay (not just while the Workspace tab is active) so its profile draft,
 * baseline/generation refs, and `onSaveProfileReady`/`onDiscardProfileReady`
 * wiring survive switching to another tab and back; `visible` only decides
 * whether it currently renders its cards.
 */
export function WorkspaceProfileSection({
  dashboard,
  profiles,
  onWorkspaceReload,
  visible,
  onProfileDirtyChange,
  onProfileSwitchRequest,
  onSaveProfileReady,
  onDiscardProfileReady,
  onProfileSwitchStart,
}: WorkspaceProfileSectionProps): React.JSX.Element | null {
  const {
    profileDraft,
    updateProfileDraft,
    creatingProfile,
    profileError,
    savingProfile,
    profileDirty,
    saveProfile,
    selectProfile,
    updateProfileList,
    addProfileListEntry,
    removeProfileListEntry,
    chooseWorkspaceRoot,
    startNewProfile,
  } = useWorkspaceProfileDraft({
    dashboard,
    profiles,
    onWorkspaceReload,
    onProfileDirtyChange,
    onProfileSwitchRequest,
    onSaveProfileReady,
    onDiscardProfileReady,
    onProfileSwitchStart,
  });

  const { reviewingAs, recheck } = useReviewingAsProbe(
    profileDraft.ghAccount,
    updateProfileDraft,
  );

  const rootDiscovery = useWorkspaceRootDiscovery(dashboard?.profile);
  const savedRepos = dashboard?.profile.repos ?? EMPTY_REPOS;
  const savedRoots = dashboard?.profile.workspaceRoots ?? EMPTY_ROOTS;
  const discoveredRepos =
    rootDiscovery.kind === "loaded" ? rootDiscovery.repos : EMPTY_DISCOVERED;
  // The single merge and the single grouping of discovered + watched
  // repositories for this render — replaces what used to be two independent
  // fetch/group pipelines (this hook's own and `WatchlistPanel`'s).
  const watchlistEntries = mergeWatchlistEntries(discoveredRepos, savedRepos);
  const { byRoot, other } = groupWatchlistEntries(watchlistEntries, savedRoots);
  const watchedKeys = new Set(savedRepos.map((repo) => repositoryKey(repo)));
  const isWatched = (entry: WatchlistEntry): boolean =>
    watchedKeys.has(repositoryKey(entry));
  const watchlistToggle = useWatchlistToggle(onWorkspaceReload);
  const handleToggle = (
    entry: WatchlistEntry,
    currentlyWatched: boolean,
  ): void => {
    void watchlistToggle.toggleRepo(entry, currentlyWatched);
  };
  const rootDiscoveryStatus = (root: string): RootDiscoveryStatus =>
    workspaceRootDiscoveryStatus(
      root,
      dashboard?.profile,
      rootDiscovery,
      byRoot,
      isWatched,
    );

  if (!visible) return null;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Reviewing as</CardTitle>
          <CardDescription>
            The GitHub account Patchdesk uses to find and review pull requests,
            resolved from the GitHub CLI.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReviewingAsPanel
            state={reviewingAs}
            profileDraft={profileDraft}
            updateProfileDraft={updateProfileDraft}
            onRecheck={recheck}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>
            The active GitHub account and profile details for this workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="active-profile">Active profile</FieldLabel>
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
                <SelectTrigger id="active-profile" aria-label="Active profile">
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
            </FieldGroup>
          </FieldGroup>
          {profileError === undefined ? null : (
            <p role="alert" className="text-sm text-destructive">
              {profileError}
            </p>
          )}
        </CardContent>
      </Card>
      <section
        aria-labelledby="workspace-scope-title"
        data-testid="workspace-scope"
      >
        <Card>
          <CardHeader>
            <CardTitle id="workspace-scope-title">Workspace scope</CardTitle>
            <CardDescription>
              Where Patchdesk looks for repositories and the rules that apply.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <WatchlistToggleStatus
              error={watchlistToggle.error}
              feedback={watchlistToggle.feedback}
            />
            <ProfileListEditor
              label="Workspace roots"
              field="workspaceRoots"
              entries={profileDraft.workspaceRoots}
              placeholder="/absolute/workspace/path"
              onChange={updateProfileList}
              onAdd={addProfileListEntry}
              onRemove={removeProfileListEntry}
              onChoose={(entryId) => {
                void chooseWorkspaceRoot(entryId);
              }}
              renderStatus={(value) => {
                const status = rootDiscoveryStatus(value);
                const trimmedRoot = value.trim();
                return (
                  <div className="flex flex-col gap-2">
                    <WorkspaceRootDiscoveryStatus status={status} />
                    {status.kind === "found" ? (
                      <RepositoryChecklist
                        entries={byRoot.get(trimmedRoot) ?? EMPTY_ENTRIES}
                        isWatched={isWatched}
                        pending={watchlistToggle.pending}
                        onToggle={handleToggle}
                        ariaLabel={`Repositories under ${trimmedRoot}`}
                      />
                    ) : null}
                  </div>
                );
              }}
            />
            {other.length === 0 ? null : (
              <WatchedOutsideRootsSection
                entries={other}
                isWatched={isWatched}
                pending={watchlistToggle.pending}
                onToggle={handleToggle}
              />
            )}
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
      </section>
    </div>
  );
}

type WorkspaceProfileDraftHook = {
  readonly profileDraft: ProfileDraft;
  readonly updateProfileDraft: (update: SetStateAction<ProfileDraft>) => void;
  readonly creatingProfile: boolean;
  readonly profileError: string | undefined;
  readonly savingProfile: boolean;
  readonly profileDirty: boolean;
  readonly saveProfile: () => Promise<boolean>;
  readonly selectProfile: (id: string) => void;
  readonly updateProfileList: (
    field: ProfileListField,
    entryId: string,
    value: string,
  ) => void;
  readonly addProfileListEntry: (field: ProfileListField) => void;
  readonly removeProfileListEntry: (
    field: ProfileListField,
    entryId: string,
  ) => void;
  readonly chooseWorkspaceRoot: (entryId: string) => Promise<void>;
  readonly startNewProfile: () => void;
};

/**
 * Owns the Workspace section's profile draft: its state, baseline/generation
 * refs, and the save/select/discard handlers. Extracted out of
 * `WorkspaceProfileSection` purely to keep that component's own body short —
 * it isn't reused anywhere else.
 */
function useWorkspaceProfileDraft({
  dashboard,
  profiles,
  onWorkspaceReload,
  onProfileDirtyChange,
  onProfileSwitchRequest,
  onSaveProfileReady,
  onDiscardProfileReady,
  onProfileSwitchStart,
}: {
  readonly dashboard: Dashboard | undefined;
  readonly profiles: ReadonlyArray<Profile>;
  readonly onWorkspaceReload: () => Promise<void>;
  readonly onProfileDirtyChange: ((dirty: boolean) => void) | undefined;
  readonly onProfileSwitchRequest:
    | ((profileId: string, proceed: () => void) => void)
    | undefined;
  readonly onSaveProfileReady:
    | ((save: () => Promise<boolean>) => void)
    | undefined;
  readonly onDiscardProfileReady: ((discard: () => void) => void) | undefined;
  readonly onProfileSwitchStart: (() => void) | undefined;
}): WorkspaceProfileDraftHook {
  const [profileDraft, setProfileDraft] = useState(() =>
    profileDraftFor(dashboard?.profile),
  );
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string>();
  const [savingProfile, setSavingProfile] = useState(false);
  const profileBaseline = useRef(profileDraft);
  const pendingSavedProfile = useRef<
    { readonly id: string; readonly label: string } | undefined
  >(undefined);
  const profileDraftGeneration = useRef(0);
  // A `useCallback` (rather than a plain per-render function) so the
  // reviewing-as adoption effect can list it as a dependency without that
  // dependency being "fresh" on every render.
  const updateProfileDraft = useCallback(
    (update: SetStateAction<ProfileDraft>): void => {
      profileDraftGeneration.current += 1;
      setProfileDraft(update);
      onProfileDirtyChange?.(true);
    },
    [onProfileDirtyChange],
  );
  const profileDirty =
    JSON.stringify(profileDraft) !== JSON.stringify(profileBaseline.current);

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
    if (!normalized.ok) {
      setProfileError(normalized.error);
      return false;
    }
    if (
      creatingProfile &&
      profiles.some((profile) => profile.id === normalized.value.id)
    ) {
      setProfileError("A profile with this ID already exists.");
      return false;
    }
    setSavingProfile(true);
    const draftGeneration = profileDraftGeneration.current;
    try {
      await requestJson("/v1/profiles", {
        method: creatingProfile ? "POST" : "PUT",
        body: normalized.value,
      });
      if (creatingProfile) {
        await requestJson("/v1/profiles/select", {
          method: "POST",
          body: { id: normalized.value.id },
        });
      }
      const next = profileDraftFromNormalized(normalized.value);
      pendingSavedProfile.current = {
        id: normalized.value.id,
        label: normalized.value.label,
      };
      profileBaseline.current = next;
      if (profileDraftGeneration.current === draftGeneration) {
        setProfileDraft(next);
        onProfileDirtyChange?.(false);
      } else {
        onProfileDirtyChange?.(true);
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
    onProfileDirtyChange?.(false);
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
        onProfileDirtyChange?.(false);
      }
      await onWorkspaceReload();
    } catch (cause: unknown) {
      if (profileDraftGeneration.current === draftGeneration) {
        profileBaseline.current = previousBaseline;
        setProfileDraft(previousDraft);
        onProfileDirtyChange?.(
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
    entryId: string,
    value: string,
  ): void => {
    updateProfileDraft((current) => ({
      ...current,
      [field]: current[field].map((entry) =>
        entry.id === entryId ? { ...entry, value } : entry,
      ),
    }));
  };

  const addProfileListEntry = (field: ProfileListField): void => {
    updateProfileDraft((current) => ({
      ...current,
      [field]: [...current[field], profileListEntry("")],
    }));
  };

  const removeProfileListEntry = (
    field: ProfileListField,
    entryId: string,
  ): void => {
    updateProfileDraft((current) => ({
      ...current,
      [field]: current[field].filter((entry) => entry.id !== entryId),
    }));
  };

  const chooseWorkspaceRoot = async (entryId: string): Promise<void> => {
    const entry = profileDraft.workspaceRoots.find(
      (candidate) => candidate.id === entryId,
    );
    if (entry === undefined) return;
    const selected = await selectDirectory(entry.value);
    if (selected === undefined) return;
    updateProfileList("workspaceRoots", entryId, selected);
  };

  const startNewProfile = (): void => {
    setCreatingProfile(true);
    setProfileError(undefined);
    const next = profileDraftFor(undefined);
    profileBaseline.current = next;
    updateProfileDraft(next);
  };

  return {
    profileDraft,
    updateProfileDraft,
    creatingProfile,
    profileError,
    savingProfile,
    profileDirty,
    saveProfile,
    selectProfile,
    updateProfileList,
    addProfileListEntry,
    removeProfileListEntry,
    chooseWorkspaceRoot,
    startNewProfile,
  };
}

type ReviewingAsProbeHook = {
  readonly reviewingAs: ReviewingAsState;
  readonly recheck: () => void;
};

/**
 * Owns the Reviewing-as `GET /v1/environment` probe and the one-time account
 * adoption that follows it. Extracted out of `WorkspaceProfileSection` purely
 * to keep that component's own body short — it isn't reused anywhere else.
 */
function useReviewingAsProbe(
  ghAccount: string,
  updateProfileDraft: (update: SetStateAction<ProfileDraft>) => void,
): ReviewingAsProbeHook {
  const [reviewingAs, setReviewingAs] = useState<ReviewingAsState>({
    kind: "checking",
  });
  const [reviewingAsAttempt, setReviewingAsAttempt] = useState(0);
  const reviewingAsDefaultApplied = useRef(false);

  useEffect(() => {
    let active = true;
    setReviewingAs({ kind: "checking" });
    void (async () => {
      try {
        const value = await requestJson("/v1/environment");
        if (!active) return;
        const parsed = parseEnvironmentCheckResponse(value);
        setReviewingAs(
          parsed === undefined
            ? { kind: "error" }
            : { kind: "loaded", env: parsed },
        );
      } catch {
        if (active) setReviewingAs({ kind: "error" });
      }
    })();
    return () => {
      active = false;
    };
  }, [reviewingAsAttempt]);

  // Defaults the account selection the first time authenticated accounts
  // load, but only when the draft has no account yet — a one-time
  // derivation, guarded so it never overwrites a value the user typed or a
  // loaded profile already carried. With exactly one authenticated account,
  // that account is the adoption target; with several, it's the one `gh`
  // marks `active`.
  useEffect(() => {
    if (reviewingAsDefaultApplied.current) return;
    if (reviewingAs.kind !== "loaded") return;
    const accounts = reviewingAs.env.githubAccounts;
    if (accounts.length === 0) return;
    reviewingAsDefaultApplied.current = true;
    if (ghAccount !== "") return;
    let target: GithubAuthAccount | undefined;
    if (accounts.length === 1) {
      const [account] = accounts;
      target = account;
    } else {
      target = accounts.find((account) => account.active);
    }
    if (target === undefined) return;
    updateProfileDraft((current) => ({
      ...current,
      ghAccount: target.login,
      githubHost: target.host,
    }));
    // `updateProfileDraft` is a `useCallback` in `useWorkspaceProfileDraft`,
    // so listing it here doesn't make this effect re-run on every render;
    // the `reviewingAsDefaultApplied` ref guard above additionally makes the
    // body a no-op after its first application regardless.
  }, [reviewingAs, ghAccount, updateProfileDraft]);

  return {
    reviewingAs,
    recheck: () => setReviewingAsAttempt((value) => value + 1),
  };
}

const EMPTY_ROOTS: ReadonlyArray<string> = [];
const EMPTY_REPOS: ReadonlyArray<Repo> = [];
const EMPTY_DISCOVERED: ReadonlyArray<DiscoveredRepo> = [];
const EMPTY_ENTRIES: ReadonlyArray<WatchlistEntry> = [];

/**
 * Runs the `GET /v1/watchlist/suggestions` scan that
 * `DashboardController.discoverWorkspaceRepos` performs against the *saved*
 * profile's workspace roots (see `WatchlistPanel`, whose request/parse path
 * this mirrors). Re-runs whenever the saved profile's id, workspace roots,
 * or watched repos change — which covers both switching profiles and a
 * successful profile save bringing a newly-typed root into scope, since
 * `onWorkspaceReload` refreshes `dashboard.profile` after either.
 */
function useWorkspaceRootDiscovery(
  savedProfile: Profile | undefined,
): RootDiscoveryState {
  const [state, setState] = useState<RootDiscoveryState>({
    kind: "loading",
  });
  // A JSON key rather than the profile object itself: the dashboard is
  // refetched (and reallocated) on every reload even when nothing this scan
  // cares about changed, and `profileDirty`'s dependency check above uses
  // the same `JSON.stringify` comparison for the same reason.
  const savedKey = JSON.stringify({
    id: savedProfile?.id,
    workspaceRoots: savedProfile?.workspaceRoots,
    repos: savedProfile?.repos,
  });

  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const value = await requestJson("/v1/watchlist/suggestions");
        if (!active) return;
        const parsed = parseDiscoveredRepos(value);
        setState(
          parsed === undefined
            ? { kind: "error" }
            : { kind: "loaded", repos: parsed },
        );
      } catch {
        if (active) setState({ kind: "error" });
      }
    })();
    return () => {
      active = false;
    };
  }, [savedKey]);

  return state;
}

/**
 * Resolves one workspace-root row's discovery status. A root that isn't
 * part of the *saved* profile has never been scanned — discovery runs
 * server-side against the saved profile, not the unsaved draft — so it
 * reports "unsaved" rather than a count of 0, which would be a false
 * negative in exactly the case this panel exists to surface. The "found"
 * count is read off `byRoot`, the single grouping computed once per render
 * in `WorkspaceProfileSection` (via `groupWatchlistEntries`) rather than a
 * second, parallel grouping algorithm.
 */
function workspaceRootDiscoveryStatus(
  root: string,
  savedProfile: Profile | undefined,
  discovery: RootDiscoveryState,
  byRoot: ReadonlyMap<string, ReadonlyArray<WatchlistEntry>>,
  isWatched: (entry: WatchlistEntry) => boolean,
): RootDiscoveryStatus {
  const trimmedRoot = root.trim();
  const savedRoots = savedProfile?.workspaceRoots ?? EMPTY_ROOTS;
  if (!savedRoots.includes(trimmedRoot)) return { kind: "unsaved" };
  if (discovery.kind === "loading") return { kind: "loading" };
  if (discovery.kind === "error") return { kind: "error" };
  const rootEntries = byRoot.get(trimmedRoot) ?? EMPTY_ENTRIES;
  const watchedCount = rootEntries.filter(isWatched).length;
  return { kind: "found", total: rootEntries.length, watched: watchedCount };
}

/** Renders one workspace-root row's discovery result: a count, the explicit zero-found state, a loading state, a failure state, or the unsaved-root affordance. */
function WorkspaceRootDiscoveryStatus({
  status,
}: {
  readonly status: RootDiscoveryStatus;
}): React.JSX.Element | null {
  if (status.kind === "unsaved") {
    return (
      <p className="text-xs text-muted-foreground">
        Save the profile to scan this folder for repositories.
      </p>
    );
  }
  if (status.kind === "loading") {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        Scanning for repositories…
      </p>
    );
  }
  if (status.kind === "error") {
    return (
      <p role="alert" className="text-xs text-destructive">
        Could not scan this folder for repositories.
      </p>
    );
  }
  if (status.total === 0) {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        No git repositories with GitHub remotes found in this folder.
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground" role="status">
      {`${status.total} ${status.total === 1 ? "repository" : "repositories"} found · ${status.watched} watched`}
    </p>
  );
}

type ProfileListField = "workspaceRoots" | "ownerFilters" | "rulePaths";

function profileListEntry(value: string): ProfileListEntry {
  return { id: crypto.randomUUID(), value };
}

function profileListEntries(
  values: ReadonlyArray<string>,
): ReadonlyArray<ProfileListEntry> {
  return values.map(profileListEntry);
}

function profileDraftFor(profile: Profile | undefined): ProfileDraft {
  return {
    id: profile?.id ?? "",
    label: profile?.label ?? "",
    githubHost: profile?.githubHost ?? "github.com",
    ghAccount: profile?.ghAccount ?? "",
    workspaceRoots: profileListEntries(
      profile === undefined ? [""] : (profile.workspaceRoots ?? []),
    ),
    ownerFilters: profileListEntries(
      profile === undefined ? [""] : (profile.ownerFilters ?? []),
    ),
    rulePaths: profileListEntries(profile?.rulePaths ?? []),
  };
}

type NormalizedProfile = {
  readonly id: string;
  readonly label: string;
  readonly githubHost: string;
  readonly ghAccount: string;
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly ownerFilters: ReadonlyArray<string>;
  readonly rulePaths: ReadonlyArray<string>;
};

/** A domain-level success/failure result, so callers branch on `.ok` instead of a runtime `typeof` check against the success shape. */
type NormalizeProfileResult =
  | { readonly ok: true; readonly value: NormalizedProfile }
  | { readonly ok: false; readonly error: string };

type TrimEntriesResult =
  | { readonly ok: true; readonly values: ReadonlyArray<string> }
  | { readonly ok: false; readonly error: string };

function profileDraftFromNormalized(profile: NormalizedProfile): ProfileDraft {
  return {
    ...profile,
    workspaceRoots: profileListEntries(profile.workspaceRoots),
    ownerFilters: profileListEntries(profile.ownerFilters),
    rulePaths: profileListEntries(profile.rulePaths),
  };
}

function normalizeProfileDraft(draft: ProfileDraft): NormalizeProfileResult {
  const workspaceRoots = trimEntries(
    draft.workspaceRoots.map((entry) => entry.value),
    "Workspace roots",
  );
  if (!workspaceRoots.ok) return workspaceRoots;
  const ownerFilters = trimEntries(
    draft.ownerFilters.map((entry) => entry.value),
    "Owner filters",
  );
  if (!ownerFilters.ok) return ownerFilters;
  const rulePaths = trimEntries(
    draft.rulePaths.map((entry) => entry.value),
    "Rule paths",
  );
  if (!rulePaths.ok) return rulePaths;
  return {
    ok: true,
    value: {
      id: draft.id.trim(),
      label: draft.label.trim(),
      githubHost: draft.githubHost.trim(),
      ghAccount: draft.ghAccount.trim(),
      workspaceRoots: workspaceRoots.values,
      ownerFilters: ownerFilters.values,
      rulePaths: rulePaths.values,
    },
  };
}

function trimEntries(
  entries: ReadonlyArray<string>,
  label: string,
): TrimEntriesResult {
  const trimmed = entries.map((entry) => entry.trim());
  return trimmed.some((entry) => entry.length === 0)
    ? { ok: false, error: `${label} cannot contain blank entries.` }
    : { ok: true, values: trimmed };
}

/** One resolved shape the Reviewing-as panel renders, derived from the raw fetch state plus what `gh` reported. */
type ReviewingAsView =
  | { readonly kind: "checking" }
  | { readonly kind: "error" }
  | { readonly kind: "failed"; readonly env: EnvironmentCheckResponse }
  | { readonly kind: "single"; readonly account: GithubAuthAccount }
  | {
      readonly kind: "multiple";
      readonly accounts: ReadonlyArray<GithubAuthAccount>;
    };

function reviewingAsView(state: ReviewingAsState): ReviewingAsView {
  if (state.kind !== "loaded") return { kind: state.kind };
  const { env } = state;
  const accounts = env.githubAccounts;
  if (
    accounts.length === 0 ||
    env.githubAuth === "authentication_required" ||
    env.githubAuth === "unavailable"
  )
    return { kind: "failed", env };
  if (accounts.length === 1) {
    const [account] = accounts;
    if (account !== undefined) return { kind: "single", account };
  }
  return { kind: "multiple", accounts };
}

function accountKey(account: GithubAuthAccount): string {
  return `${account.host}/${account.login}`;
}

/**
 * True when the profile's configured account is set but `gh` doesn't report
 * it among the authenticated accounts — the profile would fail every GitHub
 * read at review time (see `GitHubCliCredentials.environmentFor`), and this
 * panel needs to say so instead of silently showing a placeholder or a
 * misleading "Reviewing as" statement.
 */
function isConfiguredAccountUnauthenticated(
  accounts: ReadonlyArray<GithubAuthAccount>,
  profileDraft: ProfileDraft,
): boolean {
  if (profileDraft.ghAccount === "") return false;
  return !accounts.some(
    (account) =>
      account.login === profileDraft.ghAccount &&
      account.host === profileDraft.githubHost,
  );
}

/**
 * Replaces the free-text `GitHub account` field with a resolved fact: the
 * account(s) `gh auth status` actually reports as authenticated, so the
 * offered values are exactly the values that authenticate (see the
 * "Reviewing as" design in the workspace-settings guided-setup spec). Manual
 * entry — the enterprise-host escape hatch — stays available behind a
 * disclosure in the two authenticated states, and directly (unblocked, not
 * gated) whenever the probe itself is still loading or failed to parse.
 */
function ReviewingAsPanel({
  state,
  profileDraft,
  updateProfileDraft,
  onRecheck,
}: {
  readonly state: ReviewingAsState;
  readonly profileDraft: ProfileDraft;
  readonly updateProfileDraft: (update: SetStateAction<ProfileDraft>) => void;
  readonly onRecheck: () => void;
}): React.JSX.Element {
  const view = reviewingAsView(state);
  const configuredAccounts: ReadonlyArray<GithubAuthAccount> =
    view.kind === "single"
      ? [view.account]
      : view.kind === "multiple"
        ? view.accounts
        : [];
  const configuredAccountUnauthenticated =
    (view.kind === "single" || view.kind === "multiple") &&
    isConfiguredAccountUnauthenticated(configuredAccounts, profileDraft);
  return (
    <div className="flex flex-col gap-4">
      {view.kind === "checking" ? (
        <p className="text-sm text-muted-foreground">
          Checking GitHub authentication…
        </p>
      ) : view.kind === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          Could not check GitHub authentication.
        </p>
      ) : view.kind === "failed" ? (
        <p role="alert" className="text-sm text-destructive">
          {view.env.gh !== "ready" ? (
            "GitHub CLI (gh) is not installed. Install the GitHub CLI, then re-check."
          ) : (
            <>
              Not authenticated. Run <code>gh auth login</code>, then re-check.
            </>
          )}
        </p>
      ) : view.kind === "single" ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            Reviewing as <strong>{view.account.login}</strong> on{" "}
            <em>{view.account.host}</em>, from the GitHub CLI.
          </p>
          <AccountDisclosure
            profileDraft={profileDraft}
            updateProfileDraft={updateProfileDraft}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <AccountSelect
            accounts={view.accounts}
            profileDraft={profileDraft}
            updateProfileDraft={updateProfileDraft}
          />
          <AccountDisclosure
            profileDraft={profileDraft}
            updateProfileDraft={updateProfileDraft}
          />
        </div>
      )}
      {configuredAccountUnauthenticated ? (
        <Alert variant="destructive">
          <AlertTitle>Configured account not authenticated</AlertTitle>
          <AlertDescription role="alert">
            This profile is set to review as{" "}
            <strong>{profileDraft.ghAccount}</strong> on{" "}
            <em>{profileDraft.githubHost}</em>, but the GitHub CLI does not
            report that account as authenticated. Choose one of the
            authenticated accounts above, or authenticate that account and
            re-check.
          </AlertDescription>
        </Alert>
      ) : null}
      {view.kind === "checking" || view.kind === "error" ? (
        <ManualAccountFields
          profileDraft={profileDraft}
          updateProfileDraft={updateProfileDraft}
        />
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={onRecheck}
      >
        Re-check
      </Button>
    </div>
  );
}

function AccountSelect({
  accounts,
  profileDraft,
  updateProfileDraft,
}: {
  readonly accounts: ReadonlyArray<GithubAuthAccount>;
  readonly profileDraft: ProfileDraft;
  readonly updateProfileDraft: (update: SetStateAction<ProfileDraft>) => void;
}): React.JSX.Element {
  const selected = accounts.find(
    (account) =>
      account.login === profileDraft.ghAccount &&
      account.host === profileDraft.githubHost,
  );
  return (
    <Field>
      <FieldLabel htmlFor="reviewing-as-account">Account</FieldLabel>
      <Select
        value={selected === undefined ? null : accountKey(selected)}
        items={accounts.map((account) => ({
          label: `${account.login} · ${account.host}`,
          value: accountKey(account),
        }))}
        onValueChange={(value) => {
          const chosen = accounts.find(
            (account) => accountKey(account) === value,
          );
          if (chosen === undefined) return;
          updateProfileDraft((current) => ({
            ...current,
            ghAccount: chosen.login,
            githubHost: chosen.host,
          }));
        }}
      >
        <SelectTrigger
          id="reviewing-as-account"
          aria-label="Reviewing as account"
        >
          <SelectValue placeholder="Select an account" />
        </SelectTrigger>
        <SelectContent>
          {accounts.map((account) => (
            <SelectItem key={accountKey(account)} value={accountKey(account)}>
              {`${account.login} · ${account.host}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function AccountDisclosure({
  profileDraft,
  updateProfileDraft,
}: {
  readonly profileDraft: ProfileDraft;
  readonly updateProfileDraft: (update: SetStateAction<ProfileDraft>) => void;
}): React.JSX.Element {
  return (
    <Collapsible>
      <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>
        Use a different account
        <ChevronDown data-icon="inline-end" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent motion="disclosure" className="pt-3">
        <ManualAccountFields
          profileDraft={profileDraft}
          updateProfileDraft={updateProfileDraft}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

function ManualAccountFields({
  profileDraft,
  updateProfileDraft,
}: {
  readonly profileDraft: ProfileDraft;
  readonly updateProfileDraft: (update: SetStateAction<ProfileDraft>) => void;
}): React.JSX.Element {
  return (
    <FieldGroup className="grid gap-4 sm:grid-cols-2">
      <Field>
        <FieldLabel htmlFor="profile-gh-account">GitHub account</FieldLabel>
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
      <Field>
        <FieldLabel htmlFor="profile-github-host">GitHub host</FieldLabel>
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
  );
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
  renderStatus,
}: {
  readonly label: string;
  readonly field: ProfileListField;
  readonly entries: ReadonlyArray<ProfileListEntry>;
  readonly placeholder: string;
  readonly onChange: (
    field: ProfileListField,
    entryId: string,
    value: string,
  ) => void;
  readonly onAdd: (field: ProfileListField) => void;
  readonly onRemove: (field: ProfileListField, entryId: string) => void;
  readonly onChoose?: (entryId: string) => void;
  readonly renderStatus?: (value: string) => React.ReactNode;
}): React.JSX.Element {
  const singular = label.slice(0, -1).toLowerCase();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex flex-col gap-2 rounded-lg border p-2">
        {entries.map((entry, index) => (
          <div key={entry.id} className="flex flex-col gap-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <Input
                aria-label={`${singular} ${index + 1}`}
                value={entry.value}
                placeholder={placeholder}
                onChange={(event) =>
                  onChange(field, entry.id, event.target.value)
                }
              />
              {onChoose === undefined ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onChoose(entry.id)}
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
                      onClick={() => onRemove(field, entry.id)}
                    />
                  }
                >
                  <X />
                </TooltipTrigger>
                <TooltipContent>{`Remove ${singular}`}</TooltipContent>
              </Tooltip>
            </div>
            {renderStatus === undefined || entry.value.trim() === ""
              ? null
              : renderStatus(entry.value)}
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
