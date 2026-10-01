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
import type {
  InboxPreset,
  InboxStateFilter,
} from "../../../domain/maintainer-inbox";
import type { GitHubHost } from "../../../domain/ids";
import type { PullRequestRef } from "../../../domain/pull-request";
import type { RepositoryIdentity } from "../../../domain/repository-identity";
import { definedProps } from "../../../domain/defined-props";
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
import {
  VisitedPullRequests,
  type LocalRepositoryOpen,
} from "@/components/visited-pull-requests";
import {
  loadVisitedPullRequestsCollapsed,
  saveVisitedPullRequestsCollapsed,
} from "@/visited-pull-requests-preferences";
import type { ProfileSwitchState } from "@/hooks/use-profile-switch";
import { useWindowFullScreen } from "@/hooks/use-window-full-screen";
import { useVisitedPullRequestRows } from "@/hooks/use-visited-pull-request-rows";
import { isTextEntryTarget } from "../text-entry-target";
import {
  ReviewCommandRegistryContext,
  useReviewCommandRegistry,
} from "../review-commands";

type ProfileEntry = {
  readonly id: string;
  readonly label: string;
};

/** `returnFocus` is where a leave dialog's Stay puts focus back, since the chosen option is gone by then (#657). */
type AppShellProfileSwitch = (
  id: string,
  returnFocus: HTMLElement | null,
) => void;

export function AppShell({
  destination,
  navigationBlocked = false,
  onNavigate,
  onOpenLocalReview,
  onOpenSettings,
  onOpenDiagnostics,
  profiles,
  activeProfileId,
  profileSwitchState,
  onProfileSwitch,
  onInboxStateChange,
  onInboxPresetChange,
  pullRequestDefaultHost,
  onOpenPullRequest,
  selectedRepository,
  visitedReloadKey,
  children,
}: {
  readonly destination: AppDestination;
  readonly navigationBlocked?: boolean;
  readonly onNavigate: (destination: AppDestination) => void;
  readonly onOpenLocalReview: LocalRepositoryOpen;
  readonly onOpenSettings: (opener?: HTMLElement) => void;
  readonly onOpenDiagnostics: (opener?: HTMLElement) => void;
  readonly profiles?: ReadonlyArray<ProfileEntry>;
  readonly activeProfileId?: string;
  readonly profileSwitchState?: ProfileSwitchState;
  readonly onProfileSwitch?: AppShellProfileSwitch;
  /** Jumps the Pull requests screen to an open/merged preset from
   * `INBOX_STATE_FILTERS` — the palette and the filter bar share this one
   * list so the two surfaces cannot drift. A prop, not a window
   * event: `App` renders both `AppShell` and the Pull requests screen from
   * the same call, so the state change reaches it directly. Absent before
   * the Pull requests screen exists (fixture routes, first paint) — the
   * "Pull requests" command group hides itself in that case rather than
   * dispatching into nothing. */
  readonly onInboxStateChange?: (state: InboxStateFilter) => void;
  /** Sets the Pull requests screen's one-click preset from the palette; absent for the same reason `onInboxStateChange` is. */
  readonly onInboxPresetChange?: (preset: InboxPreset) => void;
  /** Parses compact references against the active profile's GitHub host. */
  readonly pullRequestDefaultHost?: GitHubHost;
  /** Opens a parsed pull request through the root Review-opening owner. */
  readonly onOpenPullRequest?: (ref: PullRequestRef) => void;
  /** The Pull requests screen's Selected repository, which a bare number typed in the palette opens in. */
  readonly selectedRepository?: RepositoryIdentity;
  /** Re-reads the visited pull requests whenever it moves: `App` bumps it on every Review open. */
  readonly visitedReloadKey: number;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const reviewCommands = useReviewCommandRegistry();
  const mainRef = useRef<HTMLElement | null>(null);
  const navigateOpenerRef = useRef<HTMLButtonElement | null>(null);
  const [visitedCollapsed, setVisitedCollapsed] = useState(
    loadVisitedPullRequestsCollapsed,
  );
  const [initialDestinationKey] = useState(() => destinationKey(destination));
  const lastSeenDestination = useRef(initialDestinationKey);
  const focusedDestination = useRef<string | null>(initialDestinationKey);
  const windowFullScreen = useWindowFullScreen();
  const [visitedExpandCount, setVisitedExpandCount] = useState(0);
  // Loaded even while the column is collapsed, because the palette searches the
  // same rows; both keys only grow, so their sum moves whenever either does.
  const visitedRows = useVisitedPullRequestRows(
    activeProfileId ?? "",
    visitedReloadKey + visitedExpandCount,
  );
  const activeProfileLabel = profiles?.find(
    (profile) => profile.id === activeProfileId,
  )?.label;
  const backLabel = "Back to pending pull requests";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        if (isTextEntryTarget(event)) return;
        event.preventDefault();
        if (navigationBlocked) return;
        setCommandQuery("");
        setCommandOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigationBlocked]);

  const currentDestinationKey = destinationKey(destination);
  const currentDestinationTitle = destinationTitle(destination);
  useEffect(() => {
    document.title = `${currentDestinationTitle} · Patchdesk`;
  }, [currentDestinationTitle]);

  // Keyed on the destination string: the app passes a fresh destination object
  // on every render, and a re-render before the frame must not cancel the focus.
  // A lazy screen may not have painted its heading by the next frame, so the
  // focus waits for the heading to appear.
  useEffect(() => {
    // A change back to a destination whose heading never took focus still needs it.
    if (lastSeenDestination.current !== currentDestinationKey) {
      lastSeenDestination.current = currentDestinationKey;
      focusedDestination.current = null;
    }
    if (focusedDestination.current === currentDestinationKey) return;
    const main = mainRef.current;
    if (main === null) return;
    let observer: MutationObserver | undefined;
    const focusHeading = (): boolean => {
      const heading = main.querySelector<HTMLElement>("h1");
      if (heading === null) return false;
      heading.tabIndex = -1;
      heading.focus();
      focusedDestination.current = currentDestinationKey;
      return true;
    };
    const frame = window.requestAnimationFrame(() => {
      if (focusHeading()) return;
      observer = new MutationObserver(() => {
        if (focusHeading()) observer?.disconnect();
      });
      observer.observe(main, { childList: true, subtree: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [currentDestinationKey]);

  useCompactDensity();

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
          <VisitedToggle
            collapsed={visitedCollapsed}
            onToggle={() => {
              const next = !visitedCollapsed;
              setVisitedCollapsed(next);
              saveVisitedPullRequestsCollapsed(next);
              if (!next) setVisitedExpandCount((count) => count + 1);
            }}
          />
          {destination.kind === "workbench" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={backLabel}
                    onClick={() => onNavigate({ kind: "dashboard" })}
                  />
                }
              >
                <ArrowLeft />
              </TooltipTrigger>
              <TooltipContent>{backLabel}</TooltipContent>
            </Tooltip>
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
            <TitlebarWorkspaceSwitcher
              profiles={profiles}
              activeProfileId={activeProfileId}
              activeProfileLabel={activeProfileLabel}
              profileSwitchState={profileSwitchState}
              onProfileSwitch={onProfileSwitch}
            />
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
                ? "A pending GitHub write blocks navigation."
                : "Open quick navigation"}
            </TooltipContent>
          </Tooltip>
        </div>
        <BusyIndicator />
      </header>
      <div className="app-frame min-h-0 flex-1">
        {visitedCollapsed ? null : (
          <VisitedPullRequests
            state={visitedRows}
            destination={destination}
            onNavigate={onNavigate}
            onOpenLocalReview={onOpenLocalReview}
            workspaceLabel={activeProfileLabel}
            {...(pullRequestDefaultHost === undefined
              ? {}
              : { host: pullRequestDefaultHost })}
          />
        )}
        <main
          ref={mainRef}
          id="main-content"
          tabIndex={-1}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-t-lg border border-b-0 bg-background"
        >
          <ReviewCommandRegistryContext.Provider
            value={reviewCommands.register}
          >
            {children}
          </ReviewCommandRegistryContext.Provider>
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
        onOpenDiagnostics={onOpenDiagnostics}
        {...(onInboxStateChange === undefined ? {} : { onInboxStateChange })}
        {...(onInboxPresetChange === undefined ? {} : { onInboxPresetChange })}
        {...(onOpenPullRequest === undefined ? {} : { onOpenPullRequest })}
        {...definedProps({ selectedRepository })}
        reviewCommands={reviewCommands.source}
        visitedRows={visitedRows.kind === "loaded" ? visitedRows.rows : []}
      />
    </div>
  );
}

function useCompactDensity(): void {
  useEffect(() => {
    document.documentElement.dataset.patchdeskDensity = "compact";
    return () => {
      delete document.documentElement.dataset.patchdeskDensity;
    };
  }, []);
}

/** Collapses or expands the Visited pull requests column. */
function VisitedToggle({
  collapsed,
  onToggle,
}: {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}): React.JSX.Element {
  const label = collapsed
    ? "Expand the reviews you have opened"
    : "Collapse the reviews you have opened";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-controls="visited-pull-requests"
            aria-expanded={!collapsed}
            onClick={onToggle}
          />
        }
      >
        {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** The titlebar's Active workspace select, with its switch progress and error. */
function TitlebarWorkspaceSwitcher({
  profiles,
  activeProfileId,
  activeProfileLabel,
  profileSwitchState,
  onProfileSwitch,
}: {
  readonly profiles: ReadonlyArray<ProfileEntry>;
  readonly activeProfileId: string | undefined;
  readonly activeProfileLabel: string | undefined;
  readonly profileSwitchState: ProfileSwitchState | undefined;
  readonly onProfileSwitch: AppShellProfileSwitch | undefined;
}): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div className="flex items-center gap-1.5">
      <Select
        value={activeProfileId ?? ""}
        items={profiles.map((profile) => ({
          label: profile.label,
          value: profile.id,
        }))}
        onValueChange={(value) => {
          if (value !== null && onProfileSwitch !== undefined)
            onProfileSwitch(value, triggerRef.current);
        }}
      >
        <SelectTrigger
          ref={triggerRef}
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
            (profile) => profile.id === profileSwitchState.pendingTarget,
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
  );
}
