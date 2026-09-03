import { Plus, FolderOpen, X } from "lucide-react";
import { useState } from "react";
import {
  flattenDiscoveredRepositories,
  type WorkspaceRootDiscovery,
} from "../workspace-root-discovery-contract";
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
  FieldError,
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
  useWorkspaceProfileEditor,
  type FieldStatus,
} from "./settings-workspace-profile-editor";
import type {
  ProfileListEntry,
  ProfileListField,
} from "./settings-workspace-profile-values";
import { FieldSaveStatus } from "./settings-workspace-field-status";
import {
  ReviewingAsPanel,
  useReviewingAsProbe,
} from "./settings-workspace-reviewing-as";
import { CreateWorkspaceDialog } from "./settings-workspace-create-dialog";
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
  readonly profileSwitchState: ProfileSwitchState | undefined;
  readonly onProfileSwitch:
    | ((profileId: string) => Promise<ProfileSwitchResult>)
    | undefined;
};

/**
 * The Workspace settings section: the Reviewing-as probe, the Profile card,
 * and Workspace-scope editing. Mounted only while the Workspace tab is
 * showing: every control here commits on its own — on blur, on Enter, or on
 * pick — so there is no draft left for an unmounted section to carry.
 */
export function WorkspaceProfileSection({
  dashboard,
  profiles,
  onWorkspaceReload,
  profileSwitchState,
  onProfileSwitch,
}: WorkspaceProfileSectionProps): React.JSX.Element {
  const editor = useWorkspaceProfileEditor({
    dashboard,
    profiles,
    onWorkspaceReload,
    onProfileSwitch,
  });

  // The dialog is mounted only while open: that discards a cancelled draft,
  // and keeps its `GET /v1/environment` probe off until the user asks for it.
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const { reviewingAs, recheck } = useReviewingAsProbe(
    editor.scalars.ghAccount,
    editor.selectAccount,
  );

  const rootDiscovery = useWorkspaceRootDiscovery(dashboard?.profile);
  const savedRepos = dashboard?.profile.repos ?? EMPTY_REPOS;
  const savedRoots = dashboard?.profile.workspaceRoots ?? EMPTY_ROOTS;
  const discoveries =
    rootDiscovery.kind === "loaded" ? rootDiscovery.value : EMPTY_DISCOVERED;
  const discoveredRepos = flattenDiscoveredRepositories(discoveries);
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
            account={{
              ghAccount: editor.scalars.ghAccount,
              githubHost: editor.scalars.githubHost,
              accountStatus: editor.status.ghAccount,
              hostStatus: editor.status.githubHost,
              onEdit: editor.editScalar,
              onCommit: editor.commitScalar,
              onSelectAccount: editor.selectAccount,
            }}
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
                value={dashboard?.profile.id ?? editor.persisted.id}
                items={profiles.map((profile) => ({
                  label: profile.label,
                  value: profile.id,
                }))}
                onValueChange={(value) => {
                  if (value !== null) editor.selectProfile(value);
                }}
              >
                <SelectTrigger id="active-profile" aria-label="Active profile">
                  <SelectValue placeholder="Select a profile">
                    {editor.persisted.label}
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
                <FieldError>{profileSwitchState.error.message}</FieldError>
              ) : null}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCreateDialogOpen(true)}
              >
                <Plus data-icon="inline-start" />
                New workspace
              </Button>
            </div>
            <ProfileIdentityFields
              id={editor.persisted.id}
              label={editor.scalars.label}
              status={editor.status.label}
              onEdit={(value) => editor.editScalar("label", value)}
              onCommit={() => editor.commitScalar("label")}
            />
          </FieldGroup>
        </CardContent>
      </Card>
      {createDialogOpen ? (
        <CreateWorkspaceDialog
          open
          onOpenChange={setCreateDialogOpen}
          onCreated={onWorkspaceReload}
        />
      ) : null}
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
              entries={editor.rows.workspaceRoots}
              placeholder="/absolute/workspace/path"
              status={editor.status.workspaceRoots}
              onChange={editor.editListEntry}
              onCommit={editor.commitList}
              onAdd={editor.addListEntry}
              onRemove={editor.removeListEntry}
              onChoose={(entryId) => {
                void editor.chooseWorkspaceRoot(entryId);
              }}
              renderStatus={(value) => {
                const status = rootDiscoveryStatus(value);
                const trimmedRoot = value.trim();
                const rootEntries = byRoot.get(trimmedRoot) ?? EMPTY_ENTRIES;
                const visibleEntries =
                  status.kind === "error"
                    ? rootEntries.filter(isWatched)
                    : rootEntries;
                const showsChecklist =
                  status.kind === "found" ||
                  (status.kind === "error" && visibleEntries.length > 0);
                return (
                  <div className="flex flex-col gap-2">
                    <WorkspaceRootDiscoveryStatus status={status} />
                    {showsChecklist ? (
                      <RepositoryChecklist
                        entries={visibleEntries}
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
              label="Rule paths"
              field="rulePaths"
              entries={editor.rows.rulePaths}
              placeholder="/absolute/path/to/AGENTS.md"
              status={editor.status.rulePaths}
              onChange={editor.editListEntry}
              onCommit={editor.commitList}
              onAdd={editor.addListEntry}
              onRemove={editor.removeListEntry}
            />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

type ProfileIdentityFieldsProps = {
  readonly id: string;
  readonly label: string;
  readonly status: FieldStatus;
  readonly onEdit: (value: string) => void;
  readonly onCommit: () => void;
};

function ProfileIdentityFields({
  id,
  label,
  status,
  onEdit,
  onCommit,
}: ProfileIdentityFieldsProps): React.JSX.Element {
  const failed = status.state === "failed";
  return (
    <FieldGroup className="grid gap-4 sm:grid-cols-2">
      <Field className="sm:col-span-2" data-disabled>
        <FieldLabel htmlFor="profile-id">Profile ID</FieldLabel>
        <Input id="profile-id" aria-label="Profile ID" value={id} disabled />
      </Field>
      <Field data-invalid={failed ? true : undefined}>
        <FieldLabel htmlFor="profile-label">Label</FieldLabel>
        <Input
          id="profile-label"
          aria-label="Label"
          value={label}
          aria-invalid={failed ? true : undefined}
          aria-describedby={failed ? "profile-label-status" : undefined}
          onChange={(event) => onEdit(event.target.value)}
          onBlur={onCommit}
          onKeyDown={(event) => {
            if (event.key === "Enter") onCommit();
          }}
        />
        <div id="profile-label-status">
          <FieldSaveStatus status={status} />
        </div>
      </Field>
    </FieldGroup>
  );
}

const EMPTY_REPOS: ReadonlyArray<Repo> = [];
const EMPTY_DISCOVERED: ReadonlyArray<WorkspaceRootDiscovery> = [];

function ProfileListEditor({
  label,
  field,
  entries,
  placeholder,
  status,
  onChange,
  onCommit,
  onAdd,
  onRemove,
  onChoose,
  renderStatus,
}: {
  readonly label: string;
  readonly field: ProfileListField;
  readonly entries: ReadonlyArray<ProfileListEntry>;
  readonly placeholder: string;
  readonly status: FieldStatus;
  readonly onChange: (
    field: ProfileListField,
    entryId: string,
    value: string,
  ) => void;
  readonly onCommit: (field: ProfileListField) => void;
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
                onBlur={() => onCommit(field)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onCommit(field);
                }}
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
      <FieldSaveStatus status={status} />
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
