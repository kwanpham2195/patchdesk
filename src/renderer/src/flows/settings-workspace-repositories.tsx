import { useRef, useState } from "react";

import { requestJson } from "../api-client";
import type { DiscoveredRepo } from "../renderer-contracts";
import { repositoryKey, type Repo } from "../renderer-models";
import { Checkbox } from "../components/ui/checkbox";
import { Label } from "../components/ui/label";
import { Spinner } from "../components/ui/spinner";
import { InlineError } from "../components/ui/inline-error";

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

function isLocalPathWithinWorkspaceRoot(
  localPath: string,
  root: string,
): boolean {
  let normalizedRoot = root;
  while (normalizedRoot.endsWith("/") && normalizedRoot !== "/")
    normalizedRoot = normalizedRoot.slice(0, -1);
  if (localPath === normalizedRoot) return true;
  const descendantPrefix = normalizedRoot === "/" ? "/" : `${normalizedRoot}/`;
  return localPath.startsWith(descendantPrefix);
}

/**
 * Groups merged watchlist entries by the saved workspace root that contains
 * them, by directory containment — first-root-wins, so a repo under multiple
 * roots (nested roots) counts once. Anything that matches no root — including
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
    if (byRoot.has(root)) continue;
    const repos: WatchlistEntry[] = [];
    for (const entry of entries) {
      const key = repositoryKey(entry);
      if (assigned.has(key)) continue;
      if (isLocalPathWithinWorkspaceRoot(entry.localPath, root)) {
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
  readonly pendingKeys: ReadonlySet<string>;
  readonly errorsByKey: ReadonlyMap<string, string>;
  readonly draftWatchedByKey: ReadonlyMap<string, boolean>;
  readonly feedback: string | undefined;
  readonly toggleRepo: (
    entry: WatchlistEntry,
    currentlyWatched: boolean,
  ) => Promise<void>;
};

/**
 * Owns repository-scoped pending, draft, and error state for watchlist
 * changes. A synchronous key guard rejects duplicate same-row submissions
 * while allowing requests for different repositories to run concurrently.
 */
// oxlint-disable-next-line react/only-export-components -- Merge/group helpers and the toggle hook share this module with the components that consume them.
export function useWatchlistToggle(
  onWorkspaceReload: () => Promise<void>,
): WatchlistToggleHook {
  const pendingKeysRef = useRef(new Set<string>());
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [errorsByKey, setErrorsByKey] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [draftWatchedByKey, setDraftWatchedByKey] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());
  const [feedback, setFeedback] = useState<string>();

  const toggleRepo = async (
    entry: WatchlistEntry,
    currentlyWatched: boolean,
  ): Promise<void> => {
    const key = repositoryKey(entry);
    if (pendingKeysRef.current.has(key)) return;

    pendingKeysRef.current.add(key);
    setPendingKeys((current) => new Set(current).add(key));
    setDraftWatchedByKey((current) =>
      new Map(current).set(key, !currentlyWatched),
    );
    setErrorsByKey((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
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
      const message =
        cause instanceof Error
          ? cause.message
          : "Patchdesk could not update the watchlist.";
      setErrorsByKey((current) => new Map(current).set(key, message));
    } finally {
      pendingKeysRef.current.delete(key);
      setPendingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      setDraftWatchedByKey((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    }
  };

  return {
    pendingKeys,
    errorsByKey,
    draftWatchedByKey,
    feedback,
    toggleRepo,
  };
}

/** Renders the toggle hook's success feedback once for the surrounding card. */
export function WatchlistToggleStatus({
  feedback,
}: {
  readonly feedback: string | undefined;
}): React.JSX.Element | null {
  if (feedback !== undefined) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
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
  pendingKeys,
  errorsByKey,
  draftWatchedByKey,
  onToggle,
  ariaLabel,
}: {
  readonly entries: ReadonlyArray<WatchlistEntry>;
  readonly isWatched: (entry: WatchlistEntry) => boolean;
  readonly pendingKeys: ReadonlySet<string>;
  readonly errorsByKey: ReadonlyMap<string, string>;
  readonly draftWatchedByKey: ReadonlyMap<string, boolean>;
  readonly onToggle: (entry: WatchlistEntry, currentlyWatched: boolean) => void;
  readonly ariaLabel: string;
}): React.JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" aria-label={ariaLabel}>
      {entries.map((entry) => {
        const key = repositoryKey(entry);
        const savedWatched = isWatched(entry);
        const currentlyWatched = draftWatchedByKey.get(key) ?? savedWatched;
        const busy = pendingKeys.has(key);
        const error = errorsByKey.get(key);
        return (
          <label
            key={key}
            className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
          >
            <Checkbox
              className="mt-0.5"
              disabled={busy}
              checked={currentlyWatched}
              aria-invalid={error === undefined ? undefined : true}
              onCheckedChange={() => onToggle(entry, savedWatched)}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {entry.owner}/{entry.repo}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {entry.localPath}
              </p>
              {busy ? (
                <Spinner
                  className="mt-1 size-3.5"
                  aria-label={`Updating ${entry.owner}/${entry.repo}`}
                />
              ) : null}
              {error === undefined ? null : (
                <InlineError className="text-xs">{error}</InlineError>
              )}
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
  pendingKeys,
  errorsByKey,
  draftWatchedByKey,
  onToggle,
}: {
  readonly entries: ReadonlyArray<WatchlistEntry>;
  readonly isWatched: (entry: WatchlistEntry) => boolean;
  readonly pendingKeys: ReadonlySet<string>;
  readonly errorsByKey: ReadonlyMap<string, string>;
  readonly draftWatchedByKey: ReadonlyMap<string, boolean>;
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
        pendingKeys={pendingKeys}
        errorsByKey={errorsByKey}
        draftWatchedByKey={draftWatchedByKey}
        onToggle={onToggle}
        ariaLabel="Repositories watched outside current workspace roots"
      />
    </div>
  );
}
