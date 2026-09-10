// PROTOTYPE — issue #119, throwaway. Do not build on this.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircleCheck,
  CircleDot,
  CircleX,
  Clock3,
  FolderGit2,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  Inbox,
  Pin,
  TriangleAlert,
} from "lucide-react";

import { api } from "@/api-client";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Profile } from "@/renderer-models";
import { isProfile } from "@/workspace-state";
import {
  prototypePullRequests,
  prototypeRepoKey,
  prototypeRowKey,
  prototypeSelectedRowKey,
  type PrototypePullRequestRow,
  type PrototypeRepoPullRequests,
} from "./sidebar-prototype-fixtures";

type QueueItem = {
  readonly kind: "queue";
  readonly key: string;
  readonly workspace: string;
  readonly repoKey: string;
  readonly row: PrototypePullRequestRow;
  /** True when the row is only here because it is the selected one. */
  readonly pinned: boolean;
};

type RepoItem = {
  readonly kind: "repo";
  readonly key: string;
  readonly workspace: string;
  readonly owner: string;
  readonly repo: string;
  readonly data: PrototypeRepoPullRequests;
};

type ListItem = QueueItem | RepoItem;

export function SidebarVariantBQueue(): React.JSX.Element {
  const [profiles, setProfiles] = useState<ReadonlyArray<Profile>>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState(prototypeSelectedRowKey);
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const payload = await api("/v1/profiles");
        const loaded = Array.isArray(payload) ? payload.filter(isProfile) : [];
        if (live) setProfiles(loaded);
      } catch {
        if (live) setLoadFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const queue = useMemo(
    () => buildQueue(profiles, selected),
    [profiles, selected],
  );
  const repos = useMemo(() => buildRepos(profiles), [profiles]);
  const items = useMemo<ReadonlyArray<ListItem>>(
    () => [...queue, ...repos],
    [queue, repos],
  );

  useEffect(() => {
    if (focusKey === undefined) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-node-key="${cssEscape(focusKey)}"]`)
      ?.focus();
  }, [focusKey, items]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const active = focusKey ?? items[0]?.key;
    const index = items.findIndex((item) => item.key === active);
    if (index < 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusKey(items[Math.min(index + 1, items.length - 1)]?.key);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocusKey(items[Math.max(index - 1, 0)]?.key);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      setSelected(items[index]?.key ?? selected);
    }
  };

  const firstKey = focusKey ?? items[0]?.key;

  return (
    <aside className="mr-1 flex h-full w-[280px] min-w-0 shrink-0 flex-col overflow-hidden rounded-t-lg border border-b-0 bg-background">
      <div
        ref={listRef}
        role="listbox"
        aria-label="Pull requests waiting on you, and watched repositories"
        className="min-h-0 flex-1 overflow-y-auto pb-2"
        onKeyDown={onKeyDown}
      >
        {loadFailed ? (
          <p className="px-3 py-2 text-[12px] text-muted-foreground">
            Could not read the workspace profiles.
          </p>
        ) : null}

        <div role="group" aria-label="Needs you">
          <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
            <Inbox className="size-3.5 text-primary" />
            <span className="flex-1 text-[12px] font-semibold tracking-tight">
              Needs you
            </span>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {queue.length}
            </span>
          </div>
          {queue.length === 0 ? (
            <p className="px-3 py-3 text-[12px] text-muted-foreground">
              No pull request is waiting on your review.
            </p>
          ) : (
            queue.map((item) => (
              <QueueRow
                key={item.key}
                item={item}
                selected={selected === item.key}
                focused={firstKey === item.key}
                onSelect={() => {
                  setFocusKey(item.key);
                  setSelected(item.key);
                }}
              />
            ))
          )}
        </div>

        <div className="mx-3 my-2 border-t" />

        <div role="group" aria-label="Repositories">
          <div className="flex items-center gap-2 px-3 py-1.5">
            <FolderGit2 className="size-3 text-muted-foreground" />
            <span className="flex-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Repositories
            </span>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {repos.length}
            </span>
          </div>
          {repos.map((item) => (
            <RepoRow
              key={item.key}
              item={item}
              selected={selected === item.key}
              focused={firstKey === item.key}
              onSelect={() => {
                setFocusKey(item.key);
                setSelected(item.key);
              }}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}

function QueueRow({
  item,
  selected,
  focused,
  onSelect,
}: {
  readonly item: QueueItem;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly onSelect: () => void;
}): React.JSX.Element {
  return (
    <div
      data-node-key={item.key}
      role="option"
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 items-start gap-2 px-3 py-2.5 outline-none hover:bg-muted/60",
        selected && "bg-primary/15",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
    >
      <PullIcon row={item.row} />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-[13px] leading-5",
            selected ? "font-semibold" : "font-medium",
          )}
          title={item.row.title}
        >
          {item.row.title}
        </span>
        <span
          className="flex min-w-0 items-baseline gap-1 text-[11px] leading-4 text-muted-foreground"
          title={`${item.workspace} · ${item.repoKey} #${item.row.number} — ${item.row.author}`}
        >
          {/* The number is the one part of the line that must not truncate. */}
          <span className="min-w-0 truncate">
            {item.workspace} · {item.repoKey}
          </span>
          <span className="shrink-0 tabular-nums">#{item.row.number}</span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1 pt-0.5">
        {item.pinned ? (
          <Pin
            className="size-3.5 text-muted-foreground"
            aria-label="Pinned because it is open"
          />
        ) : null}
        {item.row.mergeable === "CONFLICTING" ? (
          <TriangleAlert
            className="size-3.5 text-status-warning"
            aria-label="Merge conflict"
          />
        ) : null}
        <ChecksIcon row={item.row} />
      </span>
    </div>
  );
}

function RepoRow({
  item,
  selected,
  focused,
  onSelect,
}: {
  readonly item: RepoItem;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly onSelect: () => void;
}): React.JSX.Element {
  const failed = item.data.loadError !== undefined;
  return (
    <div
      data-node-key={item.key}
      role="option"
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      onClick={onSelect}
      className={cn(
        "flex h-7 min-w-0 items-center gap-1.5 px-3 outline-none hover:bg-muted/50",
        selected && "bg-primary/10",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
    >
      <Badge
        variant="secondary"
        className="h-4 shrink-0 px-1.5 text-[10px] font-normal text-muted-foreground"
      >
        {item.workspace}
      </Badge>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[12.5px]",
          selected && "font-medium",
        )}
        title={failed ? `${item.key} — ${item.data.loadError}` : item.key}
      >
        <span className="text-muted-foreground">{item.owner}/</span>
        {item.repo}
      </span>
      {failed ? (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-destructive">
          <TriangleAlert className="size-3.5" />
          Load failed
        </span>
      ) : (
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {item.data.totalCount ?? "—"}
        </span>
      )}
    </div>
  );
}

function PullIcon({
  row,
}: {
  readonly row: PrototypePullRequestRow;
}): React.JSX.Element {
  if (row.merged)
    return <GitMerge className="mt-0.5 size-4 shrink-0 text-status-info" />;
  if (row.isDraft)
    return (
      <GitPullRequestDraft className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
    );
  return (
    <GitPullRequest className="mt-0.5 size-4 shrink-0 text-status-success" />
  );
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

/** Every review request across every workspace, newest first, plus the selected
 * row when nothing else would have kept it on screen. */
function buildQueue(
  profiles: ReadonlyArray<Profile>,
  selected: string,
): ReadonlyArray<QueueItem> {
  const waiting: Array<QueueItem> = [];
  let pinned: QueueItem | undefined = undefined;
  for (const profile of profiles) {
    for (const repo of profile.repos ?? []) {
      const repoKey = prototypeRepoKey(repo.owner, repo.repo);
      for (const row of prototypePullRequests(repoKey).rows) {
        const key = prototypeRowKey(repoKey, row.number);
        const item = {
          kind: "queue",
          key,
          workspace: profile.label,
          repoKey,
          row,
          pinned: false,
        } as const satisfies QueueItem;
        if (row.reviewRequestedForMe) waiting.push(item);
        else if (key === selected) pinned = { ...item, pinned: true };
      }
    }
  }
  const rows = pinned === undefined ? waiting : [...waiting, pinned];
  return rows.sort((left, right) =>
    right.row.updatedAt.localeCompare(left.row.updatedAt),
  );
}

/** Every watched repo, flat and alphabetical, with its workspace demoted to a
 * badge — the whole argument this variant makes. */
function buildRepos(profiles: ReadonlyArray<Profile>): ReadonlyArray<RepoItem> {
  const byKey = new Map<string, RepoItem>();
  for (const profile of profiles) {
    for (const repo of profile.repos ?? []) {
      const key = prototypeRepoKey(repo.owner, repo.repo);
      if (byKey.has(key)) continue;
      byKey.set(key, {
        kind: "repo",
        key,
        workspace: profile.label,
        owner: repo.owner,
        repo: repo.repo,
        data: prototypePullRequests(key),
      });
    }
  }
  return [...byKey.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

/** Repo keys carry `/` and `#`, neither of which is legal raw in a selector. */
function cssEscape(value: string): string {
  return value.replaceAll(/[^\w-]/g, (character) => `\\${character}`);
}
