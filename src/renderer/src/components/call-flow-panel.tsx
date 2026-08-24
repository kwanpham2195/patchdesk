import { useEffect, useMemo, useState } from "react";
import {
  Braces,
  ChevronDown,
  ChevronRight,
  Copy,
  Info,
  Search,
} from "lucide-react";

import type {
  CallFlowNode,
  CallFlowNodeStatus,
} from "../../../domain/call-flow";
import { requestJson } from "../api-client";
import {
  parseCallFlowResponse,
  type CallFlowResponse,
} from "../renderer-contracts";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { ScrollArea } from "./ui/scroll-area";
import { Skeleton } from "./ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type ReadyCallFlow = Extract<CallFlowResponse, { readonly state: "ready" }>;
type CallFlowView = "paths" | "compare" | "raw";
type CallFlowScope = "changes" | "new";
type CallFlowProjection = CallFlowScope | "before" | "after";
type VisibleCallFlowTree = ReadyCallFlow["trees"][number];
type CallFlowEntryCount = "changed" | "added" | "removed";

/** A source location selected from an inferred call path. */
export type CallFlowSourceTarget = {
  readonly path: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly status: CallFlowNodeStatus;
};
type MutableCallFlowSourceTarget = {
  -readonly [K in keyof CallFlowSourceTarget]: CallFlowSourceTarget[K];
};

/** Render the revision-bound Call Flow analysis for one Review session. */
export function CallFlowPanel({
  profileId,
  sessionId,
  headSha,
  onOpenSource,
}: {
  readonly profileId: string;
  readonly sessionId: string;
  readonly headSha: string;
  readonly onOpenSource: (target: CallFlowSourceTarget) => void;
}): React.JSX.Element {
  const [response, setResponse] = useState<CallFlowResponse | undefined>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    setResponse(undefined);
    void requestJson("/v1/reviews/call-flow", {
      method: "POST",
      body: { profileId, sessionId },
    })
      .then((value) => {
        if (!active) return;
        const parsed = parseCallFlowResponse(value);
        if (
          parsed === undefined ||
          ((parsed.state === "ready" || parsed.state === "unsupported") &&
            (parsed.snapshot.sessionId !== sessionId ||
              parsed.snapshot.headSha !== headSha))
        ) {
          setFailed(true);
          return;
        }
        setResponse(parsed);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [headSha, profileId, retry, sessionId]);

  if (failed)
    return <CallFlowFailure onRetry={() => setRetry((value) => value + 1)} />;
  if (response === undefined) return <CallFlowLoading />;
  if (response.state === "unavailable")
    return (
      <CallFlowUnavailable
        reason={response.reason}
        onRetry={() => setRetry((value) => value + 1)}
      />
    );
  if (response.state === "unsupported")
    return <CallFlowUnsupported response={response} />;
  if (response.trees.length === 0) return <CallFlowEmpty />;
  return <CallFlowReady response={response} onOpenSource={onOpenSource} />;
}

type CallFlowNodeSelect = (
  id: string,
  node: CallFlowNode,
  shiftKey: boolean,
) => void;

type CallFlowPathViewProps = {
  readonly response: ReadyCallFlow;
  readonly view: Exclude<CallFlowView, "raw">;
  readonly scope: CallFlowScope;
  readonly query: string;
  readonly searchOpen: boolean;
  readonly showAllContext: boolean;
  readonly hiddenContext: number;
  readonly addedSteps: number;
  readonly removedSteps: number;
  readonly allExpanded: boolean;
  readonly visiblePathTrees: ReadonlyArray<VisibleCallFlowTree>;
  readonly visibleBeforeTrees: ReadonlyArray<VisibleCallFlowTree>;
  readonly visibleAfterTrees: ReadonlyArray<VisibleCallFlowTree>;
  readonly expandedEntries: ReadonlySet<string>;
  readonly selectedNodes: ReadonlySet<string>;
  readonly onScopeChange: (scope: CallFlowScope) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onSearchOpenChange: (open: boolean) => void;
  readonly onShowAllContextChange: (showAllContext: boolean) => void;
  readonly onToggleAll: () => void;
  readonly onExpandedEntriesChange: (entries: ReadonlySet<string>) => void;
  readonly onSelect: CallFlowNodeSelect;
};

function CallFlowReady({
  response,
  onOpenSource,
}: {
  readonly response: ReadyCallFlow;
  readonly onOpenSource: (target: CallFlowSourceTarget) => void;
}): React.JSX.Element {
  const [view, setView] = useState<CallFlowView>("paths");
  const [scope, setScope] = useState<CallFlowScope>("changes");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [showAllContext, setShowAllContext] = useState(false);
  const [expandedEntries, setExpandedEntries] = useState<ReadonlySet<string>>(
    () => new Set(response.trees.slice(0, 1).map((tree) => tree.entry)),
  );
  const [selectedNodes, setSelectedNodes] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const visiblePathTrees = useMemo(
    () =>
      projectCallFlowTrees(
        response.trees,
        query,
        scope,
        scope === "changes" && showAllContext,
      ),
    [query, response.trees, scope, showAllContext],
  );
  const visibleBeforeTrees = useMemo(
    () => projectCallFlowTrees(response.trees, query, "before", false),
    [query, response.trees],
  );
  const visibleAfterTrees = useMemo(
    () => projectCallFlowTrees(response.trees, query, "after", false),
    [query, response.trees],
  );
  const hiddenContext = Math.max(
    0,
    response.contextSteps -
      visiblePathTrees.reduce(
        (count, entry) => count + countStatus(entry.tree, "same"),
        0,
      ),
  );
  const addedSteps = response.trees.reduce(
    (count, entry) => count + countStatus(entry.tree, "added"),
    0,
  );
  const removedSteps = response.trees.reduce(
    (count, entry) => count + countStatus(entry.tree, "removed"),
    0,
  );
  const visibleEntryNames = Array.from(
    new Set(
      (view === "compare"
        ? [...visibleBeforeTrees, ...visibleAfterTrees]
        : visiblePathTrees
      ).map((tree) => tree.entry),
    ),
  );
  const allExpanded =
    visibleEntryNames.length > 0 &&
    visibleEntryNames.every((entry) => expandedEntries.has(entry));
  const selectNode: CallFlowNodeSelect = (id, node, shiftKey) => {
    if (shiftKey) {
      setSelectedNodes((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    setSelectedNodes(new Set([id]));
    if (node.file === undefined) return;
    const target: MutableCallFlowSourceTarget = {
      path: node.file,
      status: node.status,
    };
    if (node.line !== undefined) target.line = node.line;
    if (node.endLine !== undefined) target.endLine = node.endLine;
    onOpenSource(target);
  };
  const toggleAll = (): void =>
    setExpandedEntries(allExpanded ? new Set() : new Set(visibleEntryNames));

  return (
    <section
      aria-label="Call Flow"
      data-call-flow-state="ready"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <CallFlowReadyHeader
        response={response}
        view={view}
        onViewChange={setView}
      />
      {view === "raw" ? (
        <CallFlowRawResult
          ascii={response.ascii}
          copyState={copyState}
          onCopyStateChange={setCopyState}
        />
      ) : (
        <CallFlowPathView
          response={response}
          view={view}
          scope={scope}
          query={query}
          searchOpen={searchOpen}
          showAllContext={showAllContext}
          hiddenContext={hiddenContext}
          addedSteps={addedSteps}
          removedSteps={removedSteps}
          allExpanded={allExpanded}
          visiblePathTrees={visiblePathTrees}
          visibleBeforeTrees={visibleBeforeTrees}
          visibleAfterTrees={visibleAfterTrees}
          expandedEntries={expandedEntries}
          selectedNodes={selectedNodes}
          onScopeChange={setScope}
          onQueryChange={setQuery}
          onSearchOpenChange={setSearchOpen}
          onShowAllContextChange={setShowAllContext}
          onToggleAll={toggleAll}
          onExpandedEntriesChange={setExpandedEntries}
          onSelect={selectNode}
        />
      )}
    </section>
  );
}

function CallFlowReadyHeader({
  response,
  view,
  onViewChange,
}: {
  readonly response: ReadyCallFlow;
  readonly view: CallFlowView;
  readonly onViewChange: (view: CallFlowView) => void;
}): React.JSX.Element {
  return (
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Changed call explanation
        </p>
        <h2 className="text-base font-semibold leading-tight">
          {response.changedSteps} changed path steps
        </h2>
        <p className="text-xs text-muted-foreground">
          {response.trees.length} entries · {response.impactedFiles} impacted
          files · revision {response.snapshot.headSha.slice(0, 8)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          value={[view]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "paths" || next === "compare" || next === "raw")
              onViewChange(next);
          }}
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Call Flow view"
        >
          <ToggleGroupItem value="paths">Paths</ToggleGroupItem>
          <ToggleGroupItem value="compare">Call Diff</ToggleGroupItem>
          <ToggleGroupItem value="raw">Raw</ToggleGroupItem>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                aria-label="Language coverage"
              />
            }
          >
            Languages {response.languages.analyzed.length}/
            {response.languages.available}
            <Info data-icon="inline-end" />
          </TooltipTrigger>
          <TooltipContent>
            {response.languages.analyzed.join(", ") || "No packaged language"}
            {response.languages.skippedChangedFiles === 0
              ? ""
              : ` · ${response.languages.skippedChangedFiles} changed files skipped`}
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

function CallFlowRawResult({
  ascii,
  copyState,
  onCopyStateChange,
}: {
  readonly ascii: string;
  readonly copyState: "idle" | "copied" | "failed";
  readonly onCopyStateChange: (state: "idle" | "copied" | "failed") => void;
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 justify-end border-b px-4 py-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard
              .writeText(ascii)
              .then(() => onCopyStateChange("copied"))
              .catch(() => onCopyStateChange("failed"))
              .finally(() => {
                window.setTimeout(() => onCopyStateChange("idle"), 1_500);
              });
          }}
        >
          <Copy data-icon="inline-start" />
          {copyState === "copied"
            ? "Copied"
            : copyState === "failed"
              ? "Copy failed"
              : "Copy raw"}
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <pre className="min-w-max p-4 font-mono text-xs leading-5 text-foreground">
          {ascii}
        </pre>
      </ScrollArea>
    </div>
  );
}

function CallFlowPathView(props: CallFlowPathViewProps): React.JSX.Element {
  return (
    <>
      <CallFlowPathLegend response={props.response} view={props.view} />
      <CallFlowPathToolbar {...props} />
      <CallFlowPathContent {...props} />
    </>
  );
}

function CallFlowPathLegend({
  response,
  view,
}: {
  readonly response: ReadyCallFlow;
  readonly view: Exclude<CallFlowView, "raw">;
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-1.5 text-xs text-muted-foreground">
      <div
        className="flex items-center gap-3"
        aria-label={
          view === "compare" ? "Call Diff legend" : "Call Flow legend"
        }
      >
        {view === "compare" ? (
          <>
            <span className="text-destructive">Before: − removed</span>
            <span className="text-status-success">After: + added</span>
            <span>· required context</span>
          </>
        ) : (
          <>
            <span className="text-status-success">+ added</span>
            <span className="text-destructive">− removed</span>
            <span>· unchanged context</span>
          </>
        )}
      </div>
      {response.languages.analyzed.includes("Go") ? (
        <>
          <span
            className="font-medium text-status-info"
            title="Dependency boundary: control crosses a receiver-held collaborator."
          >
            Dependency boundary
          </span>
          <span>
            Go leaves preserve source names; only app-owned calls are expanded.
          </span>
        </>
      ) : null}
      <span className="ml-auto">
        Click to open Diff · Shift-click to select
      </span>
    </div>
  );
}

function CallFlowPathToolbar({
  response,
  view,
  scope,
  query,
  searchOpen,
  showAllContext,
  hiddenContext,
  addedSteps,
  removedSteps,
  allExpanded,
  selectedNodes,
  onScopeChange,
  onQueryChange,
  onSearchOpenChange,
  onShowAllContextChange,
  onToggleAll,
}: CallFlowPathViewProps): React.JSX.Element {
  const summary =
    view === "compare"
      ? `${removedSteps} removed · ${addedSteps} added`
      : scope === "new"
        ? `${addedSteps} added steps · required ancestors kept`
        : `${hiddenContext} context steps hidden`;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-1">
      <p className="min-w-32 flex-1 truncate text-xs text-muted-foreground">
        {summary}
        {selectedNodes.size === 0 ? "" : ` · ${selectedNodes.size} selected`}
        {response.truncated ? " · bounded result" : ""}
      </p>
      {view === "paths" ? (
        <ToggleGroup
          value={[scope]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "changes" || next === "new") onScopeChange(next);
          }}
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Call Flow focus"
        >
          <ToggleGroupItem value="changes">All changes</ToggleGroupItem>
          <ToggleGroupItem value="new">New only</ToggleGroupItem>
        </ToggleGroup>
      ) : null}
      {view === "paths" && scope === "changes" ? (
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={showAllContext}
          onClick={() => onShowAllContextChange(!showAllContext)}
        >
          {showAllContext ? "Hide unchanged" : "Show all context"}
        </Button>
      ) : null}
      {searchOpen || query.length > 0 ? (
        <InputGroup className="h-7 w-52 max-w-full xl:w-64">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            autoFocus
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onBlur={() => {
              if (query.length === 0) onSearchOpenChange(false);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              onQueryChange("");
              onSearchOpenChange(false);
            }}
            placeholder="Search call flow"
            aria-label="Search call flow"
          />
        </InputGroup>
      ) : (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Search call flow"
          onClick={() => onSearchOpenChange(true)}
        >
          <Search />
        </Button>
      )}
      <Button variant="ghost" size="xs" onClick={onToggleAll}>
        {allExpanded ? "Collapse all" : "Expand all"}
      </Button>
    </div>
  );
}

function CallFlowPathContent({
  response,
  view,
  scope,
  addedSteps,
  removedSteps,
  visiblePathTrees,
  visibleBeforeTrees,
  visibleAfterTrees,
  expandedEntries,
  selectedNodes,
  onExpandedEntriesChange,
  onSelect,
}: CallFlowPathViewProps): React.JSX.Element {
  if (view === "compare") {
    return (
      <div className="grid min-h-0 flex-1 grid-cols-2 divide-x">
        <CallFlowComparePane
          title="Before"
          revision={response.snapshot.baseSha}
          stepCount={removedSteps}
          entries={visibleBeforeTrees}
          countKind="removed"
          expandedEntries={expandedEntries}
          selectedNodes={selectedNodes}
          onExpandedEntriesChange={onExpandedEntriesChange}
          onSelect={onSelect}
        />
        <CallFlowComparePane
          title="After"
          revision={response.snapshot.headSha}
          stepCount={addedSteps}
          entries={visibleAfterTrees}
          countKind="added"
          expandedEntries={expandedEntries}
          selectedNodes={selectedNodes}
          onExpandedEntriesChange={onExpandedEntriesChange}
          onSelect={onSelect}
        />
      </div>
    );
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <CallFlowTreeList
        entries={visiblePathTrees}
        countKind={scope === "new" ? "added" : "changed"}
        prefix="paths"
        emptyMessage={
          scope === "new"
            ? "No added call paths match this focus."
            : "No call paths match this search."
        }
        expandedEntries={expandedEntries}
        selectedNodes={selectedNodes}
        onExpandedEntriesChange={onExpandedEntriesChange}
        onSelect={onSelect}
      />
    </ScrollArea>
  );
}

function CallFlowComparePane({
  title,
  revision,
  stepCount,
  entries,
  countKind,
  expandedEntries,
  selectedNodes,
  onExpandedEntriesChange,
  onSelect,
}: {
  readonly title: "Before" | "After";
  readonly revision: string;
  readonly stepCount: number;
  readonly entries: ReadonlyArray<VisibleCallFlowTree>;
  readonly countKind: "added" | "removed";
  readonly expandedEntries: ReadonlySet<string>;
  readonly selectedNodes: ReadonlySet<string>;
  readonly onExpandedEntriesChange: (entries: ReadonlySet<string>) => void;
  readonly onSelect: (
    id: string,
    node: CallFlowNode,
    shiftKey: boolean,
  ) => void;
}): React.JSX.Element {
  return (
    <section
      aria-label={`${title} call flow`}
      className="flex min-h-0 min-w-0 flex-col"
    >
      <header className="flex shrink-0 items-center gap-2 border-b bg-muted/20 px-3 py-1.5">
        <h3 className="text-xs font-semibold">{title}</h3>
        <span className="font-mono text-[10px] text-muted-foreground">
          {revision.slice(0, 8)}
        </span>
        <span
          className={cn(
            "ml-auto text-[10px] font-medium tabular-nums",
            title === "Before" ? "text-destructive" : "text-status-success",
          )}
        >
          {stepCount} {countKind}
        </span>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <CallFlowTreeList
          entries={entries}
          countKind={countKind}
          prefix={title.toLowerCase()}
          emptyMessage={`No ${countKind} call paths match this search.`}
          expandedEntries={expandedEntries}
          selectedNodes={selectedNodes}
          onExpandedEntriesChange={onExpandedEntriesChange}
          onSelect={onSelect}
        />
      </ScrollArea>
    </section>
  );
}

function CallFlowTreeList({
  entries,
  countKind,
  prefix,
  emptyMessage,
  expandedEntries,
  selectedNodes,
  onExpandedEntriesChange,
  onSelect,
}: {
  readonly entries: ReadonlyArray<VisibleCallFlowTree>;
  readonly countKind: CallFlowEntryCount;
  readonly prefix: string;
  readonly emptyMessage: string;
  readonly expandedEntries: ReadonlySet<string>;
  readonly selectedNodes: ReadonlySet<string>;
  readonly onExpandedEntriesChange: (entries: ReadonlySet<string>) => void;
  readonly onSelect: (
    id: string,
    node: CallFlowNode,
    shiftKey: boolean,
  ) => void;
}): React.JSX.Element {
  if (entries.length === 0) {
    return (
      <Empty className="min-h-40 border-0 p-4">
        <EmptyHeader>
          <EmptyTitle>No matching call paths</EmptyTitle>
          <EmptyDescription>{emptyMessage}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex min-w-0 flex-col p-2">
      {entries.map((entry) => {
        const open = expandedEntries.has(entry.entry);
        const entryCount = countCallFlowEntry(entry.tree, countKind);
        return (
          <Collapsible
            key={entry.entry}
            open={open}
            onOpenChange={(nextOpen) => {
              const next = new Set(expandedEntries);
              if (nextOpen) next.add(entry.entry);
              else next.delete(entry.entry);
              onExpandedEntriesChange(next);
            }}
            className="border-b last:border-b-0"
          >
            <CollapsibleTrigger className="flex w-full items-center gap-2 px-1.5 py-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
              {open ? (
                <ChevronDown className="size-3.5 shrink-0" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0" />
              )}
              <span className="min-w-0 truncate font-mono text-sm font-medium">
                {entry.entry}
              </span>
              <span className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {entryCount} {countKind}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent motion="disclosure" className="pb-2">
              <CallFlowNodeList
                node={entry.tree}
                nodeInstanceId={callFlowNodeInstanceId(
                  `${prefix}:${entry.entry}`,
                  entry.tree,
                  0,
                )}
                depth={0}
                parentFile={undefined}
                selectedNodes={selectedNodes}
                onSelect={onSelect}
              />
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
}

function CallFlowNodeList({
  node,
  nodeInstanceId,
  depth,
  parentFile,
  selectedNodes,
  onSelect,
}: {
  readonly node: CallFlowNode;
  readonly nodeInstanceId: string;
  readonly depth: number;
  readonly parentFile: string | undefined;
  readonly selectedNodes: ReadonlySet<string>;
  readonly onSelect: (
    id: string,
    node: CallFlowNode,
    shiftKey: boolean,
  ) => void;
}): React.JSX.Element {
  const id = nodeInstanceId;
  const fileChanged = node.file !== undefined && node.file !== parentFile;
  const sourceFile =
    node.file === undefined ? undefined : splitSourcePath(node.file);
  return (
    <ol
      className={cn("flex min-w-0 flex-col", depth > 0 && "ml-4 border-l pl-2")}
    >
      <li>
        {fileChanged && sourceFile !== undefined ? (
          <div className="flex min-w-0 items-baseline gap-2 border-y border-border/60 bg-muted/25 px-2 py-1 font-mono text-[11px]">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              File
            </span>
            <span className="shrink-0 font-semibold text-foreground">
              {sourceFile.name}
            </span>
            {sourceFile.directory === "" ? null : (
              <span className="min-w-0 truncate text-muted-foreground">
                {sourceFile.directory}
              </span>
            )}
          </div>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-auto min-h-6 w-full justify-start gap-2 rounded-none border-0 px-2 py-0.5 font-mono text-xs font-normal",
            node.status === "added" &&
              "bg-status-success/[0.04] hover:bg-status-success/[0.08]",
            node.status === "removed" &&
              "bg-destructive/[0.04] hover:bg-destructive/[0.08]",
            selectedNodes.has(id) &&
              "bg-accent ring-1 ring-inset ring-ring/70 hover:bg-accent",
          )}
          onClick={(event) => onSelect(id, node, event.shiftKey)}
          disabled={node.file === undefined && node.children.length === 0}
        >
          <span
            className={cn(
              "w-3 shrink-0 text-center",
              node.status === "added"
                ? "text-status-success"
                : node.status === "removed"
                  ? "text-destructive"
                  : "text-muted-foreground",
            )}
          >
            {node.status === "added"
              ? "+"
              : node.status === "removed"
                ? "−"
                : "·"}
          </span>
          <span
            className={cn(
              "min-w-0 truncate",
              node.kind === "dependency" && "font-medium text-status-info",
            )}
            title={
              node.kind === "dependency"
                ? "Dependency boundary: control crosses a receiver-held collaborator."
                : undefined
            }
          >
            {node.label}
          </span>
          {node.file === undefined ? null : (
            <span
              className="ml-auto shrink-0 text-muted-foreground tabular-nums"
              title={node.file}
            >
              {node.line === undefined ? sourceFile?.name : `L${node.line}`}
            </span>
          )}
        </Button>
        {callFlowChildNodeInstances(node.children, nodeInstanceId).map(
          ({ node: child, nodeInstanceId: childInstanceId }) => (
            <CallFlowNodeList
              key={childInstanceId}
              node={child}
              nodeInstanceId={childInstanceId}
              depth={depth + 1}
              parentFile={node.file ?? parentFile}
              selectedNodes={selectedNodes}
              onSelect={onSelect}
            />
          ),
        )}
      </li>
    </ol>
  );
}

type CallFlowChildNodeInstance = {
  readonly node: CallFlowNode;
  readonly nodeInstanceId: string;
};

function callFlowChildNodeInstances(
  nodes: ReadonlyArray<CallFlowNode>,
  parentId: string,
): ReadonlyArray<CallFlowChildNodeInstance> {
  const occurrences = new Map<string, number>();
  const instances: Array<CallFlowChildNodeInstance> = [];
  for (const node of nodes) {
    const identity = callFlowNodeIdentity(node);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    instances.push({
      node,
      nodeInstanceId: callFlowNodeInstanceId(parentId, node, occurrence),
    });
  }
  return instances;
}

function callFlowNodeInstanceId(
  parentId: string,
  node: CallFlowNode,
  occurrence: number,
): string {
  return `${parentId}:${callFlowNodeIdentity(node)}:${occurrence}`;
}

function callFlowNodeIdentity(node: CallFlowNode): string {
  return JSON.stringify([node.key, node.file, node.line, node.endLine]);
}

function splitSourcePath(path: string) {
  const separator = path.lastIndexOf("/");
  if (separator === -1) return { name: path, directory: "" };
  return {
    name: path.slice(separator + 1),
    directory: path.slice(0, separator),
  };
}

function projectCallFlowTrees(
  trees: ReadyCallFlow["trees"],
  query: string,
  projection: CallFlowProjection,
  showAllContext: boolean,
): ReadonlyArray<VisibleCallFlowTree> {
  const normalizedQuery = query.trim().toLowerCase();
  return trees.flatMap((entry) => {
    const tree = projectCallFlowNode(
      entry.tree,
      normalizedQuery,
      projection,
      showAllContext,
      false,
    );
    return tree === undefined ? [] : [{ ...entry, tree }];
  });
}

function projectCallFlowNode(
  node: CallFlowNode,
  normalizedQuery: string,
  projection: CallFlowProjection,
  showAllContext: boolean,
  ancestorMatchesQuery: boolean,
): CallFlowNode | undefined {
  const matchesQuery =
    normalizedQuery.length === 0 ||
    node.label.toLowerCase().includes(normalizedQuery) ||
    node.file?.toLowerCase().includes(normalizedQuery) === true;
  const children = node.children.flatMap((child) => {
    const filtered = projectCallFlowNode(
      child,
      normalizedQuery,
      projection,
      showAllContext,
      ancestorMatchesQuery || matchesQuery,
    );
    return filtered === undefined ? [] : [filtered];
  });
  const statusIsVisible =
    projection === "changes"
      ? showAllContext || node.status !== "same"
      : projection === "new" || projection === "after"
        ? node.status === "added"
        : node.status === "removed";
  const queryIsVisible =
    normalizedQuery.length === 0 || ancestorMatchesQuery || matchesQuery;
  const visible = children.length > 0 || (statusIsVisible && queryIsVisible);
  return visible ? { ...node, children } : undefined;
}

function countStatus(node: CallFlowNode, status: CallFlowNodeStatus): number {
  return (
    (node.status === status ? 1 : 0) +
    node.children.reduce(
      (count, child) => count + countStatus(child, status),
      0,
    )
  );
}

function countChanged(node: CallFlowNode): number {
  return countStatus(node, "added") + countStatus(node, "removed");
}

function countCallFlowEntry(
  node: CallFlowNode,
  countKind: CallFlowEntryCount,
): number {
  return countKind === "changed"
    ? countChanged(node)
    : countStatus(node, countKind);
}

function CallFlowLoading(): React.JSX.Element {
  return (
    <section
      aria-label="Call Flow"
      aria-busy="true"
      className="flex h-full flex-col gap-3 p-4"
    >
      <div className="flex items-start justify-between gap-3 border-b pb-3">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-3 w-72" />
        </div>
        <Skeleton className="h-7 w-36" />
      </div>
      {Array.from({ length: 7 }, (_, index) => (
        <Skeleton key={index} className="h-7 w-full" />
      ))}
      <p className="sr-only" role="status">
        Inferring changed call paths…
      </p>
    </section>
  );
}

function CallFlowFailure({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <div className="p-5">
      <Alert variant="destructive">
        <Braces />
        <AlertTitle>Call Flow could not load</AlertTitle>
        <AlertDescription>
          The response did not match this Review session. Try the bounded run
          again.
        </AlertDescription>
      </Alert>
      <Button className="mt-3" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function CallFlowUnavailable({
  reason,
  onRetry,
}: {
  readonly reason: Extract<
    CallFlowResponse,
    { state: "unavailable" }
  >["reason"];
  readonly onRetry: () => void;
}) {
  const message =
    reason === "metadata_only"
      ? "Call Flow needs the immutable local checkout for this Review. The Diff remains available."
      : reason === "too_large"
        ? "This repository has more source files than the bounded Call Flow run accepts."
        : reason === "timed_out"
          ? "The bounded Call Flow run timed out."
          : reason === "cancelled"
            ? "The Call Flow run was cancelled."
            : reason === "runtime_unavailable"
              ? "The bundled Call Flow runtime is unavailable."
              : "The Call Flow engine could not analyze this Review.";
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Braces />
        </EmptyMedia>
        <EmptyTitle>Call Flow unavailable</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function CallFlowUnsupported({
  response,
}: {
  readonly response: Extract<CallFlowResponse, { state: "unsupported" }>;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Braces />
        </EmptyMedia>
        <EmptyTitle>No supported changed source</EmptyTitle>
        <EmptyDescription>
          This release analyzes Go, JavaScript, JSX, TypeScript, and TSX. It
          skipped {response.languages.skippedChangedFiles} changed files in this
          Review.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function CallFlowEmpty(): React.JSX.Element {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Braces />
        </EmptyMedia>
        <EmptyTitle>No changed call paths</EmptyTitle>
        <EmptyDescription>
          The supported source changed, but the syntactic call paths did not.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
