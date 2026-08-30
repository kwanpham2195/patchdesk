import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  GitPullRequest,
  Search,
  Settings,
  User,
} from "lucide-react";

import type { AppDestination } from "@/routes";
import {
  destinationKey,
  destinationTitle,
  primaryDestinations,
} from "@/routes";
import {
  INBOX_STATE_FILTERS,
  type InboxStateFilter,
} from "../../../domain/maintainer-inbox";
import { BrandMark } from "@/components/brand-mark";
import { BusyIndicator } from "@/components/busy-indicator";
import { Button } from "@/components/ui/button";
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
import type { ProfileSwitchState } from "@/hooks/use-profile-switch";
const icons = {
  dashboard: GitPullRequest,
  settings: Settings,
} as const;

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
  /** Jumps the Maintainer inbox to an open/merged preset from
   * `INBOX_STATE_FILTERS` — the palette and the filter bar share this one
   * list so the two surfaces cannot drift. A prop, not a window
   * event: `App` renders both `AppShell` and the inbox screen from the same
   * call, so the state change reaches it directly. Absent before the inbox
   * screen exists (fixture routes, first paint) — the "Inbox" command group
   * hides itself in that case rather than dispatching into nothing. */
  readonly onInboxStateChange?: (state: InboxStateFilter) => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const [commandOpen, setCommandOpen] = useState(false);
  const mainRef = useRef<HTMLElement | null>(null);
  const navigateOpenerRef = useRef<HTMLButtonElement | null>(null);
  const [initialDestinationKey] = useState(() => destinationKey(destination));
  const focusedDestination = useRef(initialDestinationKey);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (navigationBlocked) return;
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

  const go = (next: AppDestination): void => {
    setCommandOpen(false);
    onNavigate(next);
  };
  const chooseInboxState = (state: InboxStateFilter): void => {
    setCommandOpen(false);
    onNavigate({ kind: "dashboard" });
    onInboxStateChange?.(state);
  };
  const openSelectedInboxAction = (): void => {
    setCommandOpen(false);
    onNavigate({ kind: "dashboard" });
    window.setTimeout(
      () => window.dispatchEvent(new Event("patchdesk:inbox-action")),
      0,
    );
  };
  return (
    <div className="compact-surface flex h-screen min-h-screen w-full flex-col bg-background text-foreground">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="app-titlebar relative">
        <div className="flex min-w-0 items-center gap-2">
          {destination.kind === "workbench" ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Back to pending pull requests"
              onClick={() => go({ kind: "dashboard" })}
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
                  aria-label="Active profile"
                  className="h-7 gap-1 border-0 bg-transparent px-1.5 text-xs hover:bg-muted"
                >
                  <User className="size-3" />
                  <SelectValue placeholder="Select profile">
                    {profiles.find((p) => p.id === activeProfileId)?.label ??
                      "Profile"}
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
                  )?.label ?? "profile"}
                  …
                </span>
              ) : null}
              {profileSwitchState?.error?.owner === "header" ? (
                <span className="text-xs text-destructive" role="alert">
                  {profileSwitchState.error.message}
                </span>
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
                  onClick={() => setCommandOpen(true)}
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
        <main
          ref={mainRef}
          id="main-content"
          tabIndex={-1}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        >
          {children}
        </main>
      </div>
      <CommandDialog
        open={commandOpen && !navigationBlocked}
        onOpenChange={(open) => {
          if (!navigationBlocked) setCommandOpen(open);
        }}
        title="Navigate Patchdesk"
        description="Open a Patchdesk destination"
      >
        <Command>
          <CommandInput placeholder="Search views and actions…" />
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
            <CommandGroup heading="Actions">
              <CommandItem
                value="Settings"
                onSelect={() => {
                  setCommandOpen(false);
                  onOpenSettings(navigateOpenerRef.current ?? undefined);
                }}
              >
                <Settings />
                Settings
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Inbox">
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
    </div>
  );
}
