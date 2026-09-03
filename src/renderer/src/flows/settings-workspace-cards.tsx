import {
  flattenDiscoveredRepositories,
  type WorkspaceRootDiscovery,
} from "../workspace-root-discovery-contract";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { repositoryKey, type Dashboard, type Repo } from "../renderer-models";
import {
  groupWatchlistEntries,
  mergeWatchlistEntries,
  RepositoryChecklist,
  useWatchlistToggle,
  WatchedOutsideRootsSection,
  WatchlistToggleStatus,
  type WatchlistEntry,
} from "./settings-workspace-repositories";
import type { WorkspaceProfileEditorHook } from "./settings-workspace-profile-editor";
import {
  ReviewingAsPanel,
  type ReviewingAsProbeHook,
} from "./settings-workspace-reviewing-as";
import { ProfileListEditor } from "./settings-workspace-list-editor";
import {
  EMPTY_ENTRIES,
  EMPTY_ROOTS,
  useWorkspaceRootDiscovery,
  WorkspaceRootDiscoveryStatus,
  workspaceRootDiscoveryStatus,
  type RootDiscoveryStatus,
} from "./settings-workspace-root-discovery";

const EMPTY_REPOS: ReadonlyArray<Repo> = [];
const EMPTY_DISCOVERED: ReadonlyArray<WorkspaceRootDiscovery> = [];

/**
 * The account card: which GitHub account this workspace reviews as. The
 * `GET /v1/environment` probe is owned by the caller, so a screen that needs
 * the same environment reading for something else (the first-run flow's Git
 * line) shares one request with this card instead of issuing a second.
 */
export function ReviewingAsCard({
  editor,
  probe,
  title = "Reviewing as",
}: {
  readonly editor: WorkspaceProfileEditorHook;
  readonly probe: ReviewingAsProbeHook;
  readonly title?: string;
}): React.JSX.Element {
  return (
    <section aria-labelledby="workspace-reviewing-as-title">
      <Card>
        <CardHeader>
          <CardTitle id="workspace-reviewing-as-title">{title}</CardTitle>
          <CardDescription>
            The GitHub account Patchdesk uses to find and review pull requests,
            resolved from the GitHub CLI.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReviewingAsPanel
            state={probe.reviewingAs}
            account={{
              ghAccount: editor.scalars.ghAccount,
              githubHost: editor.scalars.githubHost,
              accountStatus: editor.status.ghAccount,
              hostStatus: editor.status.githubHost,
              onEdit: editor.editScalar,
              onCommit: editor.commitScalar,
              onSelectAccount: editor.selectAccount,
            }}
            onRecheck={probe.recheck}
          />
        </CardContent>
      </Card>
    </section>
  );
}

/**
 * The folders-and-repositories card: the workspace-root rows, each root's
 * discovery result, the tickable checklist under it, and anything watched
 * outside every root. Shared by Settings > Workspace and the Pull requests
 * first-run flow, which differ only in the heading.
 */
export function RepositoriesCard({
  editor,
  dashboard,
  onWorkspaceReload,
  title = "Repositories",
}: {
  readonly editor: WorkspaceProfileEditorHook;
  readonly dashboard: Dashboard | undefined;
  readonly onWorkspaceReload: () => Promise<void>;
  readonly title?: string;
}): React.JSX.Element {
  const rootDiscovery = useWorkspaceRootDiscovery(dashboard?.profile);
  const savedRepos = dashboard?.profile.repos ?? EMPTY_REPOS;
  const savedRoots = dashboard?.profile.workspaceRoots ?? EMPTY_ROOTS;
  const discoveries =
    rootDiscovery.kind === "loaded" ? rootDiscovery.value : EMPTY_DISCOVERED;
  const discoveredRepos = flattenDiscoveredRepositories(discoveries);
  // The single merge and the single grouping of discovered + watched
  // repositories for this render.
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
  // The one-line folder prompt belongs to a workspace that has never had a
  // root: any persisted root, or anything typed into the row, answers it.
  const rootRows = editor.rows.workspaceRoots;
  const firstRootRow = rootRows[0];
  const needsFirstRoot =
    editor.persisted.workspaceRoots.length === 0 &&
    rootRows.length === 1 &&
    firstRootRow !== undefined &&
    firstRootRow.value.trim() === "";
  const rootDiscoveryStatus = (root: string): RootDiscoveryStatus =>
    workspaceRootDiscoveryStatus(
      root,
      dashboard?.profile,
      rootDiscovery,
      byRoot,
      isWatched,
    );

  return (
    <section
      aria-labelledby="workspace-repositories-title"
      data-testid="workspace-repositories"
    >
      <Card>
        <CardHeader>
          <CardTitle id="workspace-repositories-title">{title}</CardTitle>
          <CardDescription>
            Folders Patchdesk scans for git checkouts with GitHub remotes. Tick
            the repositories to review.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <WatchlistToggleStatus feedback={watchlistToggle.feedback} />
          <ProfileListEditor
            label="Folders"
            itemLabel="Folder"
            field="workspaceRoots"
            {...(needsFirstRoot
              ? {
                  description: "Choose a folder that holds your git checkouts.",
                }
              : {})}
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
        </CardContent>
      </Card>
    </section>
  );
}
