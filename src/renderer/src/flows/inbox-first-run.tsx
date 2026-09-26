import { CircleAlert } from "lucide-react";
import { Button } from "../components/ui/button";
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
 * Ticks save as they are made; Continue, offered once a repository is
 * watched, is what leaves setup, so the user can pick several first.
 */
export function WorkspaceFirstRun({
  dashboard,
  onWorkspaceReload,
  onContinue,
}: {
  readonly dashboard: Dashboard | undefined;
  readonly onWorkspaceReload: () => Promise<void>;
  /** Absent before a workspace has loaded, when nothing can be watched yet. */
  readonly onContinue: (() => void) | undefined;
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
  const watchedCount = dashboard?.profile.repos?.length ?? 0;

  return (
    <section
      className="mt-6 flex flex-col gap-6"
      aria-label="Set up your workspace"
    >
      <div>
        <h2 className="text-lg font-semibold tracking-tight">
          Set up your workspace
        </h2>
      </div>
      <ReviewingAsCard editor={editor} probe={probe} title="1. Reviewing as" />
      {gitMissing ? (
        <p
          className="flex items-center gap-1.5 text-xs text-destructive"
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
      {onContinue === undefined || watchedCount === 0 ? null : (
        <div className="flex justify-end">
          <Button onClick={onContinue}>Continue</Button>
        </div>
      )}
    </section>
  );
}
