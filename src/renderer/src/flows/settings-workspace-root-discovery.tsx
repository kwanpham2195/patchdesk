import {
  parseWorkspaceRootDiscoveries,
  type WorkspaceRootDiscovery,
} from "../workspace-root-discovery-contract";
import { useApiProbe, type ApiProbeState } from "../hooks/use-api-probe";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import type { Profile } from "../renderer-models";
import type { WatchlistEntry } from "./settings-workspace-repositories";

/** What a single workspace-root row shows for its discovery result. */
export type RootDiscoveryStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | {
      readonly kind: "found";
      readonly total: number;
      readonly watched: number;
    };

// oxlint-disable-next-line react/only-export-components -- The workspace-root discovery probe, its status resolver, and the empty-collection constants share this module with the status component that consumes them.
export const EMPTY_ROOTS: ReadonlyArray<string> = [];
// oxlint-disable-next-line react/only-export-components -- The workspace-root discovery probe, its status resolver, and the empty-collection constants share this module with the status component that consumes them.
export const EMPTY_ENTRIES: ReadonlyArray<WatchlistEntry> = [];

/**
 * Runs the `GET /v1/watchlist/suggestions` scan that
 * `DashboardController.discoverWorkspaceRepos` performs against the *saved*
 * profile's workspace roots (see `WatchlistPanel`, whose request/parse path
 * this mirrors). Re-runs whenever the saved profile's id, workspace roots,
 * or watched repos change — which covers both switching profiles and a root
 * row's own save bringing a newly-entered root into scope, since
 * `onWorkspaceReload` refreshes `dashboard.profile` after either.
 */
// oxlint-disable-next-line react/only-export-components -- The workspace-root discovery probe, its status resolver, and the empty-collection constants share this module with the status component that consumes them.
export function useWorkspaceRootDiscovery(
  savedProfile: Profile | undefined,
): ApiProbeState<ReadonlyArray<WorkspaceRootDiscovery>> {
  // A JSON key rather than the profile object itself: the dashboard is
  // refetched (and reallocated) on every reload even when nothing this scan
  // cares about changed.
  const savedKey = JSON.stringify({
    id: savedProfile?.id,
    workspaceRoots: savedProfile?.workspaceRoots,
    repos: savedProfile?.repos,
  });

  return useApiProbe(
    { path: "/v1/watchlist/suggestions", restartKey: savedKey },
    parseWorkspaceRootDiscoveries,
  );
}

/**
 * Resolves one workspace-root row's discovery status. A root the saved
 * profile doesn't carry has never been scanned — discovery runs server-side
 * against the saved profile — so it reports the loading state rather than a
 * count of 0, which would be a false negative in exactly the case this panel
 * exists to surface; every non-blank row reaches the saved profile as soon as
 * it commits. The "found" count is read off `byRoot`, the single grouping
 * computed once per render in `WorkspaceProfileSection` (via
 * `groupWatchlistEntries`) rather than a second, parallel grouping algorithm.
 */
// oxlint-disable-next-line react/only-export-components -- The workspace-root discovery probe, its status resolver, and the empty-collection constants share this module with the status component that consumes them.
export function workspaceRootDiscoveryStatus(
  root: string,
  savedProfile: Profile | undefined,
  discovery: ApiProbeState<ReadonlyArray<WorkspaceRootDiscovery>>,
  byRoot: ReadonlyMap<string, ReadonlyArray<WatchlistEntry>>,
  isWatched: (entry: WatchlistEntry) => boolean,
): RootDiscoveryStatus {
  const trimmedRoot = root.trim();
  const savedRoots = savedProfile?.workspaceRoots ?? EMPTY_ROOTS;
  if (!savedRoots.includes(trimmedRoot)) return { kind: "loading" };
  if (discovery.kind === "checking") return { kind: "loading" };
  if (discovery.kind === "error") return { kind: "error" };
  const outcome = discovery.value.find(
    (candidate) => candidate.root === trimmedRoot,
  );
  if (outcome === undefined || outcome.state === "failed")
    return { kind: "error" };
  const rootEntries = byRoot.get(trimmedRoot) ?? EMPTY_ENTRIES;
  const watchedCount = rootEntries.filter(isWatched).length;
  return { kind: "found", total: rootEntries.length, watched: watchedCount };
}

/** Renders one workspace-root row's discovery result: a count, the explicit zero-found state, a loading state, or a failure state. */
export function WorkspaceRootDiscoveryStatus({
  status,
}: {
  readonly status: RootDiscoveryStatus;
}): React.JSX.Element | null {
  if (status.kind === "loading") {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        Scanning for repositories…
      </p>
    );
  }
  if (status.kind === "error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Repository scan failed</AlertTitle>
        <AlertDescription>
          Could not scan this folder for repositories.
        </AlertDescription>
      </Alert>
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
