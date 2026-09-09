// PROTOTYPE — issue #119, throwaway. Do not build on this.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
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
} from "./sidebar-prototype-fixtures";

/** One local Review record, every field of it readable off disk. */
type VisitedRow = {
  readonly key: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "merged" | "closed";
  readonly insightReady: boolean;
  readonly openedAt: number;
};

type Workspace = {
  readonly profile: Profile;
  readonly rows: ReadonlyArray<VisitedRow>;
  readonly holdsSelected: boolean;
};

/** The cap, plus the selection when the cap pushed it off the end. */
type Recents = {
  readonly shown: ReadonlyArray<VisitedRow>;
  readonly pinned: VisitedRow | undefined;
  readonly total: number;
};

type DateGroup = { readonly label: string; readonly rows: Array<VisitedRow> };

type RowProps = {
  readonly row: VisitedRow;
  readonly showRepo: boolean;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly onFocusRow: (key: string) => void;
  readonly onSelectRow: (key: string) => void;
  readonly onArchiveRow: (key: string) => void;
};

/** The most recently opened reviews a workspace shows before the cap bites. */
const recentLimit = 20;

/** How many landed reviews sit behind a repo's open ones. */
const archiveDepth = 18;

/** Fixed "now" so a row's relative time is the same on every reload. */
const referenceNow = Date.UTC(2026, 8, 9, 12);

const dayMs = 86_400_000;

const archivedTitles = [
  "Retire the legacy session lock file",
  "Split the inbox query off the workspace boot path",
  "Teach the merge queue to report its own base",
  "Trim the avatar cache on profile removal",
];

export function SidebarVariantD2Grouped(): React.JSX.Element {
  const [profiles, setProfiles] = useState<ReadonlyArray<Profile>>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [activeProfileId, setActiveProfileId] = useState<string>();
  const [selected, setSelected] = useState(prototypeSelectedRowKey);
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  const [archived, setArchived] = useState<ReadonlySet<string>>(new Set());
  const [collapsed, setCollapsed] = useState(false);
  const railRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const payload = await api("/v1/profiles");
        if (live) {
          const loaded = Array.isArray(payload)
            ? payload.filter(isProfile)
            : [];
          setProfiles(loaded);
          // Open on the workspace that holds the fixture selection.
          const home = loaded.find((profile) =>
            visitedRows(profile).some((r) => r.key === prototypeSelectedRowKey),
          );
          setActiveProfileId((home ?? loaded[0])?.id);
        }
      } catch {
        if (live) setLoadFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const workspaces = useMemo(
    () =>
      profiles.map((profile) => {
        const rows = visitedRows(profile).filter(
          (row) => !archived.has(row.key),
        );
        return {
          profile,
          rows,
          holdsSelected: rows.some((row) => row.key === selected),
        };
      }),
    [profiles, selected, archived],
  );
  const active =
    workspaces.find((workspace) => workspace.profile.id === activeProfileId) ??
    workspaces[0];
  const recents = useMemo((): Recents => {
    const rows = active?.rows ?? [];
    const cut = rows.slice(recentLimit).find((row) => row.key === selected);
    return {
      shown: rows.slice(0, recentLimit),
      pinned: cut,
      total: rows.length,
    };
  }, [active?.rows, selected]);
  const groups = useMemo(() => toDateGroups(recents.shown), [recents.shown]);
  const keys = useMemo(
    () =>
      [...recents.shown, ...(recents.pinned ? [recents.pinned] : [])].map(
        (row) => row.key,
      ),
    [recents],
  );

  useEffect(() => {
    if (focusKey === undefined) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row-key="${cssEscape(focusKey)}"]`)
      ?.focus();
  }, [focusKey, keys]);

  const travelTo = (profileId: string): void => {
    setActiveProfileId(profileId);
    setFocusKey(undefined);
  };

  const onRailKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = workspaces.findIndex(
      (workspace) => workspace.profile.id === active?.profile.id,
    );
    if (index < 0) return;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const at = (index + delta + workspaces.length) % workspaces.length;
    const next = workspaces[at];
    if (next === undefined) return;
    // Roving focus follows the travel, so the rail keeps the keyboard.
    railRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[at]?.focus();
    travelTo(next.profile.id);
  };

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const current = focusKey ?? keys[0];
      if (current !== undefined) setSelected(current);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = keys.indexOf(focusKey ?? keys[0] ?? "");
    if (index < 0) return;
    setFocusKey(
      event.key === "ArrowDown"
        ? keys[Math.min(index + 1, keys.length - 1)]
        : keys[Math.max(index - 1, 0)],
    );
  };

  const rowProps = (row: VisitedRow): RowProps => ({
    row,
    // One watched repository makes `owner/repo` on every row pure noise.
    showRepo: (active?.profile.repos ?? []).length > 1,
    selected: selected === row.key,
    focused: (focusKey ?? keys[0]) === row.key,
    onFocusRow: setFocusKey,
    onSelectRow: setSelected,
    onArchiveRow: (key) => setArchived((rest) => new Set(rest).add(key)),
  });
  const collapseLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const CollapseIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <aside
      className={cn(
        "mr-1 flex h-full min-w-0 shrink-0 overflow-hidden rounded-t-lg border border-b-0 bg-background",
        collapsed ? "w-12" : "w-[300px]",
      )}
    >
      <div className="flex w-12 shrink-0 flex-col border-r bg-muted/30">
        <div
          ref={railRef}
          role="tablist"
          aria-orientation="vertical"
          aria-label="Workspaces"
          onKeyDown={onRailKeyDown}
          className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto py-2"
        >
          {workspaces.map((workspace) => {
            const here = workspace.profile.id === active?.profile.id;
            return (
              <button
                key={workspace.profile.id}
                type="button"
                role="tab"
                aria-selected={here}
                tabIndex={here ? 0 : -1}
                title={workspaceTitle(workspace)}
                onClick={() => travelTo(workspace.profile.id)}
                className={cn(
                  "relative flex size-9 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  here
                    ? "bg-primary text-primary-foreground before:absolute before:top-1 before:-left-1.5 before:h-7 before:w-0.5 before:rounded-r before:bg-primary before:content-['']"
                    : "bg-muted text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground",
                  workspace.holdsSelected && !here && "ring-1 ring-primary/70",
                )}
              >
                {initials(workspace.profile.label)}
              </button>
            );
          })}
        </div>
        {/* The rail is all that survives a collapse, so the toggle sits here
         * rather than moving between the two states. */}
        <div className="flex shrink-0 justify-center border-t py-1.5">
          <button
            type="button"
            aria-label={collapseLabel}
            aria-expanded={!collapsed}
            title={collapseLabel}
            onClick={() => setCollapsed((current) => !current)}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted-foreground/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CollapseIcon className="size-4" />
          </button>
        </div>
      </div>
      {collapsed ? null : (
        <div
          role="tabpanel"
          aria-label={active?.profile.label ?? "Workspace"}
          className="flex min-w-0 flex-1 flex-col"
        >
          <div className="flex min-w-0 items-center gap-2 border-b px-2.5 py-2">
            <span
              className="min-w-0 flex-1 truncate text-[12px] font-semibold tracking-tight uppercase"
              title={active === undefined ? undefined : workspaceTitle(active)}
            >
              {active?.profile.label ?? "Workspaces"}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              recent
            </span>
          </div>
          {/* The shared ScrollArea draws a zero-width thumb here, so the
           * native bar is styled down instead: thin, rounded, low contrast. */}
          <div
            ref={listRef}
            role="listbox"
            onKeyDown={onListKeyDown}
            aria-label="Pull requests you have opened"
            className="min-h-0 flex-1 overflow-y-auto pb-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25 hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/45"
          >
            {recents.total === 0 ? (
              <p className="px-2.5 py-2 text-[12px] text-muted-foreground">
                {loadFailed
                  ? "Could not read the workspace profiles."
                  : "You have not opened a pull request in this workspace yet."}
              </p>
            ) : null}
            {groups.map((group) => (
              <div key={group.label}>
                <p className="px-2.5 pt-3 pb-0.5 text-[10px] font-semibold tracking-widest text-muted-foreground/80 uppercase">
                  {group.label}
                </p>
                {group.rows.map((row) => (
                  <VisitedRowView key={row.key} {...rowProps(row)} />
                ))}
              </div>
            ))}
            {recents.pinned === undefined ? null : (
              // Selection outlives the cap: an older open PR stays reachable.
              <div className="mt-2 border-t pt-0.5">
                <VisitedRowView {...rowProps(recents.pinned)} />
              </div>
            )}
          </div>
          {recents.total > recentLimit ? (
            <p className="border-t px-2.5 py-1.5 text-[11px] text-muted-foreground tabular-nums">
              {recentLimit} of {recents.total} recent
            </p>
          ) : null}
        </div>
      )}
    </aside>
  );
}

function VisitedRowView(props: RowProps): React.JSX.Element {
  const { row, selected } = props;
  const [StateFace, tone, stateLabel] = stateFaces[row.state];
  const repo = props.showRepo ? `${row.owner}/${row.repo} ` : "";
  return (
    // Archive is a sibling of the option rather than a child, so the option
    // subtree holds no nested interactive element.
    <div className="group relative">
      <div
        data-row-key={row.key}
        role="option"
        aria-selected={selected}
        tabIndex={props.focused ? 0 : -1}
        title={row.title}
        onClick={() => {
          props.onFocusRow(row.key);
          props.onSelectRow(row.key);
        }}
        className={cn(
          "relative flex min-w-0 items-start gap-1.5 py-1.5 pr-9 pl-2.5 outline-none",
          "group-hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          selected && "bg-primary/10",
        )}
      >
        {selected ? (
          <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />
        ) : null}
        <StateFace
          className={cn("mt-0.5 size-3.5 shrink-0", tone)}
          aria-label={stateLabel}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="min-w-0 truncate text-[13px] leading-snug font-medium">
            {row.title}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="min-w-0 truncate tabular-nums">
              {repo}#{row.number} · {relativeOpened(row.openedAt)}
            </span>
            {row.insightReady ? (
              <span className="ml-auto flex shrink-0 items-center gap-0.5 text-[10px] text-primary">
                <Sparkles className="size-3" aria-hidden="true" />
                Insight
              </span>
            ) : null}
          </span>
        </span>
      </div>
      <button
        type="button"
        aria-label={`Archive ${row.title}`}
        onClick={() => props.onArchiveRow(row.key)}
        className="absolute top-1 right-2.5 flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none group-hover:opacity-100 hover:bg-muted-foreground/20 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Archive className="size-3.5" />
      </button>
    </div>
  );
}

const stateFaces = {
  merged: [GitMerge, "text-status-info", "Merged"],
  closed: [GitPullRequestClosed, "text-destructive", "Closed"],
  open: [GitPullRequest, "text-status-success", "Open"],
} as const;

/** Cuts the list where its date bucket changes: an empty bucket gets no
 * header, and no row moves. */
function toDateGroups(rows: ReadonlyArray<VisitedRow>): Array<DateGroup> {
  const groups: Array<DateGroup> = [];
  for (const row of rows) {
    const label = dateGroupLabel(row.openedAt);
    const last = groups.at(-1);
    if (last?.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}

function dateGroupLabel(openedAt: number): string {
  const days = Math.floor(referenceNow / dayMs) - Math.floor(openedAt / dayMs);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  return "Earlier";
}

/** Every review this workspace has a local record for, newest visit first. */
function visitedRows(profile: Profile): ReadonlyArray<VisitedRow> {
  const byKey = new Map<string, VisitedRow>();
  for (const repo of profile.repos ?? []) {
    const repoKey = prototypeRepoKey(repo.owner, repo.repo);
    for (const row of prototypePullRequests(repoKey).rows) {
      const state = row.merged ? "merged" : "open";
      addRow(byKey, repo, row.number, row.title, state);
    }
    for (let index = 0; index < archiveDepth; index += 1) {
      const spin = hash(`${repoKey}:archive:${index}`);
      const title = archivedTitles[spin % archivedTitles.length] ?? "Untitled";
      const landed = spin % 5 === 0 ? "closed" : "merged";
      const state = spin % 7 === 0 ? "open" : landed;
      addRow(byKey, repo, 900 + (spin % 900), title, state);
    }
  }
  return [...byKey.values()].sort(
    (left, right) => right.openedAt - left.openedAt,
  );
}

function addRow(
  byKey: Map<string, VisitedRow>,
  repo: { readonly owner: string; readonly repo: string },
  number: number,
  title: string,
  state: VisitedRow["state"],
): void {
  const key = prototypeRowKey(prototypeRepoKey(repo.owner, repo.repo), number);
  if (byKey.has(key)) return;
  const spin = hash(key);
  // Derived from the key so the order never moves between reloads; the
  // fixture selection is forced oldest, to keep it out of the cap.
  const openedAt =
    key === prototypeSelectedRowKey
      ? referenceNow - 400 * dayMs
      : referenceNow - (10 + (spin % 26_000)) * 60_000;
  byKey.set(key, {
    key,
    owner: repo.owner,
    repo: repo.repo,
    number,
    title,
    state,
    insightReady: spin % 3 === 0,
    openedAt,
  });
}

function relativeOpened(openedAt: number): string {
  const minutes = Math.max(1, Math.round((referenceNow - openedAt) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 28) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

function workspaceTitle(workspace: Workspace): string {
  const held = workspace.holdsSelected ? " · holds the open pull request" : "";
  return `${workspace.profile.label} · ${workspace.profile.ghAccount} @ ${workspace.profile.githubHost}${held}`;
}

/** Slack-style tile text: one letter per word, two at most. */
function initials(label: string): string {
  const words = label.split(/[\s_/-]+/u).filter((word) => word.length > 0);
  const heads = words.map((word) => word.charAt(0)).join("");
  const source = heads.length > 1 ? heads : label;
  return source.slice(0, 2).toUpperCase() || "?";
}

/** Repo keys carry `/` and `#`, neither of which is legal raw in a selector. */
function cssEscape(value: string): string {
  return value.replaceAll(/[^\w-]/g, (character) => `\\${character}`);
}

function hash(value: string): number {
  let result = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16_777_619) >>> 0;
  }
  return result;
}
