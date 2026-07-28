import { useState } from "react";
import { Archive, RefreshCw, Search, Trash2 } from "lucide-react";

import { requestJson, selectDirectory } from "../api-client";
import type { Dashboard, Repo } from "../renderer-models";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export type WatchlistPanelProps = {
  readonly dashboard?: Dashboard;
  readonly onWorkspaceReload: () => Promise<void>;
  readonly onRepositoryRefresh: (value: unknown, repo: Repo) => void;
};

/** Provides watchlist management outside Settings while keeping repository actions local to the queue. */
export function WatchlistPanel({ dashboard, onWorkspaceReload, onRepositoryRefresh }: WatchlistPanelProps): React.JSX.Element {
  const [newRepo, setNewRepo] = useState("");
  const [suggestions, setSuggestions] = useState<ReadonlyArray<Repo>>([]);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<string>();
  const [removalTarget, setRemovalTarget] = useState<Repo>();
  const [removalError, setRemovalError] = useState<string>();

  const profileHost = dashboard?.profile.githubHost ?? "github.com";
  const repositories = dashboard?.dashboard.repos ?? [];

  const run = async (action: string, operation: () => Promise<void>): Promise<void> => {
    setPending(action);
    setError(undefined);
    try {
      await operation();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Patchdesk could not complete that watchlist action.");
    } finally {
      setPending(undefined);
    }
  };

  const addRepo = async (): Promise<void> => {
    const match = /^([^/]+)\/([^/]+)$/.exec(newRepo.trim());
    if (match === null || match[1] === undefined || match[2] === undefined) {
      setError("Enter a repository as owner/repository.");
      return;
    }
    await run("add", async () => {
      await requestJson("/v1/watchlist", {
        method: "POST",
        body: { host: profileHost, owner: match[1], repo: match[2] },
      });
      setNewRepo("");
      setFeedback(`Added ${match[1]}/${match[2]} to the watchlist.`);
      await onWorkspaceReload();
    });
  };

  const discover = async (): Promise<void> => {
    await run("discover", async () => {
      const value = await requestJson("/v1/watchlist/suggestions");
      const discovered = Array.isArray(value) ? value.filter(isRepo) : [];
      setSuggestions(discovered);
      setFeedback(discovered.length === 0 ? "No new repositories found in the configured workspace roots." : `Found ${discovered.length} new ${discovered.length === 1 ? "repository" : "repositories"}.`);
    });
  };

  const addSuggestion = async (repo: Repo): Promise<void> => {
    await run(`suggestion:${repositoryKey(repo)}`, async () => {
      await requestJson("/v1/watchlist", { method: "POST", body: repo });
      setSuggestions((current) => current.filter((item) => repositoryKey(item) !== repositoryKey(repo)));
      await onWorkspaceReload();
    });
  };

  const choosePath = async (repo: Repo): Promise<void> => {
    const selected = await selectDirectory(paths[repositoryKey(repo)] ?? repo.localPath);
    if (selected === undefined) {
      setFeedback("Folder selection cancelled. The existing repository path was not changed.");
      return;
    }
    setPaths((current) => ({ ...current, [repositoryKey(repo)]: selected }));
    setFeedback(`Selected ${selected} for ${repo.owner}/${repo.repo}. Save the path to apply it.`);
  };

  const savePath = async (repo: Repo): Promise<void> => {
    await run(`path:${repositoryKey(repo)}`, async () => {
      await requestJson("/v1/watchlist/path", {
        method: "PATCH",
        body: { ...repo, localPath: paths[repositoryKey(repo)] ?? repo.localPath ?? "" },
      });
      setFeedback(`Saved the local path for ${repo.owner}/${repo.repo}.`);
      await onWorkspaceReload();
    });
  };

  const refreshRepo = async (repo: Repo): Promise<void> => {
    await run(`refresh:${repositoryKey(repo)}`, async () => {
      const value = await requestJson("/v1/dashboard/refresh/repository", { method: "POST", body: repo });
      onRepositoryRefresh(value, repo);
      setFeedback(`Refreshed ${repo.owner}/${repo.repo}.`);
    });
  };

  const archiveRepo = async (repo: Repo): Promise<void> => {
    await run(`archive:${repositoryKey(repo)}`, async () => {
      await requestJson("/v1/watchlist/archive", { method: "PATCH", body: { ...repo, archived: repo.archived !== true } });
      setFeedback(`${repo.archived ? "Restored" : "Archived"} ${repo.owner}/${repo.repo}.`);
      await onWorkspaceReload();
    });
  };

  const confirmRemoval = async (): Promise<void> => {
    if (removalTarget === undefined || pending === "remove") return;
    setPending("remove");
    setRemovalError(undefined);
    try {
      await requestJson("/v1/watchlist", { method: "DELETE", body: removalTarget });
      setRemovalTarget(undefined);
      setFeedback(`Removed ${removalTarget.owner}/${removalTarget.repo} from the watchlist.`);
      await onWorkspaceReload();
    } catch (cause: unknown) {
      setRemovalError(cause instanceof Error ? cause.message : "Patchdesk could not remove this repository.");
    } finally {
      setPending(undefined);
    }
  };

  return (
    <section aria-labelledby="watchlist-management-title" data-testid="watchlist-management">
      <Card>
        <CardHeader className="p-3">
          <CardTitle id="watchlist-management-title" className="text-sm">Watchlist</CardTitle>
          <CardDescription className="text-xs">Manage repositories in the active queue. Saved review history remains local.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 p-3 pt-0">
          <div className="flex flex-col gap-2">
            <Label htmlFor="watchlist-repository">Repository</Label>
            <Input id="watchlist-repository" value={newRepo} onChange={(event) => setNewRepo(event.target.value)} placeholder="owner/repository" />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => { void addRepo(); }} disabled={pending !== undefined} aria-label="Add repository">Add repository</Button>
              <Button size="sm" variant="outline" onClick={() => { void discover(); }} disabled={pending !== undefined} aria-label="Discover"><Search /> Discover</Button>
            </div>
          </div>
          {feedback === undefined ? null : <p role="status" aria-live="polite" className="text-xs text-muted-foreground">{feedback}</p>}
          {error === undefined ? null : <Alert variant="destructive"><AlertTitle>Watchlist action failed</AlertTitle><AlertDescription role="alert">{error}</AlertDescription></Alert>}
          {suggestions.length === 0 ? null : (
            <div className="flex flex-col gap-2" aria-label="Repository suggestions">
              {suggestions.map((repo) => <div key={repositoryKey(repo)} className="flex items-center justify-between gap-2 rounded-md border p-2 text-xs"><span>{repo.owner}/{repo.repo}</span><Button size="sm" variant="outline" disabled={pending !== undefined} onClick={() => { void addSuggestion(repo); }}>Add suggestion</Button></div>)}
            </div>
          )}
          <div className="flex flex-col gap-2" aria-label="Watched repositories">
            {repositories.map(({ repo: sourceRepo }) => {
              const repo = normalizeRepo(sourceRepo);
              if (repo === undefined) return null;
              const repoLabel = `${repo.owner}/${typeof repo.repo === "string" ? repo.repo : ""}`;
              const repoKey = repositoryKey(repo);
              const busy = pending?.endsWith(repoKey) === true || pending === "remove";
              return (
                <div key={repoKey} className="rounded-md border p-2 text-xs">
                  <div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate font-medium">{repoLabel}</span><span className="text-muted-foreground">{repo.archived ? "Archived" : "Active"}</span></div>
                  <Label htmlFor={`watchlist-path-${repoKey}`} className="mt-2 block">Local path</Label>
                  <Input id={`watchlist-path-${repoKey}`} value={paths[repoKey] ?? repo.localPath ?? ""} onChange={(event) => setPaths((current) => ({ ...current, [repoKey]: event.target.value }))} placeholder="/absolute/repository/path" />
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => { void choosePath(repo); }} aria-label={`Choose folder for ${repoLabel}`}>Choose folder</Button>
                    <Button size="sm" disabled={busy} onClick={() => { void savePath(repo); }} aria-label={`Save path for ${repoLabel}`}>Save path</Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => { void refreshRepo(repo); }} aria-label={`Refresh ${repoLabel}`}><RefreshCw /> Refresh</Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => { void archiveRepo(repo); }} aria-label={`${repo.archived ? "Restore" : "Archive"} ${repoLabel}`}><Archive /> {repo.archived ? "Restore" : "Archive"}</Button>
                    <Button size="sm" variant="destructive" disabled={busy} onClick={() => { setRemovalError(undefined); setRemovalTarget(repo); }} aria-label={`Remove ${repoLabel}`}><Trash2 /> Remove</Button>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
      <AlertDialog open={removalTarget !== undefined} onOpenChange={(open) => { if (!open && pending !== "remove") { setRemovalTarget(undefined); setRemovalError(undefined); } }}>
        <AlertDialogContent aria-busy={pending === "remove"}>
          <AlertDialogHeader><AlertDialogTitle>Remove {removalTarget?.owner}/{removalTarget?.repo} from the watchlist?</AlertDialogTitle><AlertDialogDescription>Saved review history and drafts remain on this Mac. Archive instead when you only want to hide a repository from the active queue.</AlertDialogDescription></AlertDialogHeader>
          {removalError === undefined ? null : <Alert variant="destructive"><AlertTitle>Repository was not removed</AlertTitle><AlertDescription>{removalError}</AlertDescription></Alert>}
          <AlertDialogFooter><AlertDialogCancel disabled={pending === "remove"}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={pending === "remove"} onClick={(event) => { event.preventDefault(); void confirmRemoval(); }}>{pending === "remove" ? "Removing…" : "Confirm removal"}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function repositoryKey(repo: Repo): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`;
}

function isRepo(value: unknown): value is Repo {
  return normalizeRepo(value) !== undefined;
}

function normalizeRepo(value: unknown): Repo | undefined {
  if (!record(value)) return undefined;
  if (typeof value.host === "string" && typeof value.owner === "string" && typeof value.repo === "string") {
    return {
      host: value.host,
      owner: value.owner,
      repo: value.repo,
      ...(typeof value.localPath === "string" ? { localPath: value.localPath } : {}),
      ...(typeof value.archived === "boolean" ? { archived: value.archived } : {}),
    };
  }
  return normalizeRepo(value.repo);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
