import { Plus, FolderOpen, X } from "lucide-react";
import type { DiscoveredRepo } from "../renderer-contracts";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import type {
  ProfileSwitchResult,
  ProfileSwitchState,
} from "../hooks/use-profile-switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectGroup,
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
import {
  useWorkspaceProfileDraft,
  type ProfileListEntry,
  type ProfileListField,
} from "./settings-workspace-profile-draft";
import {
  ReviewingAsPanel,
  useReviewingAsProbe,
} from "./settings-workspace-reviewing-as";
import {
  EMPTY_ENTRIES,
  EMPTY_ROOTS,
  useWorkspaceRootDiscovery,
  WorkspaceRootDiscoveryStatus,
  workspaceRootDiscoveryStatus,
  type RootDiscoveryStatus,
} from "./settings-workspace-root-discovery";

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
  readonly profileSwitchState: ProfileSwitchState | undefined;
  readonly onProfileSwitch:
    | ((profileId: string) => Promise<ProfileSwitchResult>)
    | undefined;
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
  profileSwitchState,
  onProfileSwitch,
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
    onProfileSwitch,
  });

  const { reviewingAs, recheck } = useReviewingAsProbe(
    profileDraft.ghAccount,
    updateProfileDraft,
  );

  const rootDiscovery = useWorkspaceRootDiscovery(dashboard?.profile);
  const savedRepos = dashboard?.profile.repos ?? EMPTY_REPOS;
  const savedRoots = dashboard?.profile.workspaceRoots ?? EMPTY_ROOTS;
  const discoveredRepos =
    rootDiscovery.kind === "loaded" ? rootDiscovery.value : EMPTY_DISCOVERED;
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
                  <SelectGroup>
                    {profiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {profileSwitchState?.pendingOwner === "settings" ? (
                <p
                  className="flex items-center gap-1.5 text-sm text-muted-foreground"
                  role="status"
                >
                  <Spinner aria-hidden="true" />
                  Switching to{" "}
                  {profiles.find(
                    (profile) =>
                      profile.id === profileSwitchState.pendingTarget,
                  )?.label ?? "profile"}
                  …
                </p>
              ) : null}
              {profileSwitchState?.error?.owner === "settings" ? (
                <p className="text-sm text-destructive" role="alert">
                  {profileSwitchState.error.message}
                </p>
              ) : null}
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
              <Field
                className="sm:col-span-2"
                data-disabled={!creatingProfile || undefined}
              >
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
            <Alert variant="destructive">
              <AlertTitle>Profile update failed</AlertTitle>
              <AlertDescription>{profileError}</AlertDescription>
            </Alert>
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
            <WatchlistToggleStatus feedback={watchlistToggle.feedback} />
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
                        pendingKeys={watchlistToggle.pendingKeys}
                        errorsByKey={watchlistToggle.errorsByKey}
                        draftWatchedByKey={watchlistToggle.draftWatchedByKey}
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
                pendingKeys={watchlistToggle.pendingKeys}
                errorsByKey={watchlistToggle.errorsByKey}
                draftWatchedByKey={watchlistToggle.draftWatchedByKey}
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

const EMPTY_REPOS: ReadonlyArray<Repo> = [];
const EMPTY_DISCOVERED: ReadonlyArray<DiscoveredRepo> = [];

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
    <FieldSet className="gap-2">
      <FieldLegend variant="label">{label}</FieldLegend>
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
    </FieldSet>
  );
}
