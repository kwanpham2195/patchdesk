import type { RefObject } from "react";
import {
  Activity,
  ArrowLeft,
  Eye,
  EyeOff,
  GitPullRequest,
  Settings,
} from "lucide-react";

import {
  INBOX_PRESET_FILTERS,
  INBOX_STATE_FILTERS,
  type InboxPreset,
  type InboxStateFilter,
} from "../../../domain/maintainer-inbox";
import type { GitHubHost } from "../../../domain/ids";
import {
  parsePullRequestInput,
  parsePullRequestRef,
  type PullRequestRef,
} from "../../../domain/pull-request";
import type { RepositoryIdentity } from "../../../domain/repository-identity";
import type { SidebarReviewRow } from "@/renderer-contracts";
import type { AppDestination } from "@/routes";
import { destinationKey, primaryDestinations } from "@/routes";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import {
  useWatchedPullRequests,
  type WatchToggleFailure,
} from "@/hooks/use-watched-pull-requests";
import { WatchToggleFailureMessage } from "./watch-pull-request-button";

const icons = {
  dashboard: GitPullRequest,
  settings: Settings,
} as const;

export function AppCommandDialog({
  open,
  query,
  navigationBlocked,
  destination,
  settingsOpenerRef,
  pullRequestDefaultHost,
  onOpenChange,
  onQueryChange,
  onNavigate,
  onOpenSettings,
  onOpenDiagnostics,
  onInboxStateChange,
  onInboxPresetChange,
  onOpenPullRequest,
  selectedRepository,
  visitedRows,
}: {
  readonly open: boolean;
  readonly query: string;
  readonly navigationBlocked: boolean;
  readonly destination: AppDestination;
  readonly settingsOpenerRef: RefObject<HTMLButtonElement | null>;
  readonly pullRequestDefaultHost?: GitHubHost;
  readonly onOpenChange: (open: boolean) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onNavigate: (destination: AppDestination) => void;
  readonly onOpenSettings: (opener?: HTMLElement) => void;
  readonly onOpenDiagnostics: (opener?: HTMLElement) => void;
  readonly onInboxStateChange?: (state: InboxStateFilter) => void;
  /** Sets the one-click preset rather than toggling it, the way the state
   * commands set the state; the filter bar's toggles are the off switch. */
  readonly onInboxPresetChange?: (preset: InboxPreset) => void;
  readonly onOpenPullRequest?: (ref: PullRequestRef) => void;
  /** Where a bare `345` or `#345` opens; without one a bare number offers nothing. */
  readonly selectedRepository?: RepositoryIdentity;
  /** The Visited pull requests rows a title search matches; the palette requests nothing itself. */
  readonly visitedRows: ReadonlyArray<SidebarReviewRow>;
}): React.JSX.Element {
  const parsedPullRequest = parsePullRequestInput(
    query.trim(),
    pullRequestDefaultHost,
  );
  const pullRequestResults =
    onOpenPullRequest === undefined || pullRequestDefaultHost === undefined
      ? []
      : pullRequestSearchResults(
          query.trim(),
          selectedRepository,
          visitedRows,
          pullRequestDefaultHost,
        );
  const watch = useWatchedPullRequests();

  const close = (): void => {
    onQueryChange("");
    onOpenChange(false);
  };
  const go = (next: AppDestination): void => {
    close();
    onNavigate(next);
  };
  const chooseInboxState = (state: InboxStateFilter): void => {
    close();
    onNavigate({ kind: "dashboard" });
    onInboxStateChange?.(state);
  };
  const chooseInboxPreset = (preset: InboxPreset): void => {
    close();
    onNavigate({ kind: "dashboard" });
    onInboxPresetChange?.(preset);
  };
  const openSelectedInboxAction = (): void => {
    close();
    onNavigate({ kind: "dashboard" });
    window.setTimeout(
      () => window.dispatchEvent(new Event("patchdesk:inbox-action")),
      0,
    );
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (navigationBlocked) return;
        if (!nextOpen) onQueryChange("");
        onOpenChange(nextOpen);
      }}
      title="Navigate Patchdesk"
      description="Open a Patchdesk destination"
      // A fixed top edge keeps the input still while results filter; a centred dialog moves with its height.
      className="top-[15vh] translate-y-0"
    >
      <Command label="Search views and actions">
        <CommandInput
          placeholder="Search views and actions…"
          value={query}
          onValueChange={onQueryChange}
        />
        <CommandList>
          <CommandEmpty>No matching destination.</CommandEmpty>
          <CommandGroup heading="Navigate">
            {primaryDestinations.map((item) => {
              const Icon = icons[item.kind];
              return (
                <CommandItem
                  key={item.kind}
                  value={item.label}
                  onSelect={() => go({ kind: item.kind })}
                >
                  <Icon />
                  {item.label}
                  {destinationKey(destination) === item.kind ? (
                    <CommandShortcut>Current</CommandShortcut>
                  ) : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
          <CommandSeparator />
          {(parsedPullRequest._tag === "ok" || pullRequestResults.length > 0) &&
          onOpenPullRequest !== undefined ? (
            <>
              <CommandGroup heading="Open pull request">
                {parsedPullRequest._tag === "ok" ? (
                  <CommandItem
                    value={`${query} Open ${parsedPullRequest.value.owner}/${parsedPullRequest.value.repo}#${parsedPullRequest.value.number}`}
                    onSelect={() => {
                      close();
                      onOpenPullRequest(parsedPullRequest.value);
                    }}
                  >
                    <GitPullRequest />
                    Open {parsedPullRequest.value.owner}/
                    {parsedPullRequest.value.repo}#
                    {parsedPullRequest.value.number}
                  </CommandItem>
                ) : null}
                {pullRequestResults.map((result) => (
                  <CommandItem
                    key={result.key}
                    value={`${query} ${result.key}`}
                    onSelect={() => {
                      close();
                      onOpenPullRequest(result.ref);
                    }}
                  >
                    <GitPullRequest />
                    {result.title === undefined ? (
                      <span>{result.reference}</span>
                    ) : (
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{result.title}</span>
                        <span className="text-xs text-muted-foreground">
                          {result.reference}
                        </span>
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
            </>
          ) : null}
          <CommandGroup heading="Actions">
            <CommandItem
              value="Settings"
              onSelect={() => {
                close();
                onOpenSettings(settingsOpenerRef.current ?? undefined);
              }}
            >
              <Settings />
              Settings
            </CommandItem>
            <CommandItem
              value="Diagnostics"
              onSelect={() => {
                close();
                onOpenDiagnostics(settingsOpenerRef.current ?? undefined);
              }}
            >
              <Activity />
              Diagnostics
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Pull requests">
            {INBOX_STATE_FILTERS.map((option) => (
              <CommandItem
                key={option.state}
                value={option.label}
                onSelect={() => chooseInboxState(option.state)}
              >
                <GitPullRequest />
                {option.label}
              </CommandItem>
            ))}
            {INBOX_PRESET_FILTERS.map((option) => (
              <CommandItem
                key={option.preset}
                value={option.label}
                onSelect={() => chooseInboxPreset(option.preset)}
              >
                <GitPullRequest />
                {option.label}
              </CommandItem>
            ))}
            <CommandItem
              value="Open selected pull request action"
              onSelect={openSelectedInboxAction}
            >
              <ArrowLeft className="rotate-180" />
              Open selected pull request
            </CommandItem>
            {parsedPullRequest._tag === "ok" && watch !== undefined ? (
              <WatchCommand
                pullRequest={parsedPullRequest.value}
                watched={watch.isWatched(parsedPullRequest.value)}
                failure={watch.failureFor(parsedPullRequest.value)}
                query={query}
                onSelect={() => {
                  void watch.toggle(parsedPullRequest.value).then((failure) => {
                    if (failure === undefined) close();
                  });
                }}
              />
            ) : null}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

type PullRequestSearchResult = {
  /** Unique among the results, and the text the palette filters on. */
  readonly key: string;
  readonly ref: PullRequestRef;
  readonly title: string | undefined;
  readonly reference: string;
};

/**
 * The pull requests a query names without a full reference: a bare number or
 * `#number` in the Selected repository, and Visited rows whose title contains
 * the query. Both read data already on screen, so typing requests nothing.
 */
function pullRequestSearchResults(
  query: string,
  selectedRepository: RepositoryIdentity | undefined,
  visitedRows: ReadonlyArray<SidebarReviewRow>,
  host: GitHubHost,
): ReadonlyArray<PullRequestSearchResult> {
  const numberMatch = /^#?(\d+)$/.exec(query);
  if (numberMatch !== null) {
    if (selectedRepository === undefined) return [];
    const parsed = parsePullRequestRef({
      ...selectedRepository,
      number: Number(numberMatch[1]),
    });
    if (parsed._tag === "err") return [];
    const label = `Open #${parsed.value.number} in ${parsed.value.owner}/${parsed.value.repo}`;
    return [
      {
        key: label,
        ref: parsed.value,
        title: undefined,
        reference: label,
      },
    ];
  }
  const needle = query.toLowerCase();
  if (needle === "") return [];
  return visitedRows.flatMap((row) => {
    if (row.title?.toLowerCase().includes(needle) !== true) return [];
    const parsed = parsePullRequestRef({ ...row, host });
    if (parsed._tag === "err") return [];
    const reference = `${row.owner}/${row.repo}#${row.number}`;
    return [
      {
        key: `${row.title} ${reference}`,
        ref: parsed.value,
        title: row.title,
        reference,
      },
    ];
  });
}

/** Watch or Unwatch the pull request the query names; a refusal stays visible in the palette. */
function WatchCommand({
  pullRequest,
  watched,
  failure,
  query,
  onSelect,
}: {
  readonly pullRequest: PullRequestRef;
  readonly watched: boolean;
  readonly failure: WatchToggleFailure | undefined;
  readonly query: string;
  readonly onSelect: () => void;
}): React.JSX.Element {
  const Icon = watched ? EyeOff : Eye;
  const label = `${watched ? "Unwatch" : "Watch"} ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`;
  return (
    <CommandItem value={`${query} ${label}`} onSelect={onSelect}>
      <Icon />
      <span className="flex flex-col">
        <span>{label}</span>
        {failure === undefined ? null : (
          <WatchToggleFailureMessage failure={failure} />
        )}
      </span>
    </CommandItem>
  );
}
