import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import type { Dashboard, Repo } from "../renderer-models";
import {
  AddWatchedRepositoryForm,
  useWatchedRepositories,
  WatchedRepositoryList,
} from "./settings-workspace-repositories";
import type { WorkspaceProfileEditorHook } from "./settings-workspace-profile-editor";
import {
  ReviewingAsPanel,
  type ReviewingAsProbeHook,
} from "./settings-workspace-reviewing-as";

const EMPTY_REPOS: ReadonlyArray<Repo> = [];

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
          <CardDescription>Resolved from the GitHub CLI.</CardDescription>
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
 * The watched-repositories card: add a repository by `owner/repo`, choose
 * each one's checkout, or stop watching it. Shared by Settings > Workspace
 * and the Pull requests first-run flow, which differ only in the heading.
 */
export function RepositoriesCard({
  dashboard,
  onWorkspaceReload,
  title = "Repositories",
}: {
  readonly dashboard: Dashboard | undefined;
  readonly onWorkspaceReload: () => Promise<void>;
  readonly title?: string;
}): React.JSX.Element {
  const watchlist = useWatchedRepositories(
    dashboard?.profile,
    onWorkspaceReload,
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
            Pull requests are listed from watched repositories. A local review
            needs the repository&apos;s checkout.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <AddWatchedRepositoryForm watchlist={watchlist} />
          <WatchedRepositoryList
            repositories={dashboard?.profile.repos ?? EMPTY_REPOS}
            watchlist={watchlist}
          />
        </CardContent>
      </Card>
    </section>
  );
}
