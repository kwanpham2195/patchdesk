// PROTOTYPE — issue #119, throwaway. Do not build on this.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleX,
  Clock3,
  Eye,
  FolderGit2,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  TriangleAlert,
  Users,
} from "lucide-react";

import { api } from "@/api-client";
import { cn } from "@/lib/utils";
import type { Profile } from "@/renderer-models";
import { isProfile } from "@/workspace-state";
import {
  prototypePullRequests,
  prototypeRepoKey,
  prototypeRowKey,
  prototypeSelectedRowKey,
  prototypeVisibleRowLimit,
  type PrototypePullRequestRow,
  type PrototypeRepoPullRequests,
} from "./sidebar-prototype-fixtures";

type TreeNode =
  | {
      readonly kind: "profile";
      readonly key: string;
      readonly profile: Profile;
    }
  | {
      readonly kind: "repo";
      readonly key: string;
      readonly owner: string;
      readonly repo: string;
      readonly data: PrototypeRepoPullRequests;
    }
  | {
      readonly kind: "pull";
      readonly key: string;
      readonly row: PrototypePullRequestRow;
    }
  | {
      readonly kind: "footer";
      readonly key: string;
      readonly total: number | undefined;
    }
  | {
      readonly kind: "note";
      readonly key: string;
      readonly text: string;
      readonly failed: boolean;
    };

const nodeLevel = { profile: 1, repo: 2, pull: 3, footer: 3, note: 3 } as const;

export function SidebarVariantATree(): React.JSX.Element {
  const [profiles, setProfiles] = useState<ReadonlyArray<Profile>>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(["kwanpham2195/patchdesk"]),
  );
  const [selected, setSelected] = useState(prototypeSelectedRowKey);
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  const treeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const payload = await api("/v1/profiles");
        const loaded = Array.isArray(payload) ? payload.filter(isProfile) : [];
        if (live) {
          setProfiles(loaded);
          setExpanded(
            (current) =>
              new Set([...current, ...loaded.map((profile) => profile.id)]),
          );
        }
      } catch {
        if (live) setLoadFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const nodes = useMemo(
    () => flatten(profiles, expanded),
    [profiles, expanded],
  );

  useEffect(() => {
    if (focusKey === undefined) return;
    treeRef.current
      ?.querySelector<HTMLElement>(`[data-node-key="${cssEscape(focusKey)}"]`)
      ?.focus();
  }, [focusKey, nodes]);

  const toggle = (key: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const active = focusKey ?? nodes[0]?.key;
    const index = nodes.findIndex((node) => node.key === active);
    if (index < 0) return;
    const node = nodes[index];
    if (node === undefined) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusKey(nodes[Math.min(index + 1, nodes.length - 1)]?.key);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocusKey(nodes[Math.max(index - 1, 0)]?.key);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (isExpandable(node) && !expanded.has(node.key)) toggle(node.key);
      else setFocusKey(nodes[Math.min(index + 1, nodes.length - 1)]?.key);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (isExpandable(node) && expanded.has(node.key)) toggle(node.key);
      else setFocusKey(parentKey(nodes, index) ?? node.key);
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      if (isExpandable(node)) toggle(node.key);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (node.kind === "pull" || node.kind === "repo") setSelected(node.key);
    }
  };

  return (
    <aside className="mr-1 flex h-full w-[280px] min-w-0 shrink-0 flex-col overflow-hidden rounded-t-lg border border-b-0 bg-background">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <FolderGit2 className="size-3.5 text-muted-foreground" />
        <span className="text-[12px] font-semibold tracking-tight">
          Workspaces
        </span>
      </div>
      <div
        ref={treeRef}
        role="tree"
        aria-label="Workspaces, repositories and pull requests"
        className="min-h-0 flex-1 overflow-y-auto py-1"
        onKeyDown={onKeyDown}
      >
        {loadFailed ? (
          <p className="px-3 py-2 text-[12px] text-muted-foreground">
            Could not read the workspace profiles.
          </p>
        ) : null}
        {nodes.map((node) => (
          <TreeRow
            key={node.key}
            node={node}
            expanded={expanded.has(node.key)}
            selected={selected === node.key}
            focused={(focusKey ?? nodes[0]?.key) === node.key}
            onToggle={() => toggle(node.key)}
            onSelect={() => {
              setFocusKey(node.key);
              if (node.kind === "pull" || node.kind === "repo")
                setSelected(node.key);
            }}
          />
        ))}
      </div>
    </aside>
  );
}

function TreeRow({
  node,
  expanded,
  selected,
  focused,
  onToggle,
  onSelect,
}: {
  readonly node: TreeNode;
  readonly expanded: boolean;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly onToggle: () => void;
  readonly onSelect: () => void;
}): React.JSX.Element {
  const level = nodeLevel[node.kind];
  const indent = { paddingLeft: `${0.375 + (level - 1) * 0.625}rem` };
  return (
    <div
      data-node-key={node.key}
      role="treeitem"
      aria-level={level}
      aria-selected={selected}
      aria-expanded={isExpandable(node) ? expanded : undefined}
      tabIndex={focused ? 0 : -1}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 items-center gap-1 pr-1.5 outline-none",
        node.kind === "profile" ? "mt-1 h-7" : "h-7",
        node.kind !== "profile" && "hover:bg-muted/50",
        selected && "bg-primary/10",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
      style={indent}
    >
      {isExpandable(node) ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${nodeLabel(node)}`}
          title={`${expanded ? "Collapse" : "Expand"} ${nodeLabel(node)}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          // The disclosure is its own boxed hit target so it reads as separate
          // from the name beside it, which is the whole question this variant asks.
          className="flex size-5 shrink-0 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-border hover:bg-muted"
        >
          {expanded ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
        </button>
      ) : (
        <span className="size-2 shrink-0" />
      )}
      <RowBody node={node} selected={selected} />
    </div>
  );
}

function RowBody({
  node,
  selected,
}: {
  readonly node: TreeNode;
  readonly selected: boolean;
}): React.JSX.Element {
  switch (node.kind) {
    case "profile":
      return (
        <>
          <Users className="size-3.5 shrink-0 text-muted-foreground" />
          <span
            className="min-w-0 flex-1 truncate text-[12px] font-semibold tracking-tight uppercase"
            title={`${node.profile.label} · ${node.profile.ghAccount} @ ${node.profile.githubHost}`}
          >
            {node.profile.label}
          </span>
          <span className="w-9 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
            {node.profile.repos?.length ?? 0}
          </span>
        </>
      );
    case "repo":
      return (
        <>
          <button
            type="button"
            tabIndex={-1}
            title={`${node.owner}/${node.repo}`}
            className={cn(
              "min-w-0 flex-1 truncate rounded px-1 text-left text-[12.5px] hover:underline",
              selected && "font-medium",
            )}
          >
            {node.repo}
          </button>
          <span className="flex w-9 shrink-0 items-center justify-end gap-1 text-[11px] text-muted-foreground tabular-nums">
            {node.data.loadError === undefined ? (
              <>{node.data.totalCount ?? "—"}</>
            ) : (
              <TriangleAlert className="size-3.5 text-status-warning" />
            )}
          </span>
        </>
      );
    case "pull":
      return (
        <>
          <PullIcon row={node.row} />
          <span
            className="min-w-0 flex-1 truncate text-[12.5px]"
            title={`#${node.row.number} ${node.row.title} — ${node.row.author}`}
          >
            <span className="text-muted-foreground tabular-nums">
              #{node.row.number}
            </span>{" "}
            {node.row.title}
          </span>
          <span className="flex w-9 shrink-0 items-center justify-end gap-0.5">
            {node.row.reviewRequestedForMe ? (
              <Eye
                className="size-3.5 text-primary"
                aria-label="Awaiting your review"
              />
            ) : null}
            <ChecksIcon row={node.row} />
          </span>
        </>
      );
    case "footer":
      return (
        <>
          <span className="size-3.5 shrink-0" />
          <button
            type="button"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
            className="min-w-0 flex-1 truncate text-left text-[12px] text-primary hover:underline"
          >
            {node.total === undefined ? "View all" : `View all ${node.total}`}
          </button>
          <span className="w-9 shrink-0" />
        </>
      );
    case "note":
      return (
        <>
          <span className="size-3.5 shrink-0" />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[12px]",
              node.failed ? "text-destructive" : "text-muted-foreground",
            )}
            title={node.text}
          >
            {node.text}
          </span>
          <span className="w-9 shrink-0" />
        </>
      );
  }
}

function PullIcon({
  row,
}: {
  readonly row: PrototypePullRequestRow;
}): React.JSX.Element {
  if (row.merged)
    return <GitMerge className="size-3.5 shrink-0 text-status-info" />;
  if (row.isDraft)
    return (
      <GitPullRequestDraft className="size-3.5 shrink-0 text-muted-foreground" />
    );
  return <GitPullRequest className="size-3.5 shrink-0 text-status-success" />;
}

function ChecksIcon({
  row,
}: {
  readonly row: PrototypePullRequestRow;
}): React.JSX.Element | null {
  switch (row.checks) {
    case "SUCCESS":
      return (
        <CircleCheck
          className="size-3.5 text-status-success"
          aria-label="Checks passing"
        />
      );
    case "FAILURE":
    case "ERROR":
      return (
        <CircleX
          className="size-3.5 text-destructive"
          aria-label="Checks failing"
        />
      );
    case "PENDING":
      return (
        <Clock3
          className="size-3.5 text-status-warning"
          aria-label="Checks running"
        />
      );
    case null:
      return (
        <CircleDot
          className="size-3.5 text-muted-foreground/50"
          aria-label="No checks"
        />
      );
  }
}

function flatten(
  profiles: ReadonlyArray<Profile>,
  expanded: ReadonlySet<string>,
): ReadonlyArray<TreeNode> {
  const nodes: Array<TreeNode> = [];
  for (const profile of profiles) {
    nodes.push({ kind: "profile", key: profile.id, profile });
    if (!expanded.has(profile.id)) continue;
    for (const repo of profile.repos ?? []) {
      const repoKey = prototypeRepoKey(repo.owner, repo.repo);
      const data = prototypePullRequests(repoKey);
      nodes.push({
        kind: "repo",
        key: repoKey,
        owner: repo.owner,
        repo: repo.repo,
        data,
      });
      if (!expanded.has(repoKey)) continue;
      if (data.loadError !== undefined) {
        nodes.push({
          kind: "note",
          key: `${repoKey}:error`,
          text: data.loadError,
          failed: true,
        });
        continue;
      }
      if (data.rows.length === 0) {
        nodes.push({
          kind: "note",
          key: `${repoKey}:empty`,
          text: "No open pull requests",
          failed: false,
        });
        continue;
      }
      const shown = data.rows.slice(0, prototypeVisibleRowLimit);
      for (const row of shown)
        nodes.push({
          kind: "pull",
          key: prototypeRowKey(repoKey, row.number),
          row,
        });
      if (data.totalCount === undefined || data.totalCount > shown.length)
        nodes.push({
          kind: "footer",
          key: `${repoKey}:more`,
          total: data.totalCount,
        });
    }
  }
  return nodes;
}

function isExpandable(node: TreeNode): boolean {
  return node.kind === "profile" || node.kind === "repo";
}

function nodeLabel(node: TreeNode): string {
  if (node.kind === "profile") return node.profile.label;
  if (node.kind === "repo") return `${node.owner}/${node.repo}`;
  return "";
}

function parentKey(
  nodes: ReadonlyArray<TreeNode>,
  index: number,
): string | undefined {
  const level = nodeLevel[nodes[index]?.kind ?? "profile"];
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = nodes[cursor];
    if (candidate !== undefined && nodeLevel[candidate.kind] < level)
      return candidate.key;
  }
  return undefined;
}

/** Repo keys carry `/` and `#`, neither of which is legal raw in a selector. */
function cssEscape(value: string): string {
  return value.replaceAll(/[^\w-]/g, (character) => `\\${character}`);
}
