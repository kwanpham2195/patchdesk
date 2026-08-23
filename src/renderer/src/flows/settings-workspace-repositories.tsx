import { useState } from "react";

import { requestJson } from "../api-client";
import type { DiscoveredRepo } from "../renderer-contracts";
import { repositoryKey, type Repo } from "../renderer-models";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Checkbox } from "../components/ui/checkbox";
import { Label } from "../components/ui/label";

/** A repository shown in a workspace-scope repository checklist, merged from discovery and the saved profile's watchlist. Structurally a `Repo` with `localPath` narrowed to a required (possibly empty) string, so `repositoryKey` from renderer-models works for both. */
export type WatchlistEntry = {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly localPath: string;
};

/**
 * Merges discovered repos with already-watched repos so watched repos not
 * returned by `/v1/watchlist/suggestions` (the discovery endpoint excludes
 * anything already in `profile.repos`) still appear, pre-ticked. Discovered
 * entries win on key collision; a watched repo with no recorded local path
 * renders with `localPath: ""`.
 */
// oxlint-disable-next-line react/only-export-components -- Merge/group helpers and the toggle hook share this module with the components that consume them.
export function mergeWatchlistEntries(
  discovered: ReadonlyArray<DiscoveredRepo>,
  watchedRepos: ReadonlyArray<Repo>,
): ReadonlyArray<WatchlistEntry> {
  const seen = new Map<string, WatchlistEntry>(
    discovered.map((entry) => [repositoryKey(entry), entry]),
  );
  for (const repo of watchedRepos) {
    const key = repositoryKey(repo);
    if (!seen.has(key)) {
      seen.set(key, {
        host: repo.host,
        owner: repo.owner,
        repo: repo.repo,
        localPath: repo.localPath ?? "",
      });
    }
  }
  return [...seen.values()];
}

export type GroupedWatchlistEntries = {
  readonly byRoot: ReadonlyMap<string, ReadonlyArray<WatchlistEntry>>;
  readonly other: ReadonlyArray<WatchlistEntry>;
};

/**
 * Groups merged watchlist entries by the saved workspace root that contains
 * them, by path prefix — first-root-wins, so a repo under multiple roots
 * (nested roots) counts once. Anything that matches no root — including
 * watched repos with an empty `localPath` — is returned in `other` rather
 * than silently dropped.
 */
// oxlint-disable-next-line react/only-export-components -- Merge/group helpers and the toggle hook share this module with the components that consume them.
export function groupWatchlistEntries(
  entries: ReadonlyArray<WatchlistEntry>,
  roots: ReadonlyArray<string>,
): GroupedWatchlistEntries {
  const assigned = new Set<string>();
  const byRoot = new Map<string, WatchlistEntry[]>();
  for (const root of roots) {
    const repos: WatchlistEntry[] = [];
    for (const entry of entries) {
      const key = repositoryKey(entry);
      if (assigned.has(key)) continue;
      if (entry.localPath.startsWith(root)) {
        repos.push(entry);
        assigned.add(key);
      }
    }
    byRoot.set(root, repos);
  }
  const other = entries.filter((entry) => !assigned.has(repositoryKey(entry)));
  return { byRoot, other };
}

export type WatchlistToggleHook = {
  readonly pending: string | undefined;
  readonly error: string | undefined;
  readonly feedback: string | undefined;
  readonly toggleRepo: (
    entry: WatchlistEntry,
    currentlyWatched: boolean,
  ) => Promise<void>;
};

/**
 * Owns the busy/error/feedback state for ticking or unticking a repository
 * in the watchlist. `POST`/`DELETE /v1/watchlist`, matching the request
 * bodies the previous standalone `WatchlistPanel` sent; the caller's
 * `onWorkspaceReload` refreshes the saved profile (and so which repos read
 * as watched) after either request settles.
 */
// oxlint-disable-next-line react/only-export-components -- Merge/group helpers and the toggle hook share this module with the components that consume them.
export function useWatchlistToggle(
  onWorkspaceReload: () => Promise<void>,
): WatchlistToggleHook {
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();

  const toggleRepo = async (
    entry: WatchlistEntry,
    currentlyWatched: boolean,
  ): Promise<void> => {
    const key = repositoryKey(entry);
    setPending(key);
    setError(undefined);
    try {
      if (currentlyWatched) {
        await requestJson("/v1/watchlist", {
          method: "DELETE",
          body: { host: entry.host, owner: entry.owner, repo: entry.repo },
        });
        setFeedback(`Removed ${entry.owner}/${entry.repo} from the watchlist.`);
      } else {
        await requestJson("/v1/watchlist", {
          method: "POST",
          body: {
            host: entry.host,
            owner: entry.owner,
            repo: entry.repo,
            localPath: entry.localPath,
          },
        });
        setFeedback(`Added ${entry.owner}/${entry.repo} to the watchlist.`);
      }
      await onWorkspaceReload();
    } catch (cause: unknown) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Patchdesk could not update the watchlist.",
      );
    } finally {
      setPending(undefined);
    }
  };

  return { pending, error, feedback, toggleRepo };
}

/** Renders the toggle hook's error/feedback state, once, for the surrounding card. */
export function WatchlistToggleStatus({
  error,
  feedback,
}: {
  readonly error: string | undefined;
  readonly feedback: string | undefined;
}): React.JSX.Element | null {
  if (error !== undefined) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Watchlist action failed</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (feedback !== undefined) {
    return (
      <p
        role="status"
        aria-live="polite"
        className="text-xs text-muted-foreground"
      >
        {feedback}
      </p>
    );
  }
  return null;
}

/** A tickable list of repositories, checked against the saved profile's watched repos. Used both for a workspace root's own repos and for the "watched outside current workspace roots" group. */
export function RepositoryChecklist({
  entries,
  isWatched,
  pending,
  onToggle,
  ariaLabel,
}: {
  readonly entries: ReadonlyArray<WatchlistEntry>;
  readonly isWatched: (entry: WatchlistEntry) => boolean;
  readonly pending: string | undefined;
  readonly onToggle: (entry: WatchlistEntry, currentlyWatched: boolean) => void;
  readonly ariaLabel: string;
}): React.JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" aria-label={ariaLabel}>
      {entries.map((entry) => {
        const key = repositoryKey(entry);
        const currentlyWatched = isWatched(entry);
        const busy = pending === key;
        return (
          <label
            key={key}
            className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
          >
            <Checkbox
              className="mt-0.5"
              disabled={busy}
              checked={currentlyWatched}
              onCheckedChange={() => onToggle(entry, currentlyWatched)}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {entry.owner}/{entry.repo}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {entry.localPath}
              </p>
            </div>
          </label>
        );
      })}
    </div>
  );
}

/** The "watched outside current workspace roots" block: repos in `profile.repos` (or discovered) whose local path matches none of the saved workspace roots. Rendered only when non-empty by the caller. */
export function WatchedOutsideRootsSection({
  entries,
  isWatched,
  pending,
  onToggle,
}: {
  readonly entries: ReadonlyArray<WatchlistEntry>;
  readonly isWatched: (entry: WatchlistEntry) => boolean;
  readonly pending: string | undefined;
  readonly onToggle: (entry: WatchlistEntry, currentlyWatched: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <Label className="text-xs font-semibold uppercase text-muted-foreground">
        Watched outside current workspace roots
      </Label>
      <RepositoryChecklist
        entries={entries}
        isWatched={isWatched}
        pending={pending}
        onToggle={onToggle}
        ariaLabel="Repositories watched outside current workspace roots"
      />
    </div>
  );
}
