import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Filter,
  GitPullRequest,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Save,
  ShieldAlert,
  Trash2,
} from "lucide-react";

import type { InboxRow, InboxView } from "@/renderer-contracts";
import { recoveryActionLabel } from "@/review-copy";
import { inboxIdentityKey } from "@/renderer-contracts";
import {
  loadInboxViewPreferences,
  saveInboxViewPreferences,
  type InboxSort,
  type SavedInboxView,
} from "@/inbox-view-preferences";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const views: ReadonlyArray<{ readonly id: InboxView; readonly label: string; readonly category?: string }> = [
  { id: "my_inbox", label: "My inbox" },
  { id: "updated", label: "Updated", category: "updated_since_review" },
  { id: "needs_review", label: "Needs review", category: "needs_review" },
  { id: "waiting", label: "Waiting", category: "waiting_for_author" },
  { id: "checks_failing", label: "Checks failing", category: "checks_failing" },
  { id: "ready_to_merge", label: "Ready to merge", category: "ready_to_merge" },
  { id: "all_open", label: "All open" },
];

export type ReviewStartMode = "full" | "incremental";
export type ReviewInitialSection = "overview" | "diff" | "checks";

/** Dense, keyboard-operable maintainer queue built from the parsed local API projection. */
export function MaintainerInbox({
  profileId,
  profileLabel,
  rows,
  freshness,
  snapshot,
  refreshStatus,
  onRefresh,
  onOpenReview,
  onOpenSession,
}: {
  readonly profileId: string;
  readonly profileLabel: string;
  readonly rows: ReadonlyArray<InboxRow>;
  readonly freshness: "fresh" | "cached";
  readonly snapshot?: { readonly state: "current" | "partial" | "failed_cached" | "unavailable"; readonly refreshedAt?: string | undefined };
  readonly refreshStatus: "Refreshing" | "Current" | "Aged" | "Partial" | "Cached after refresh failure" | "Unavailable" | "Paused";
  readonly onRefresh: () => void;
  readonly onOpenReview: (row: InboxRow, mode: ReviewStartMode, initialSection?: ReviewInitialSection) => void;
  readonly onOpenSession: (sessionId: string) => void;
}): React.JSX.Element {
  const preferences = useMemo(() => loadInboxViewPreferences(profileId), [profileId]);
  const [view, setView] = useState<InboxView>(preferences.view);
  const [search, setSearch] = useState(preferences.search);
  const [sort, setSort] = useState<InboxSort>(preferences.sort);
  const [queueOpen, setQueueOpen] = useState(preferences.queueRailOpen);
  const [inspectorOpen, setInspectorOpen] = useState(preferences.inspectorOpen);
  const [selectedKey, setSelectedKey] = useState<string | undefined>(preferences.selectedIdentity);
  const [savedViews, setSavedViews] = useState<ReadonlyArray<SavedInboxView>>(preferences.savedViews);
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [savedViewName, setSavedViewName] = useState("");
  const [deleteView, setDeleteView] = useState<SavedInboxView>();
  const [scopePreview, setScopePreview] = useState<InboxRow>();
  const [narrow, setNarrow] = useState(() => isNarrowViewport());
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 1279px)");
    const update = (): void => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const next = loadInboxViewPreferences(profileId);
    setView(next.view);
    setSearch(next.search);
    setSort(next.sort);
    setQueueOpen(next.queueRailOpen);
    setInspectorOpen(next.inspectorOpen);
    setSelectedKey(next.selectedIdentity);
    setSavedViews(next.savedViews);
  }, [profileId]);

  const visibleRows = useMemo(
    () => sortRows(filterRows(rows, view, search), sort),
    [rows, search, sort, view],
  );
  const selected = visibleRows.find((row) => inboxIdentityKey(row) === selectedKey) ?? visibleRows[0];

  useEffect(() => {
    if (selected === undefined) return;
    const key = inboxIdentityKey(selected);
    if (key === selectedKey) return;
    setSelectedKey(key);
    saveInboxViewPreferences(profileId, { selectedIdentity: key });
  }, [profileId, selected, selectedKey]);

  const selectView = (next: InboxView): void => {
    setView(next);
    saveInboxViewPreferences(profileId, { view: next });
  };
  const selectSavedView = (next: SavedInboxView): void => {
    setView(next.view);
    setSearch(next.search);
    setSort(next.sort);
    saveInboxViewPreferences(profileId, {
      view: next.view,
      search: next.search,
      sort: next.sort,
    });
  };
  const saveCurrentView = (): void => {
    const name = savedViewName.trim().slice(0, 60);
    if (name.length === 0) return;
    const next: SavedInboxView = {
      id: `view-${Date.now().toString(36)}`,
      name,
      view,
      search,
      sort,
    };
    const updated = [...savedViews, next].slice(-20);
    setSavedViews(updated);
    saveInboxViewPreferences(profileId, { savedViews: updated });
    setSavedViewName("");
    setSaveViewOpen(false);
  };
  const removeSavedView = (): void => {
    if (deleteView === undefined) return;
    const updated = savedViews.filter((candidate) => candidate.id !== deleteView.id);
    setSavedViews(updated);
    saveInboxViewPreferences(profileId, { savedViews: updated });
    setDeleteView(undefined);
  };
  const selectRow = (row: InboxRow): void => {
    const key = inboxIdentityKey(row);
    setSelectedKey(key);
    saveInboxViewPreferences(profileId, { selectedIdentity: key });
  };
  const changeSearch = (next: string): void => {
    setSearch(next);
    saveInboxViewPreferences(profileId, { search: next });
  };
  const changeSort = (next: InboxSort): void => {
    setSort(next);
    saveInboxViewPreferences(profileId, { sort: next });
  };
  const toggleQueue = (): void => {
    const next = !queueOpen;
    setQueueOpen(next);
    saveInboxViewPreferences(profileId, { queueRailOpen: next });
  };
  const toggleInspector = (): void => {
    const next = !inspectorOpen;
    setInspectorOpen(next);
    saveInboxViewPreferences(profileId, { inspectorOpen: next });
  };
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (visibleRows.length === 0) return;
    const first = visibleRows[0];
    if (first === undefined) return;
    const currentIndex = Math.max(0, visibleRows.findIndex((row) => inboxIdentityKey(row) === inboxIdentityKey(selected ?? first)));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const next = visibleRows[(currentIndex + offset + visibleRows.length) % visibleRows.length];
      if (next === undefined) return;
      selectRow(next);
      document.getElementById(`inbox-row-${inboxIdentityKey(next)}`)?.focus();
    }
    if (event.key === "Enter" && selected !== undefined) {
      event.preventDefault();
      requestAction(selected, onOpenReview, onOpenSession, setScopePreview);
    }
  };

  useEffect(() => {
    const onView = (event: Event): void => {
      const view = (event as CustomEvent<unknown>).detail;
      if (isInboxView(view)) selectView(view);
    };
    const onAction = (): void => {
      if (selected !== undefined) requestAction(selected, onOpenReview, onOpenSession, setScopePreview);
    };
    window.addEventListener("patchdesk:inbox-view", onView);
    window.addEventListener("patchdesk:inbox-action", onAction);
    return () => {
      window.removeEventListener("patchdesk:inbox-view", onView);
      window.removeEventListener("patchdesk:inbox-action", onAction);
    };
  }, [onOpenReview, onOpenSession, selected]);

  const main = (
    <div className="min-w-0">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b px-3 py-2.5 min-[1280px]:px-3">
        <div className="min-w-0">
          <p className="text-[11px] leading-4 text-muted-foreground">{profileLabel}</p>
          <h1 className="mt-0.5 text-[17px] leading-5 font-semibold tracking-tight">Maintainer inbox</h1>
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">Open pull requests that need your next decision.</p>
        </div>
        <div className="flex items-center gap-2">
          <InboxFreshness status={refreshStatus} {...(snapshot === undefined ? {} : { snapshot })} />
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onRefresh} disabled={refreshStatus === "Refreshing"} aria-label={refreshStatus === "Refreshing" ? "Refresh all — refresh already running" : "Refresh all watched repositories"}>
            {refreshStatus === "Refreshing" ? <LoaderCircle className="animate-spin" /> : <Clock3 />}
            Refresh all
          </Button>
        </div>
      </header>
      <section className="sticky top-0 z-10 flex min-h-10 flex-wrap items-center gap-2 border-b bg-background/95 px-3 py-1.5 backdrop-blur" aria-label="Inbox filters">
        <Button className="min-[1280px]:hidden" size="sm" variant="outline" onClick={toggleQueue} aria-expanded={queueOpen}>
          <Filter /> Queues
        </Button>
        <InputGroup className="h-8 min-w-40 flex-1">
          <InputGroupAddon className="pl-2 [&>svg]:size-3.5"><Search /></InputGroupAddon>
          <InputGroupInput value={search} onChange={(event) => changeSearch(event.target.value)} className="h-8 text-xs" placeholder="Filter pull requests" aria-label="Filter pull requests" />
        </InputGroup>
        <Select value={sort} onValueChange={(value) => changeSort(value as InboxSort)}>
          <SelectTrigger size="sm" className="min-w-28 text-xs" aria-label="Sort pull requests"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="priority" className="text-xs">Priority</SelectItem>
            <SelectItem value="updated" className="text-xs">Last updated</SelectItem>
            <SelectItem value="repository" className="text-xs">Repository</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-[11px] tabular-nums text-muted-foreground">{visibleRows.length} open</span>
        <Button size="icon-sm" variant="ghost" onClick={toggleInspector} aria-label={inspectorOpen ? "Hide review details" : "Show review details"} aria-expanded={inspectorOpen}>
          {inspectorOpen ? <ChevronRight /> : <ChevronLeft />}
        </Button>
      </section>
      <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1fr)_8rem_2.5rem] items-center gap-3 border-b px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground min-[1280px]:grid">
        <span>Pull request</span><span>Review state</span><span className="text-right">Updated</span>
      </div>
      <div ref={listRef} role="listbox" aria-label="Pull requests" tabIndex={0} onKeyDown={onListKeyDown} className="divide-y outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {visibleRows.map((row) => {
          const key = inboxIdentityKey(row);
          const active = selected !== undefined && key === inboxIdentityKey(selected);
          return <InboxRowItem key={key} row={row} selected={active} onSelect={() => selectRow(row)} onAction={() => requestAction(row, onOpenReview, onOpenSession, setScopePreview)} />;
        })}
        {visibleRows.length === 0 ? <div className="p-8 text-center text-sm text-muted-foreground">No open pull requests match this view.</div> : null}
      </div>
    </div>
  );

  const desktopGridColumns = queueOpen
    ? inspectorOpen
      ? "min-[1280px]:grid-cols-[13rem_minmax(0,1fr)_21rem]"
      : "min-[1280px]:grid-cols-[13rem_minmax(0,1fr)]"
    : inspectorOpen
      ? "min-[1280px]:grid-cols-[3rem_minmax(0,1fr)_21rem]"
      : "min-[1280px]:grid-cols-[3rem_minmax(0,1fr)]";

  return (
    <div className={cn("min-h-[calc(100vh-3rem)] min-w-0 bg-background min-[1280px]:grid min-[1280px]:h-full min-[1280px]:min-h-0 min-[1280px]:overflow-hidden", desktopGridColumns)}>
      <QueueRail rows={rows} view={view} savedViews={savedViews} open={queueOpen} onSelect={selectView} onSelectSaved={selectSavedView} onSaveCurrent={() => setSaveViewOpen(true)} onDeleteSaved={setDeleteView} onToggle={toggleQueue} />
      <ScrollArea className="min-w-0 overflow-x-hidden min-[1280px]:h-full">{main}</ScrollArea>
      <aside className={cn("hidden min-w-0 overflow-hidden border-l min-[1280px]:block", !inspectorOpen && "min-[1280px]:hidden")} aria-label="Review details">
        <ScrollArea className="h-full overflow-x-hidden"><Inspector {...(selected === undefined ? {} : { row: selected })} freshness={freshness} onAction={() => selected === undefined ? undefined : requestAction(selected, onOpenReview, onOpenSession, setScopePreview)} /></ScrollArea>
      </aside>
      <Sheet open={narrow && inspectorOpen && selected !== undefined} onOpenChange={(open) => { if (!open && narrow) toggleInspector(); }}>
        <SheetContent side="right" className="w-[min(24rem,calc(100vw-1rem))] p-0 min-[1280px]:hidden">
          <SheetHeader className="sr-only"><SheetTitle>Review details</SheetTitle><SheetDescription>Selected pull request details and actions.</SheetDescription></SheetHeader>
          <Inspector {...(selected === undefined ? {} : { row: selected })} freshness={freshness} onAction={() => selected === undefined ? undefined : requestAction(selected, onOpenReview, onOpenSession, setScopePreview)} />
        </SheetContent>
      </Sheet>
      <Dialog open={saveViewOpen} onOpenChange={setSaveViewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save current view</DialogTitle>
            <DialogDescription>Save the queue, filter, and sort locally for {profileLabel}.</DialogDescription>
          </DialogHeader>
          <Label htmlFor="saved-view-name">View name</Label>
          <Input id="saved-view-name" value={savedViewName} onChange={(event) => setSavedViewName(event.target.value)} placeholder="e.g. Waiting on customer" autoFocus />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveViewOpen(false)}>Cancel</Button>
            <Button onClick={saveCurrentView} disabled={savedViewName.trim().length === 0}><Save /> Save view</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={deleteView !== undefined} onOpenChange={(open) => { if (!open) setDeleteView(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete saved view?</AlertDialogTitle><AlertDialogDescription>This removes only the local shortcut. Pull requests and reviews are unchanged.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={removeSavedView}>Delete view</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={scopePreview !== undefined} onOpenChange={(open) => { if (!open) setScopePreview(undefined); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Review updates</DialogTitle><DialogDescription>Patchdesk will compare the exact reviewed head with the current pull-request head before starting the review.</DialogDescription></DialogHeader>
          {scopePreview === undefined ? null : <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs"><Detail label="Reviewed head" value={scopePreview.latestReview === undefined ? "Unavailable" : shortSha(scopePreview.latestReview.reviewedHeadSha)} /><Detail label="Current head" value={shortSha(scopePreview.currentHeadSha)} /><Detail label="Change summary" value={changeStats(scopePreview)} /><Detail label="Comparison" value="Verified before review starts" /></div>}
          <DialogFooter><Button variant="outline" onClick={() => setScopePreview(undefined)}>Cancel</Button><Button onClick={() => { if (scopePreview !== undefined) onOpenReview(scopePreview, "incremental"); setScopePreview(undefined); }}>Review updates</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InboxFreshness({ snapshot, status }: { readonly snapshot?: { readonly state: "current" | "partial" | "failed_cached" | "unavailable"; readonly refreshedAt?: string | undefined }; readonly status: "Refreshing" | "Current" | "Aged" | "Partial" | "Cached after refresh failure" | "Unavailable" | "Paused" }): React.JSX.Element {
  const stable = status === "Current";
  return <Badge variant={stable ? "secondary" : "outline"} className="h-5 max-w-full px-1.5 text-[10px]" title={snapshot?.refreshedAt}>GitHub: {status}</Badge>;
}

function QueueRail({ rows, view, savedViews, open, onSelect, onSelectSaved, onSaveCurrent, onDeleteSaved, onToggle }: { readonly rows: ReadonlyArray<InboxRow>; readonly view: InboxView; readonly savedViews: ReadonlyArray<SavedInboxView>; readonly open: boolean; readonly onSelect: (view: InboxView) => void; readonly onSelectSaved: (view: SavedInboxView) => void; readonly onSaveCurrent: () => void; readonly onDeleteSaved: (view: SavedInboxView) => void; readonly onToggle: () => void }): React.JSX.Element {
  if (!open) return <aside className="hidden border-r min-[1280px]:flex min-[1280px]:justify-center min-[1280px]:pt-2"><Button size="icon-sm" variant="ghost" onClick={onToggle} aria-label="Show inbox queues"><PanelLeftOpen /></Button></aside>;
  return <aside className="border-r bg-muted/10 max-[1279px]:border-b min-[1280px]:min-h-0" aria-label="Inbox queues">
    <div className="flex items-center justify-between px-3 py-2"><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Queues</p><Button className="hidden min-[1280px]:inline-flex" size="icon-sm" variant="ghost" onClick={onToggle} aria-label="Hide inbox queues"><PanelLeftClose /></Button></div>
    <nav className="flex gap-0.5 overflow-x-auto px-2 pb-1.5 min-[1280px]:flex-col" aria-label="Inbox views">
      {views.map((item) => <Button key={item.id} variant={view === item.id ? "secondary" : "ghost"} size="sm" className="h-7 justify-between whitespace-nowrap text-xs min-[1280px]:w-full" onClick={() => onSelect(item.id)}><span className="flex min-w-0 items-center gap-2"><Badge variant="ghost" aria-hidden="true" className={cn("size-1.5 min-w-1.5 shrink-0 rounded-full border-0 p-0", queueIndicatorClass(item.id))} />{item.label}</span><Badge variant="outline" className="ml-2 h-4 min-w-4 px-1 text-[10px]">{viewCount(rows, item.id)}</Badge></Button>)}
    </nav>
    <Separator className="my-1.5" />
    <div className="flex items-center justify-between px-3"><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Saved views</p><Button size="icon-sm" variant="ghost" onClick={onSaveCurrent} aria-label="Save current view"><Save /></Button></div>
    <div className="space-y-0.5 px-2 pb-2">{savedViews.length === 0 ? <p className="px-2 py-1 text-xs text-muted-foreground">No saved views</p> : savedViews.map((item) => <div key={item.id} className="flex items-center gap-1"><Button size="sm" variant="ghost" className="h-7 min-w-0 flex-1 justify-start truncate text-xs" onClick={() => onSelectSaved(item)}>{item.name}</Button><Button size="icon-sm" variant="ghost" aria-label={`Delete ${item.name} saved view`} onClick={() => onDeleteSaved(item)}><Trash2 /></Button></div>)}</div>
  </aside>;
}

function InboxRowItem({ row, selected, onSelect, onAction }: { readonly row: InboxRow; readonly selected: boolean; readonly onSelect: () => void; readonly onAction: () => void }): React.JSX.Element {
  const key = inboxIdentityKey(row);
  const progress = reviewProgressLabel(row);
  return <button id={`inbox-row-${key}`} type="button" role="option" aria-selected={selected} onClick={() => { onSelect(); onAction(); }} className={cn("block w-full content-auto border-l-2 border-transparent px-3 py-2 text-left transition-colors [contain-intrinsic-size:auto_60px] hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", selected && "border-l-primary bg-primary/8")}>
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 min-[1280px]:grid-cols-[minmax(0,1fr)_8rem_2.5rem]">
      <div className="flex min-w-0 items-start gap-2"><GitPullRequest className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /><div className="min-w-0"><div className="flex min-w-0 items-center gap-1.5"><p className="truncate text-[13px] leading-5 font-medium" title={`#${row.identity.number} ${row.title}`}>#{row.identity.number} {row.title}</p>{row.isDraft ? <Badge variant="outline" className="h-4 px-1 text-[10px]">Draft</Badge> : null}</div><p className="truncate text-[11px] leading-4 text-muted-foreground" title={`${row.identity.owner}/${row.identity.repo}`}>{row.identity.owner}/{row.identity.repo}<span className="hidden min-[1440px]:inline"> · {row.author}</span></p></div></div>
      <div className="hidden min-w-0 min-[1280px]:flex min-[1280px]:items-center min-[1280px]:gap-1.5">{progress === undefined ? <CheckBadge overall={row.checks.overall} /> : <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />}<span className="truncate text-[11px] text-muted-foreground" title={progress ?? reasonText(row)}>{progress ?? <Reason row={row} />}</span></div>
      <span className="text-right text-[11px] leading-5 text-muted-foreground">{relativeTime(row.updatedAt)}</span>
      <div className="col-span-2 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground min-[1280px]:hidden">{progress === undefined ? <CheckBadge overall={row.checks.overall} /> : <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />}<span>{progress ?? <Reason row={row} />}</span></div>
    </div>
  </button>;
}

function Inspector({ row, freshness, onAction }: { readonly row?: InboxRow; readonly freshness: "fresh" | "cached"; readonly onAction: () => void | undefined }): React.JSX.Element {
  if (row === undefined) return <div className="p-3 text-sm text-muted-foreground">Select a pull request to inspect its exact review state.</div>;
  const reviewChanged = row.latestReview !== undefined && !row.latestReview.matchesCurrentHead;
  const progress = reviewProgressLabel(row);
  return <div className="space-y-3 p-3"><div><p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Review details</p><h2 className="mt-1.5 text-[13px] leading-5 font-semibold">#{row.identity.number} {row.title}</h2><p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={`${row.identity.owner}/${row.identity.repo}`}>{row.identity.owner}/{row.identity.repo}</p></div><Separator /><div className="space-y-1.5 text-[11px]"><Detail label="Author" value={row.author} /><Detail label="Branch" value={`${row.baseBranch} ← ${row.headBranch}`} /><Detail label="Current head" value={shortSha(row.currentHeadSha)} /><Detail label="Checks" value={row.checks.overall} /><Detail label="Changes" value={changeStats(row)} />{row.latestReview === undefined ? <Detail label="Last review" value="Not reviewed" /> : <><Detail label="Reviewed head" value={shortSha(row.latestReview.reviewedHeadSha)} /><Detail label="Local review" value={progress ?? row.latestReview.state.replaceAll("_", " ")} /></>}</div>{progress === undefined ? null : <Card className="gap-1.5 py-2.5"><CardContent className="flex items-center gap-2 px-2.5 text-[11px]"><LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /><span>{progress}</span></CardContent></Card>}{reviewChanged ? <Card className="gap-1.5 border-primary/30 bg-primary/5 py-2.5"><CardHeader className="px-2.5"><CardTitle className="text-xs">Updates since your review</CardTitle><CardDescription className="text-[11px] leading-4">Current head differs from the exact saved review head.</CardDescription></CardHeader></Card> : null}{freshness === "cached" ? <Card className="gap-1.5 border-amber-500/30 bg-amber-500/5 py-2.5"><CardContent className="flex gap-2 px-2.5 text-[11px] leading-4 text-muted-foreground"><CircleAlert className="size-3.5 shrink-0 text-amber-500" />GitHub data is cached. Merge-oriented actions remain unavailable.</CardContent></Card> : null}<Button size="sm" className="h-8 w-full text-xs" onClick={onAction} disabled={freshness === "cached" && row.recommendedAction.kind === "open_merge_readiness"}>{actionIcon(row.recommendedAction.kind)}{row.recommendedAction.label}</Button><p className="text-[11px] leading-4 text-muted-foreground">Starting a review is read-only. Patchdesk requires a separate confirmation for every GitHub write.</p></div>;
}

function Detail({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element { return <div className="flex min-w-0 items-start justify-between gap-3"><span className="shrink-0 text-muted-foreground">{label}</span><span className="min-w-0 text-right font-medium [overflow-wrap:anywhere]">{value}</span></div>; }
function CheckBadge({ overall }: { readonly overall: InboxRow["checks"]["overall"] }): React.JSX.Element { const variant = overall === "failing" ? "destructive" : overall === "passing" ? "secondary" : "outline"; return <Badge variant={variant} className="h-4 px-1 text-[10px]">{overall}</Badge>; }
function Reason({ row }: { readonly row: InboxRow }): React.JSX.Element { if (row.categories.includes("updated_since_review")) return <span>Updated since review</span>; if (row.categories.includes("needs_review")) return <span>Review requested</span>; if (row.categories.includes("checks_failing")) return <span className="text-destructive">Checks failing</span>; return <span>{inboxActionLabel(row.recommendedAction.kind)}</span>; }
function reviewProgressLabel(row: InboxRow): "Review starting" | "Review in progress" | undefined { return row.latestReview?.state === "starting" ? "Review starting" : row.latestReview?.state === "running" ? "Review in progress" : undefined; }
function reasonText(row: InboxRow): string { if (row.categories.includes("updated_since_review")) return "Updated since review"; if (row.categories.includes("needs_review")) return "Review requested"; if (row.categories.includes("checks_failing")) return "Checks failing"; return inboxActionLabel(row.recommendedAction.kind); }
function inboxActionLabel(kind: InboxRow["recommendedAction"]["kind"]): string {
  switch (kind) {
    case "run_review": return recoveryActionLabel("run_review");
    case "continue_review": return "View review progress";
    case "review_updates": return "Review updates";
    case "open_saved_review": return "Open saved review";
    case "inspect_checks": return "Inspect failing checks";
    case "open_merge_readiness": return "Open merge readiness";
    case "open_discussion": return "Review author response";
  }
}

function viewCount(rows: ReadonlyArray<InboxRow>, view: InboxView): number { return filterRows(rows, view, "").length; }
function queueIndicatorClass(view: InboxView): string { switch (view) { case "my_inbox": case "updated": return "bg-status-info"; case "needs_review": return "bg-status-warning"; case "waiting": return "bg-muted-foreground/60"; case "checks_failing": return "bg-destructive"; case "ready_to_merge": return "bg-status-success"; case "all_open": return "bg-muted-foreground"; } }
function filterRows(rows: ReadonlyArray<InboxRow>, view: InboxView, search: string): ReadonlyArray<InboxRow> { const needle = search.trim().toLocaleLowerCase(); return rows.filter((row) => matchesView(row, view) && (needle.length === 0 || `${row.identity.owner}/${row.identity.repo} ${row.title} ${row.author} #${row.identity.number}`.toLocaleLowerCase().includes(needle))); }
function matchesView(row: InboxRow, view: InboxView): boolean { switch (view) { case "all_open": return true; case "my_inbox": return row.categories.some((category) => category === "needs_review" || category === "updated_since_review" || category === "saved_review" || category === "running"); case "updated": return row.categories.includes("updated_since_review"); case "needs_review": return row.categories.includes("needs_review"); case "waiting": return row.categories.includes("waiting_for_author"); case "checks_failing": return row.categories.includes("checks_failing"); case "ready_to_merge": return row.categories.includes("ready_to_merge"); } }
function sortRows(rows: ReadonlyArray<InboxRow>, sort: InboxSort): ReadonlyArray<InboxRow> { return [...rows].sort((left, right) => sort === "updated" ? right.updatedAt.localeCompare(left.updatedAt) : sort === "repository" ? inboxIdentityKey(left).localeCompare(inboxIdentityKey(right)) : priority(left) - priority(right) || right.updatedAt.localeCompare(left.updatedAt) || inboxIdentityKey(left).localeCompare(inboxIdentityKey(right))); }
function priority(row: InboxRow): number { if (row.categories.includes("running") || row.categories.includes("saved_review")) return 0; if (row.categories.includes("updated_since_review")) return 1; if (row.categories.includes("needs_review")) return 2; if (row.categories.includes("waiting_for_author")) return 3; if (row.categories.includes("checks_failing")) return 4; if (row.categories.includes("ready_to_merge")) return 5; return 6; }
function requestAction(row: InboxRow, onOpenReview: (row: InboxRow, mode: ReviewStartMode, initialSection?: ReviewInitialSection) => void, onOpenSession: (sessionId: string) => void, setScopePreview: (row: InboxRow | undefined) => void): void { switch (row.recommendedAction.kind) { case "run_review": onOpenReview(row, "full"); return; case "review_updates": setScopePreview(row); return; case "continue_review": case "open_saved_review": case "open_merge_readiness": case "open_discussion": onOpenSession(row.recommendedAction.sessionId); return; case "inspect_checks": onOpenReview(row, "full", "checks"); return; } }
function actionIcon(kind: InboxRow["recommendedAction"]["kind"]): React.JSX.Element { return kind === "review_updates" ? <Clock3 /> : kind === "inspect_checks" ? <ShieldAlert /> : kind === "continue_review" ? <LoaderCircle /> : <CheckCircle2 />; }
function shortSha(value: string): string { return value.slice(0, 12); }
function changeStats(row: InboxRow): string { const { additions, deletions, changedFiles } = row.changeStats; const parts = [changedFiles === undefined ? undefined : `${changedFiles} files`, additions === undefined ? undefined : `+${additions}`, deletions === undefined ? undefined : `-${deletions}`].filter((value): value is string => value !== undefined); return parts.length === 0 ? "Not available" : parts.join(" · "); }
function relativeTime(iso: string): string { const timestamp = Date.parse(iso); if (Number.isNaN(timestamp)) return ""; const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000)); if (minutes < 60) return `${minutes}m`; if (minutes < 1_440) return `${Math.round(minutes / 60)}h`; return `${Math.round(minutes / 1_440)}d`; }
function isNarrowViewport(): boolean { return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 1279px)").matches; }
function isInboxView(value: unknown): value is InboxView { return value === "my_inbox" || value === "updated" || value === "needs_review" || value === "waiting" || value === "checks_failing" || value === "ready_to_merge" || value === "all_open"; }
