import { FolderOpen, Plus, X } from "lucide-react";
import { useState } from "react";

import { parseGitHubOwner, parseGitHubRepoName } from "../../../domain/ids";
import { sameRepositoryIdentity } from "../../../domain/repository-identity";
import { requestJson } from "../api-client";
import { repositoryKey, type Profile, type Repo } from "../renderer-models";
import { chooseRepositoryCheckout } from "../watched-repository-checkout";
import { Button } from "../components/ui/button";
import { Field, FieldLabel } from "../components/ui/field";
import { InlineError } from "../components/ui/inline-error";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";

export type WatchedRepositoriesHook = {
  readonly pendingKeys: ReadonlySet<string>;
  readonly errorsByKey: ReadonlyMap<string, string>;
  readonly adding: boolean;
  readonly addError: string | undefined;
  /** Resolves true once the repository is watched, so the caller can clear its input. */
  readonly add: (input: string) => Promise<boolean>;
  readonly remove: (repository: Repo) => void;
  readonly chooseCheckout: (repository: Repo) => void;
};

/**
 * Owns the watchlist edits the Repositories card makes: add by `owner/repo`,
 * stop watching, and choose a repository's checkout with the folder picker.
 * Each request names the workspace on screen rather than the server's
 * selected one: a switch flips that selection as soon as
 * `POST /v1/profiles/select` resolves, while this card still shows the
 * previous workspace until the reload lands.
 */
// oxlint-disable-next-line react/only-export-components -- the hook shares this module with the list and form that consume it.
export function useWatchedRepositories(
  profile: Profile | undefined,
  onWorkspaceReload: () => Promise<void>,
): WatchedRepositoriesHook {
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [errorsByKey, setErrorsByKey] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string>();

  const setRowError = (key: string, message: string | undefined): void =>
    setErrorsByKey((current) => {
      const next = new Map(current);
      if (message === undefined) next.delete(key);
      else next.set(key, message);
      return next;
    });

  const runForRow = async (
    repository: Repo,
    action: (profileId: string) => Promise<boolean>,
  ): Promise<void> => {
    const key = repositoryKey(repository);
    if (profile === undefined) {
      setRowError(key, "Workspace still loading.");
      return;
    }
    setRowError(key, undefined);
    setPendingKeys((current) => new Set(current).add(key));
    try {
      if (await action(profile.id)) await onWorkspaceReload();
    } catch (cause: unknown) {
      setRowError(
        key,
        cause instanceof Error
          ? cause.message
          : "Patchdesk could not update the watchlist.",
      );
    } finally {
      setPendingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const add = async (input: string): Promise<boolean> => {
    if (profile === undefined) {
      setAddError("Workspace still loading.");
      return false;
    }
    const repository = parseRepositoryInput(input, profile.githubHost);
    if (repository === undefined) {
      setAddError("Enter a repository as owner/repo.");
      return false;
    }
    if (
      (profile.repos ?? []).some((watched) =>
        sameRepositoryIdentity(watched, repository),
      )
    ) {
      setAddError(`${repository.owner}/${repository.repo} is already watched.`);
      return false;
    }
    setAddError(undefined);
    setAdding(true);
    try {
      await putWatchlist(profile.id, { add: [repository], remove: [] });
      await onWorkspaceReload();
      return true;
    } catch (cause: unknown) {
      setAddError(
        cause instanceof Error
          ? cause.message
          : "Patchdesk could not update the watchlist.",
      );
      return false;
    } finally {
      setAdding(false);
    }
  };

  return {
    pendingKeys,
    errorsByKey,
    adding,
    addError,
    add,
    remove: (repository) =>
      void runForRow(repository, async (profileId) => {
        await putWatchlist(profileId, {
          add: [],
          remove: [
            {
              host: repository.host,
              owner: repository.owner,
              repo: repository.repo,
            },
          ],
        });
        return true;
      }),
    chooseCheckout: (repository) =>
      void runForRow(repository, (profileId) =>
        chooseRepositoryCheckout(profileId, repository),
      ),
  };
}

async function putWatchlist(
  profileId: string,
  change: {
    readonly add: ReadonlyArray<Repo>;
    readonly remove: ReadonlyArray<Repo>;
  },
): Promise<void> {
  await requestJson("/v1/watchlist", {
    method: "PUT",
    body: {
      profileId,
      add: change.add.map(({ host, owner, repo }) => ({ host, owner, repo })),
      remove: change.remove.map(({ host, owner, repo }) => ({
        host,
        owner,
        repo,
      })),
    },
  });
}

/** `owner/repo` on the workspace's GitHub host, or undefined when either half is not a valid GitHub name. */
function parseRepositoryInput(value: string, host: string): Repo | undefined {
  const parts = value.trim().split("/");
  if (parts.length !== 2) return undefined;
  const owner = parseGitHubOwner(parts[0]);
  const repo = parseGitHubRepoName(parts[1]);
  return owner._tag === "ok" && repo._tag === "ok"
    ? { host, owner: owner.value, repo: repo.value }
    : undefined;
}

/** The `owner/repo` field that adds a repository to the watchlist. */
export function AddWatchedRepositoryForm({
  watchlist,
}: {
  readonly watchlist: WatchedRepositoriesHook;
}): React.JSX.Element {
  const [value, setValue] = useState("");
  const submit = async (): Promise<void> => {
    if (await watchlist.add(value)) setValue("");
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Field>
        <FieldLabel htmlFor="watch-repository">Add a repository</FieldLabel>
        <div className="flex min-w-0 items-center gap-2">
          <Input
            id="watch-repository"
            value={value}
            placeholder="owner/repo"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={watchlist.addError === undefined ? undefined : true}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={watchlist.adding}
          >
            <Plus data-icon="inline-start" />
            Add
          </Button>
        </div>
        {watchlist.addError === undefined ? null : (
          <InlineError className="text-xs">{watchlist.addError}</InlineError>
        )}
      </Field>
    </form>
  );
}

/** The watched repositories, each with its checkout and the controls to choose it or stop watching. */
export function WatchedRepositoryList({
  repositories,
  watchlist,
}: {
  readonly repositories: ReadonlyArray<Repo>;
  readonly watchlist: WatchedRepositoriesHook;
}): React.JSX.Element {
  if (repositories.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        No repositories watched yet.
      </p>
    );
  return (
    <ul className="flex flex-col gap-1" aria-label="Watched repositories">
      {repositories.map((repository) => {
        const key = repositoryKey(repository);
        const name = `${repository.owner}/${repository.repo}`;
        const busy = watchlist.pendingKeys.has(key);
        const error = watchlist.errorsByKey.get(key);
        return (
          <li
            key={key}
            aria-label={name}
            className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {repository.localPath ?? "No checkout chosen"}
              </p>
              {busy ? (
                <Spinner
                  className="mt-1 size-3.5"
                  aria-label={`Updating ${name}`}
                />
              ) : null}
              {error === undefined ? null : (
                <InlineError className="text-xs">{error}</InlineError>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => watchlist.chooseCheckout(repository)}
            >
              <FolderOpen data-icon="inline-start" />
              Choose checkout
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    disabled={busy}
                    aria-label={`Stop watching ${name}`}
                    onClick={() => watchlist.remove(repository)}
                  />
                }
              >
                <X />
              </TooltipTrigger>
              <TooltipContent>Stop watching</TooltipContent>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
