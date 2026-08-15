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
import { BrandMark } from "@/components/brand-mark";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
const icons = {
  dashboard: GitPullRequest,
  settings: Settings,
} as const;

const inboxCommands = [
  ["my_inbox", "My inbox"],
  ["updated", "Updated pull requests"],
  ["needs_review", "Needs review"],
  ["waiting", "Waiting for author"],
  ["checks_failing", "Checks failing"],
  ["ready_to_merge", "Ready to merge"],
  ["all_open", "All open pull requests"],
] as const;

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
  onProfileSwitch,
  children,
}: {
  readonly destination: AppDestination;
  readonly navigationBlocked?: boolean;
  readonly onNavigate: (destination: AppDestination) => void;
  readonly onOpenSettings: (opener?: HTMLElement) => void;
  readonly profiles?: ReadonlyArray<ProfileEntry>;
  readonly activeProfileId?: string;
  readonly onProfileSwitch?: (id: string) => void;
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
  const chooseInboxView = (view: string): void => {
    setCommandOpen(false);
    onNavigate({ kind: "dashboard" });
    window.setTimeout(
      () =>
        window.dispatchEvent(
          new CustomEvent("patchdesk:inbox-view", { detail: view }),
        ),
      0,
    );
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
      <header className="app-titlebar">
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
                {profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
              {inboxCommands.map(([id, label]) => (
                <CommandItem
                  key={id}
                  value={label}
                  onSelect={() => chooseInboxView(id)}
                >
                  <GitPullRequest />
                  {label}
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
