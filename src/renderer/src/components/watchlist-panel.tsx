import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";

import { requestJson } from "../api-client";
import type { Profile } from "../renderer-models";
import { repositoryKey } from "../renderer-models";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import { Separator } from "./ui/separator";

export type WatchlistPanelProps = {
  readonly profile: Profile;
  readonly onWorkspaceReload: () => Promise<void>;
};

type DiscoveryEntry = {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly localPath: string;
};

function entryKey(entry: DiscoveryEntry): string {
  return `${entry.host}/${entry.owner}/${entry.repo}`;
}

/** Group discovered repos by each workspace root. A repo under multiple roots shows once under its first matching root. */
function groupByRoot(
  entries: ReadonlyArray<DiscoveryEntry>,
  roots: ReadonlyArray<string>,
): ReadonlyArray<{
  readonly root: string;
  readonly repos: ReadonlyArray<DiscoveryEntry>;
}> {
  const assigned = new Set<string>();
  const groups: Array<{
    readonly root: string;
    readonly repos: DiscoveryEntry[];
  }> = [];
  for (const root of roots) {
    const repos: DiscoveryEntry[] = [];
    for (const entry of entries) {
      if (assigned.has(entryKey(entry))) continue;
      if (entry.localPath.startsWith(root)) {
        repos.push(entry);
        assigned.add(entryKey(entry));
      }
    }
    if (repos.length > 0) groups.push({ root, repos });
  }
  const unassigned = entries.filter((entry) => !assigned.has(entryKey(entry)));
  if (unassigned.length > 0) {
    groups.push({ root: "Other", repos: unassigned });
  }
  return groups;
}

/** Tick-based Discovery surface. Groups repos by workspace root; pre-ticks watched repos. */
export function WatchlistPanel({
  profile,
  onWorkspaceReload,
}: WatchlistPanelProps): React.JSX.Element {
  const [discovered, setDiscoverResult] = useState<
    ReadonlyArray<DiscoveryEntry>
  >([]);
  const [watched, setWatched] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();

  const workspaceRoots = profile.workspaceRoots ?? [];

  useEffect(() => {
    const watchedKeys = new Set(
      (profile.repos ?? []).map((repo) => repositoryKey(repo)),
    );
    setWatched(watchedKeys);
  }, [profile.repos]);

  /** Merge already-watched repos into the discovery list so they show as pre-ticked entries. */
  const merged = useMemo((): ReadonlyArray<DiscoveryEntry> => {
    const seen = new Map<string, DiscoveryEntry>(
      discovered.map((entry) => [entryKey(entry), entry]),
    );
    for (const repo of profile.repos ?? []) {
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
  }, [discovered, profile.repos]);

  const groups = useMemo(
    () => groupByRoot(merged, workspaceRoots),
    [merged, workspaceRoots],
  );

  const discover = async (): Promise<void> => {
    setPending("discover");
    setError(undefined);
    try {
      const value = await requestJson("/v1/watchlist/suggestions");
      const entries: DiscoveryEntry[] = [];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (
            typeof item === "object" &&
            item !== null &&
            typeof item.host === "string" &&
            typeof item.owner === "string" &&
            typeof item.repo === "string" &&
            typeof item.localPath === "string"
          ) {
            entries.push(item as DiscoveryEntry);
          }
        }
      }
      setDiscoverResult(entries);
      setFeedback(
        entries.length === 0 && (profile.repos ?? []).length === 0
          ? "No repositories found in workspace roots."
          : undefined,
      );
    } catch (cause: unknown) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Patchdesk could not discover repositories.",
      );
    } finally {
      setPending(undefined);
    }
  };

  useEffect(() => {
    void discover();
  }, []);

  const toggleRepo = async (
    entry: DiscoveryEntry,
    currentlyWatched: boolean,
  ): Promise<void> => {
    const key = entryKey(entry);
    setPending(key);
    setError(undefined);
    try {
      if (currentlyWatched) {
        await requestJson("/v1/watchlist", {
          method: "DELETE",
          body: { host: entry.host, owner: entry.owner, repo: entry.repo },
        });
        setWatched((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
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
        setWatched((current) => new Set(current).add(key));
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

  return (
    <section
      aria-labelledby="watchlist-management-title"
      data-testid="watchlist-management"
    >
      <Card className="h-full">
        <CardHeader className="gap-2 pb-4">
          <CardTitle id="watchlist-management-title">Watchlist</CardTitle>
          <CardDescription>
            Repositories found in your workspace roots. Tick to add to the
            active queue.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Button
            size="sm"
            variant="outline"
            disabled={pending === "discover"}
            onClick={() => {
              void discover();
            }}
            aria-label="Refresh discovery"
          >
            <RefreshCw data-icon="inline-start" />
            Refresh
          </Button>
          {feedback === undefined ? null : (
            <p
              role="status"
              aria-live="polite"
              className="text-xs text-muted-foreground"
            >
              {feedback}
            </p>
          )}
          {error === undefined ? null : (
            <Alert variant="destructive">
              <AlertTitle>Watchlist action failed</AlertTitle>
              <AlertDescription role="alert">{error}</AlertDescription>
            </Alert>
          )}
          {groups.map((group) => (
            <div key={group.root} className="flex flex-col gap-2">
              <Label className="text-xs font-semibold uppercase text-muted-foreground">
                {group.root}
              </Label>
              <div
                className="flex flex-col gap-1"
                aria-label={`Repositories under ${group.root}`}
              >
                {group.repos.map((entry) => {
                  const key = entryKey(entry);
                  const currentlyWatched = watched.has(key);
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
                        onCheckedChange={() => {
                          void toggleRepo(entry, currentlyWatched);
                        }}
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
              <Separator />
            </div>
          ))}
          {discovered.length === 0 && pending !== "discover" ? (
            <p className="text-xs text-muted-foreground" role="status">
              No repositories discovered. Add workspace roots in profile
              settings to find repositories.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
