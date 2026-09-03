import { CircleAlert } from "lucide-react";
import type { Dashboard, Profile } from "../renderer-models";
import { useWorkspaceProfileEditor } from "./settings-workspace-profile-editor";
import { useReviewingAsProbe } from "./settings-workspace-reviewing-as";
import { ReviewingAsCard, RepositoriesCard } from "./settings-workspace-cards";

/** The switcher is not offered here, so the editor never needs the list. */
const NO_PROFILES: ReadonlyArray<Profile> = [];

/**
 * Finishes workspace setup on the Pull requests screen: confirm the account,
 * choose the folders, tick the repositories. Every step is the same component
 * Settings > Workspace renders, driven by the same editor hook, so setup never
 * hands the user off to the Settings modal.
 *
 * There is no "done" button. Ticking the first repository saves the watchlist
 * and reloads the workspace, and the reloaded profile has a watched repository,
 * which is exactly the condition under which the caller stops rendering this
 * flow.
 */
export function WorkspaceFirstRun({
  dashboard,
  onWorkspaceReload,
}: {
  readonly dashboard: Dashboard | undefined;
  readonly onWorkspaceReload: () => Promise<void>;
}): React.JSX.Element {
  const editor = useWorkspaceProfileEditor({
    dashboard,
    profiles: NO_PROFILES,
    onWorkspaceReload,
    onProfileSwitch: undefined,
  });
  // One `GET /v1/environment` for the whole flow: the account card renders
  // what `gh` reports, and the Git line below reads `git` off the same result.
  const probe = useReviewingAsProbe(
    editor.scalars.ghAccount,
    editor.selectAccount,
  );
  const gitMissing =
    probe.reviewingAs.kind === "loaded" &&
    probe.reviewingAs.value.git !== "ready";
  // The account is what every later step needs: discovery and the watchlist
  // are both scoped to a persisted profile, which the domain parser refuses
  // without one.
  const accountChosen = editor.persisted.ghAccount !== "";

  return (
    <section
      className="mt-6 flex flex-col gap-6"
      aria-label="Set up your workspace"
    >
      <div>
        <h2 className="text-lg font-semibold tracking-tight">
          Set up your workspace
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Confirm the GitHub account, choose the folders that hold your
          checkouts, then tick the repositories to review.
        </p>
      </div>
      <ReviewingAsCard editor={editor} probe={probe} title="1. Reviewing as" />
      {gitMissing ? (
        <p
          className="flex items-center gap-1.5 text-xs text-rose-700 dark:text-rose-400"
          role="status"
        >
          <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          Git is not installed. Install Git for this platform, then re-check.
        </p>
      ) : null}
      {accountChosen ? (
        <RepositoriesCard
          editor={editor}
          dashboard={dashboard}
          onWorkspaceReload={onWorkspaceReload}
          title="2. Folders and repositories"
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Choose an account first.
        </p>
      )}
    </section>
  );
}
