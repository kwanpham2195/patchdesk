import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Archive,
  Clock3,
  FilePenLine,
  GitPullRequest,
  Search,
  Settings,
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
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  loadReviewViewPreferences,
  saveReviewViewPreferences,
} from "@/review-view-preferences";

const icons = {
  dashboard: GitPullRequest,
  drafts: FilePenLine,
  history: Clock3,
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

export function AppShell({
  destination,
  profileId,
  profileLabel,
  repositoryCount,
  workspacePanel,
  navigationBlocked = false,
  onNavigate,
  children,
}: {
  readonly destination: AppDestination;
  readonly profileId: string;
  readonly profileLabel: string;
  readonly repositoryCount: number;
  readonly workspacePanel?: React.ReactNode;
  readonly navigationBlocked?: boolean;
  readonly onNavigate: (destination: AppDestination) => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const [commandOpen, setCommandOpen] = useState(false);
  const [appRailOpen, setAppRailOpen] = useState(
    () => loadReviewViewPreferences(profileId).appRailOpen,
  );
  const mainRef = useRef<HTMLElement | null>(null);
  const focusedDestination = useRef(destinationKey(destination));

  useEffect(() => {
    setAppRailOpen(loadReviewViewPreferences(profileId).appRailOpen);
  }, [profileId]);

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
      () => window.dispatchEvent(new CustomEvent("patchdesk:inbox-view", { detail: view })),
      0,
    );
  };
  const openSelectedInboxAction = (): void => {
    setCommandOpen(false);
    onNavigate({ kind: "dashboard" });
    window.setTimeout(() => window.dispatchEvent(new Event("patchdesk:inbox-action")), 0);
  };

  return (
    <SidebarProvider
      open={appRailOpen}
      onOpenChange={(open) => {
        setAppRailOpen(open);
        saveReviewViewPreferences(profileId, { appRailOpen: open });
      }}
      className="min-h-screen flex-col"
    >
      <div className="compact-surface flex min-h-0 w-full flex-1 flex-col bg-background text-foreground">
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
          <SidebarTrigger
            aria-label={
              appRailOpen
                ? "Collapse application sidebar"
                : "Expand application sidebar"
            }
            aria-expanded={appRailOpen}
            aria-controls="workspace-navigation"
            className="size-7"
            onClick={() => {
              const next = !appRailOpen;
              saveReviewViewPreferences(profileId, { appRailOpen: next });
            }}
          />
          <BrandMark size={26} />
          <span className="text-[13px] font-semibold tracking-tight">Patchdesk</span>
          <Separator orientation="vertical" className="mx-0.5 h-4" />
          <span className="truncate text-[13px] text-muted-foreground">
            {destinationTitle(destination)}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={navigationBlocked}
              onClick={() => setCommandOpen(true)}
            >
              <Search />
              Navigate
              <Kbd className="ml-1.5 border border-border bg-muted text-[10px] text-muted-foreground">
                ⌘K
              </Kbd>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {navigationBlocked
              ? "Finish or close the current dialog before navigating"
              : "Open quick navigation"}
          </TooltipContent>
        </Tooltip>
      </header>
      <div
        className="app-frame min-h-0 flex-1"
        data-app-rail-open={appRailOpen}
      >
        <Sidebar
          id="workspace-navigation"
          className="app-sidebar"
          aria-label="Workspace navigation"
          collapsible="icon"
        >
          <SidebarHeader className="gap-1.5 px-2 py-2">
            <SidebarGroupLabel className="h-auto px-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              Workspace
            </SidebarGroupLabel>
            <div className="px-1 group-data-[collapsible=icon]:hidden">
              <p className="truncate text-[13px] font-semibold">{profileLabel}</p>
              <p className="text-[11px] text-muted-foreground">
                {repositoryCount} watched repositories
              </p>
            </div>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup className="p-0">
              <SidebarGroupContent>
                <nav aria-label="Primary">
                  <SidebarMenu>
                    {primaryDestinations.map((item) => {
                      const Icon = icons[item.kind];
                      const current = destination.kind === item.kind;
                      return (
                        <SidebarMenuItem key={item.kind}>
                          <SidebarMenuButton
                            isActive={current}
                            size="sm"
                            tooltip={item.label}
                            aria-current={current ? "page" : undefined}
                            onClick={() => go({ kind: item.kind })}
                          >
                            <Icon />
                            <span>{item.label}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </nav>
              </SidebarGroupContent>
            </SidebarGroup>
            {workspacePanel === undefined ? null : (
              <SidebarGroup className="border-t px-2 pt-2">
                {workspacePanel}
              </SidebarGroup>
            )}
          </SidebarContent>
          <SidebarFooter className="p-2">
            <div className="rounded-lg border bg-card p-2.5 text-[11px] leading-4 text-muted-foreground group-data-[collapsible=icon]:hidden">
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                <Archive className="size-3.5" /> Local-first
              </div>
              <p className="mt-1">
                GitHub writes always require a separate confirmation.
              </p>
            </div>
          </SidebarFooter>
        </Sidebar>
        <main
          ref={mainRef}
          id="main-content"
          tabIndex={-1}
          className="flex min-w-0 flex-1 flex-col overflow-auto"
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
        className="flex max-h-[min(38rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden border-border bg-popover p-0 shadow-2xl min-[1280px]:max-h-[min(38rem,calc(100dvh-4rem))]"
        showCloseButton={false}
      >
        <CommandInput
          showCloseButton
          className="min-[1280px]:text-[13px]"
          placeholder="Search views and actions…"
        />
        <CommandList className="max-h-none min-h-0 flex-1 p-1 min-[1280px]:text-[13px]">
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
          <CommandGroup heading="Inbox">
            {inboxCommands.map(([id, label]) => (
              <CommandItem key={id} value={label} onSelect={() => chooseInboxView(id)}>
                <GitPullRequest />
                {label}
              </CommandItem>
            ))}
            <CommandItem value="Open selected pull request action" onSelect={openSelectedInboxAction}>
              <ArrowLeft className="rotate-180" />
              Open selected pull request
            </CommandItem>
          </CommandGroup>
        </CommandList>
        <div className="flex shrink-0 items-center gap-2 border-t px-2 py-1.5 text-[11px] text-muted-foreground">
          <Kbd>↑↓</Kbd>
          <span>to navigate</span>
          <Kbd>↵</Kbd>
          <span>to open</span>
          <Kbd className="ml-auto">esc</Kbd>
        </div>
      </CommandDialog>
      </div>
    </SidebarProvider>
  );
}
