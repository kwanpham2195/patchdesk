import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  User,
} from "lucide-react";

import type { AppDestination } from "@/routes";
import { destinationKey, destinationTitle } from "@/routes";
import type { InboxStateFilter } from "../../../domain/maintainer-inbox";
import type { GitHubHost } from "../../../domain/ids";
import type { PullRequestRef } from "../../../domain/pull-request";
import { AppCommandDialog } from "@/components/app-command-dialog";
import { BrandMark } from "@/components/brand-mark";
import { BusyIndicator } from "@/components/busy-indicator";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { VisitedPullRequests } from "@/components/visited-pull-requests";
import {
  loadVisitedPullRequestsCollapsed,
  saveVisitedPullRequestsCollapsed,
} from "@/visited-pull-requests-preferences";
import type { ProfileSwitchState } from "@/hooks/use-profile-switch";
import { useWindowFullScreen } from "@/hooks/use-window-full-screen";
import { isTextEntryTarget } from "../text-entry-target";

type ProfileEntry = {
  readonly id: string;
  readonly label: string;
};

export function AppShell({
  destination,
  navigationBlocked = false,
  onNavigate,
  onOpenSettings,
  profiles,
  activeProfileId,
  profileSwitchState,
  onProfileSwitch,
  onInboxStateChange,
  pullRequestDefaultHost,
  onOpenPullRequest,
  visitedReloadKey,
  children,
}: {
  readonly destination: AppDestination;
  readonly navigationBlocked?: boolean;
  readonly onNavigate: (destination: AppDestination) => void;
  readonly onOpenSettings: (opener?: HTMLElement) => void;
  readonly profiles?: ReadonlyArray<ProfileEntry>;
  readonly activeProfileId?: string;
  readonly profileSwitchState?: ProfileSwitchState;
  readonly onProfileSwitch?: (id: string) => void;
  /** Jumps the Pull requests screen to an open/merged preset from
   * `INBOX_STATE_FILTERS` — the palette and the filter bar share this one
   * list so the two surfaces cannot drift. A prop, not a window
   * event: `App` renders both `AppShell` and the Pull requests screen from
   * the same call, so the state change reaches it directly. Absent before
   * the Pull requests screen exists (fixture routes, first paint) — the
   * "Pull requests" command group hides itself in that case rather than
   * dispatching into nothing. */
  readonly onInboxStateChange?: (state: InboxStateFilter) => void;
  /** Parses compact references against the active profile's GitHub host. */
  readonly pullRequestDefaultHost?: GitHubHost;
  /** Opens a parsed pull request through the root Review-opening owner. */
  readonly onOpenPullRequest?: (ref: PullRequestRef) => void;
  /** Re-reads the visited pull requests whenever it moves: `App` bumps it on every Review open. */
  readonly visitedReloadKey: number;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const mainRef = useRef<HTMLElement | null>(null);
  const navigateOpenerRef = useRef<HTMLButtonElement | null>(null);
  const [visitedCollapsed, setVisitedCollapsed] = useState(
    loadVisitedPullRequestsCollapsed,
  );
  const [initialDestinationKey] = useState(() => destinationKey(destination));
  const focusedDestination = useRef(initialDestinationKey);
  const windowFullScreen = useWindowFullScreen();
  const activeProfileLabel = profiles?.find(
    (profile) => profile.id === activeProfileId,
  )?.label;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        if (isTextEntryTarget(event.target)) return;
        event.preventDefault();
        if (navigationBlocked) return;
        setCommandQuery("");
        setCommandOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigationBlocked]);

  useEffect(() => {
    document.title = `${destinationTitle(destination)} · Patchdesk`;
    const nextKey = destinationKey(destination);
    if (focusedDestination.current === nextKey) return;
    focusedDestination.current = nextKey;
    const frame = window.requestAnimationFrame(() => {
      const heading = mainRef.current?.querySelector<HTMLElement>("h1");
      if (heading === undefined || heading === null) return;
      heading.tabIndex = -1;
      heading.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [destination]);

  useEffect(() => {
    document.documentElement.dataset.patchdeskDensity = "compact";
    return () => {
      delete document.documentElement.dataset.patchdeskDensity;
    };
  }, []);

  return (
    <div className="compact-surface flex h-screen min-h-screen w-full flex-col bg-shell text-foreground">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header
        className="app-titlebar relative"
        data-window-full-screen={windowFullScreen}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={
              visitedCollapsed
                ? "Expand the pull requests you have opened"
                : "Collapse the pull requests you have opened"
            }
            aria-controls="visited-pull-requests"
            aria-expanded={!visitedCollapsed}
            onClick={() => {
              const next = !visitedCollapsed;
              setVisitedCollapsed(next);
              saveVisitedPullRequestsCollapsed(next);
            }}
          >
            {visitedCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
          {destination.kind === "workbench" ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Back to pending pull requests"
              onClick={() => onNavigate({ kind: "dashboard" })}
            >
              <ArrowLeft />
            </Button>
          ) : null}
          <BrandMark size={26} />
          <span className="text-[13px] font-semibold tracking-tight">
            Patchdesk
          </span>
          <Separator orientation="vertical" className="mx-0.5 h-4" />
          <span className="truncate text-[13px] text-muted-foreground">
            {destinationTitle(destination)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {profiles !== undefined && profiles.length > 0 ? (
            <div className="flex items-center gap-1.5">
              <Select
                value={activeProfileId ?? ""}
                items={profiles.map((profile) => ({
                  label: profile.label,
                  value: profile.id,
                }))}
                onValueChange={(value) => {
                  if (value !== null && onProfileSwitch !== undefined)
                    onProfileSwitch(value);
                }}
              >
                <SelectTrigger
                  aria-label="Active workspace"
                  className="h-7 gap-1 border-0 bg-transparent px-1.5 text-xs hover:bg-muted"
                >
                  <User className="size-3" />
                  <SelectValue placeholder="Select workspace">
                    {activeProfileLabel ?? "Workspace"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {profiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {profileSwitchState?.pendingOwner === "header" ? (
                <span
                  className="flex items-center gap-1 text-xs text-muted-foreground"
                  role="status"
                >
                  <Spinner aria-hidden="true" className="size-3" />
                  Switching to{" "}
                  {profiles.find(
                    (profile) =>
                      profile.id === profileSwitchState.pendingTarget,
                  )?.label ?? "workspace"}
                  …
                </span>
              ) : null}
              {profileSwitchState?.error?.owner === "header" ? (
                <InlineError className="text-xs">
                  {profileSwitchState.error.message}
                </InlineError>
              ) : null}
            </div>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Settings"
                  disabled={navigationBlocked}
                  onClick={(event) => onOpenSettings(event.currentTarget)}
                />
              }
            >
              <Settings />
            </TooltipTrigger>
            <TooltipContent>Open Settings</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  ref={navigateOpenerRef}
                  data-settings-opener="navigate"
                  variant="outline"
                  size="sm"
                  disabled={navigationBlocked}
                  onClick={() => {
                    setCommandQuery("");
                    setCommandOpen(true);
                  }}
                />
              }
            >
              <Search />
              Navigate
              <Kbd className="ml-1.5 border border-border bg-muted text-[10px] text-muted-foreground">
                ⌘K
              </Kbd>
            </TooltipTrigger>
            <TooltipContent>
              {navigationBlocked
                ? "Finish or close the current dialog before navigating"
                : "Open quick navigation"}
            </TooltipContent>
          </Tooltip>
        </div>
        <BusyIndicator />
      </header>
      <div className="app-frame min-h-0 flex-1">
        {visitedCollapsed ? null : (
          <VisitedPullRequests
            profileId={activeProfileId ?? ""}
            destination={destination}
            onNavigate={onNavigate}
            reloadKey={visitedReloadKey}
            workspaceLabel={activeProfileLabel}
          />
        )}
        <main
          ref={mainRef}
          id="main-content"
          tabIndex={-1}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-t-lg border border-b-0 bg-background"
        >
          {children}
        </main>
      </div>
      <AppCommandDialog
        open={commandOpen && !navigationBlocked}
        query={commandQuery}
        navigationBlocked={navigationBlocked}
        destination={destination}
        settingsOpenerRef={navigateOpenerRef}
        {...(pullRequestDefaultHost === undefined
          ? {}
          : { pullRequestDefaultHost })}
        onOpenChange={setCommandOpen}
        onQueryChange={setCommandQuery}
        onNavigate={onNavigate}
        onOpenSettings={onOpenSettings}
        {...(onInboxStateChange === undefined ? {} : { onInboxStateChange })}
        {...(onOpenPullRequest === undefined ? {} : { onOpenPullRequest })}
      />
    </div>
  );
}
