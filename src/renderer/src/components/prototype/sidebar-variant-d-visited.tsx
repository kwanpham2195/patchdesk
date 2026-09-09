// PROTOTYPE — issue #119, throwaway. Do not build on this.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  RefreshCw,
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

/** One local Review record as the recents list draws it. Everything here is
 * readable off disk: no GitHub call stands behind a single field. */
type VisitedRow = {
  readonly key: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "merged" | "closed";
  /** The real record's `freshness` is `RevisionChanged`. */
  readonly movedOn: boolean;
  readonly insightReady: boolean;
  readonly openedAt: number;
};

type Workspace = {
  readonly profile: Profile;
  readonly rows: ReadonlyArray<VisitedRow>;
  readonly holdsSelected: boolean;
};

/** What the sidebar keeps on screen for one workspace: the cap, plus the
 * selection when the cap pushed it off the end. */
type Recents = {
  readonly shown: ReadonlyArray<VisitedRow>;
  readonly pinned: VisitedRow | undefined;
  readonly total: number;
};

/** The most recently opened reviews a workspace shows before the cap bites. */
const recentLimit = 20;

/** How many landed reviews sit behind a repo's currently open ones. A visited
 * archive is deeper than the open list, because records outlive the PR. */
const archiveDepth = 18;

/** Fixed "now" so a row's relative time is the same on every reload. */
const referenceNow = Date.UTC(2026, 8, 9, 12);

const archivedTitles = [
  "Retire the legacy session lock file",
  "Split the inbox query off the workspace boot path",
  "Teach the merge queue to report its own base",
  "Stop double-encoding the review artifact path",
  "Trim the avatar cache on profile removal",
  "Backfill the schemaVersion on pre-v2 reviews",
  "Redraw the empty state for a repo you never opened",
];

export function SidebarVariantDVisited(): React.JSX.Element {
  const [profiles, setProfiles] = useState<ReadonlyArray<Profile>>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [activeProfileId, setActiveProfileId] = useState<string>();
  const [selected, setSelected] = useState(prototypeSelectedRowKey);
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  const railRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const payload = await api("/v1/profiles");
        const loaded = Array.isArray(payload) ? payload.filter(isProfile) : [];
        if (live) {
          setProfiles(loaded);
          const home = loaded.find((profile) =>
            visitedRows(profile).some(
              (row) => row.key === prototypeSelectedRowKey,
            ),
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
    () => profiles.map((profile) => toWorkspace(profile, selected)),
    [profiles, selected],
  );
  const active =
    workspaces.find((workspace) => workspace.profile.id === activeProfileId) ??
    workspaces[0];
  const recents = useMemo(
    () => toRecents(active?.rows ?? [], selected),
    [active?.rows, selected],
  );
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

  return (
    <aside className="mr-1 flex h-full w-[300px] min-w-0 shrink-0 overflow-hidden rounded-t-lg border border-b-0 bg-background">
      <div
        ref={railRef}
        role="tablist"
        aria-orientation="vertical"
        aria-label="Workspaces"
        onKeyDown={onRailKeyDown}
        className="flex w-12 shrink-0 flex-col items-center gap-1.5 overflow-y-auto border-r bg-muted/30 py-2"
      >
        {workspaces.map((workspace) => (
          <RailTile
            key={workspace.profile.id}
            workspace={workspace}
            active={workspace.profile.id === active?.profile.id}
            onSelect={() => travelTo(workspace.profile.id)}
          />
        ))}
      </div>
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
        <div
          ref={listRef}
          role="listbox"
          onKeyDown={onListKeyDown}
          aria-label="Pull requests you have opened"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {loadFailed ? (
            <p className="px-2.5 py-2 text-[12px] text-muted-foreground">
              Could not read the workspace profiles.
            </p>
          ) : null}
          {recents.total === 0 && !loadFailed ? (
            <p className="px-2.5 py-2 text-[12px] text-muted-foreground">
              You have not opened a pull request in this workspace yet.
            </p>
          ) : null}
          {recents.shown.map((row) => (
            <VisitedRowView
              key={row.key}
              row={row}
              selected={selected === row.key}
              focused={(focusKey ?? keys[0]) === row.key}
              onFocusRow={setFocusKey}
              onSelectRow={setSelected}
            />
          ))}
          {recents.pinned === undefined ? null : (
            // Selection outlives the cap: an older open PR stays reachable.
            <div className="border-t">
              <VisitedRowView
                row={recents.pinned}
                selected={selected === recents.pinned.key}
                focused={(focusKey ?? keys[0]) === recents.pinned.key}
                onFocusRow={setFocusKey}
                onSelectRow={setSelected}
              />
            </div>
          )}
        </div>
        {recents.total > recentLimit ? (
          <p className="border-t px-2.5 py-1.5 text-[11px] text-muted-foreground tabular-nums">
            {recentLimit} of {recents.total} recent
          </p>
        ) : null}
      </div>
    </aside>
  );
}

function RailTile({
  workspace,
  active,
  onSelect,
}: {
  readonly workspace: Workspace;
  readonly active: boolean;
  readonly onSelect: () => void;
}): React.JSX.Element {
  const marked = workspace.holdsSelected && !active;
  return (
    <div className="relative flex w-full shrink-0 justify-center">
      {active ? (
        <span className="absolute top-1 left-0 h-7 w-0.5 rounded-r bg-primary" />
      ) : null}
      <button
        type="button"
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        title={workspaceTitle(workspace)}
        onClick={onSelect}
        className={cn(
          "relative flex size-9 items-center justify-center rounded-lg text-[11px] font-semibold tracking-tight outline-none",
          active
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground",
          marked && "ring-1 ring-primary/70",
          "focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {initials(workspace.profile.label)}
      </button>
    </div>
  );
}

function VisitedRowView({
  row,
  selected,
  focused,
  onFocusRow,
  onSelectRow,
}: {
  readonly row: VisitedRow;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly onFocusRow: (key: string) => void;
  readonly onSelectRow: (key: string) => void;
}): React.JSX.Element {
  return (
    <div
      data-row-key={row.key}
      role="option"
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      onClick={() => {
        onFocusRow(row.key);
        onSelectRow(row.key);
      }}
      className={cn(
        "relative flex min-w-0 items-start gap-1.5 py-1 pr-2 pl-2.5 outline-none",
        "hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        selected && "bg-primary/10",
      )}
    >
      {selected ? (
        <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />
      ) : null}
      <StateIcon state={row.state} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 truncate text-[12.5px]" title={row.title}>
          {row.title}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate">
            {row.owner}/{row.repo}
          </span>
          <span className="shrink-0 tabular-nums">#{row.number}</span>
          <span className="shrink-0">·</span>
          <span className="shrink-0 tabular-nums">
            {relativeOpened(row.openedAt)}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {row.movedOn ? (
              <RefreshCw
                className="size-3 text-status-warning"
                aria-label="GitHub moved on since you last looked"
              />
            ) : null}
            {row.insightReady ? (
              <span
                className="flex items-center gap-0.5 text-[10px] text-primary"
                title="Insight ready"
              >
                <Sparkles className="size-3" aria-hidden="true" />
                Insight
              </span>
            ) : null}
          </span>
        </span>
      </span>
    </div>
  );
}

const stateFaces = {
  merged: [GitMerge, "text-status-info", "Merged"],
  closed: [GitPullRequestClosed, "text-destructive", "Closed"],
  open: [GitPullRequest, "text-status-success", "Open"],
} as const;

function StateIcon({
  state,
}: {
  readonly state: VisitedRow["state"];
}): React.JSX.Element {
  const [Icon, tone, label] = stateFaces[state];
  return (
    <Icon className={cn("mt-0.5 size-3.5 shrink-0", tone)} aria-label={label} />
  );
}

function toWorkspace(profile: Profile, selected: string): Workspace {
  const rows = visitedRows(profile);
  return {
    profile,
    rows,
    holdsSelected: rows.some((row) => row.key === selected),
  };
}

function toRecents(rows: ReadonlyArray<VisitedRow>, selected: string): Recents {
  const shown = rows.slice(0, recentLimit);
  const cut = rows.slice(recentLimit).find((row) => row.key === selected);
  return { shown, pinned: cut, total: rows.length };
}

/** Every review this workspace has a local record for, newest visit first. */
function visitedRows(profile: Profile): ReadonlyArray<VisitedRow> {
  const byKey = new Map<string, VisitedRow>();
  for (const repo of profile.repos ?? []) {
    const repoKey = prototypeRepoKey(repo.owner, repo.repo);
    for (const row of prototypePullRequests(repoKey).rows)
      addRow(
        byKey,
        repo.owner,
        repo.repo,
        row.number,
        row.title,
        row.merged ? "merged" : "open",
      );
    for (let index = 0; index < archiveDepth; index += 1) {
      const spin = hash(`${repoKey}:archive:${index}`);
      const title = archivedTitles[spin % archivedTitles.length] ?? "Untitled";
      const landed = spin % 5 === 0 ? "closed" : "merged";
      addRow(
        byKey,
        repo.owner,
        repo.repo,
        900 + (spin % 900),
        title,
        spin % 7 === 0 ? "open" : landed,
      );
    }
  }
  return [...byKey.values()].sort(
    (left, right) => right.openedAt - left.openedAt,
  );
}

function addRow(
  byKey: Map<string, VisitedRow>,
  owner: string,
  repo: string,
  number: number,
  title: string,
  state: VisitedRow["state"],
): void {
  const key = prototypeRowKey(prototypeRepoKey(owner, repo), number);
  if (byKey.has(key)) return;
  const spin = hash(key);
  byKey.set(key, {
    key,
    owner,
    repo,
    number,
    title,
    state,
    movedOn: spin % 5 === 0,
    insightReady: spin % 3 === 0,
    openedAt: openedAtFor(key, spin),
  });
}

/** Derived from the row key so the order never moves between reloads. The
 * fixture selection is forced oldest, to keep the out-of-cap case on screen. */
function openedAtFor(key: string, spin: number): number {
  if (key === prototypeSelectedRowKey)
    return referenceNow - 400 * 24 * 3_600_000;
  return referenceNow - (10 + (spin % 26_000)) * 60_000;
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
  const suffix = workspace.holdsSelected
    ? " · holds the open pull request"
    : "";
  return `${workspace.profile.label} · ${workspace.profile.ghAccount} @ ${workspace.profile.githubHost}${suffix}`;
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
