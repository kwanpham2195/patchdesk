import type { RefObject } from "react";
import { ArrowLeft, GitPullRequest, Settings } from "lucide-react";

import {
  INBOX_STATE_FILTERS,
  type InboxStateFilter,
} from "../../../domain/maintainer-inbox";
import type { GitHubHost } from "../../../domain/ids";
import {
  parsePullRequestInput,
  type PullRequestRef,
} from "../../../domain/pull-request";
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
  onInboxStateChange,
  onOpenPullRequest,
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
  readonly onInboxStateChange?: (state: InboxStateFilter) => void;
  readonly onOpenPullRequest?: (ref: PullRequestRef) => void;
}): React.JSX.Element {
  const parsedPullRequest = parsePullRequestInput(
    query.trim(),
    pullRequestDefaultHost,
  );

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
          {parsedPullRequest._tag === "ok" &&
          onOpenPullRequest !== undefined ? (
            <CommandGroup heading="Open pull request">
              <CommandItem
                value={`${query} Open ${parsedPullRequest.value.owner}/${parsedPullRequest.value.repo}#${parsedPullRequest.value.number}`}
                onSelect={() => {
                  close();
                  onOpenPullRequest(parsedPullRequest.value);
                }}
              >
                <GitPullRequest />
                Open {parsedPullRequest.value.owner}/
                {parsedPullRequest.value.repo}#{parsedPullRequest.value.number}
              </CommandItem>
            </CommandGroup>
          ) : null}
          {parsedPullRequest._tag === "ok" &&
          onOpenPullRequest !== undefined ? (
            <CommandSeparator />
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
            <CommandItem
              value="Open selected pull request action"
              onSelect={openSelectedInboxAction}
            >
              <ArrowLeft className="rotate-180" />
              Open selected pull request
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
