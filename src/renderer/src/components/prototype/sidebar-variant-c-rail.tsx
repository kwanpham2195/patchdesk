// PROTOTYPE — issue #119, throwaway. Do not build on this.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircleCheck,
  CircleDot,
  CircleX,
  Clock3,
  Eye,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  TriangleAlert,
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

/** One repo as the flat list draws it: a pinned header plus its rows. */
type RepoSection = {
  readonly key: string;
  readonly owner: string;
  readonly repo: string;
  readonly data: PrototypeRepoPullRequests;
  readonly shown: ReadonlyArray<PrototypePullRequestRow>;
  readonly hasMore: boolean;
};

type Workspace = {
  readonly profile: Profile;
  readonly sections: ReadonlyArray<RepoSection>;
  readonly awaitingReview: boolean;
  readonly holdsSelected: boolean;
};

/** The repo the fixtures put the selected pull request in. */
const selectedRepoKey = prototypeSelectedRowKey.split("#")[0] ?? "";

export function SidebarVariantCRail(): React.JSX.Element {
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
            (profile.repos ?? []).some(
              (repo) =>
                prototypeRepoKey(repo.owner, repo.repo) === selectedRepoKey,
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
  const rows = useMemo(
    () => navigableKeys(active?.sections ?? []),
    [active?.sections],
  );

  useEffect(() => {
    if (focusKey === undefined) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row-key="${cssEscape(focusKey)}"]`)
      ?.focus();
  }, [focusKey, rows]);

  // Travelling to the workspace that holds the selection has to land on it.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row-key="${cssEscape(selected)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, rows]);

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
      const current = focusKey ?? rows[0];
      if (current !== undefined && !current.endsWith(":more"))
        setSelected(current);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = rows.indexOf(focusKey ?? rows[0] ?? "");
    if (index < 0) return;
    const next =
      event.key === "ArrowDown"
        ? rows[Math.min(index + 1, rows.length - 1)]
        : rows[Math.max(index - 1, 0)];
    setFocusKey(next);
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
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {active?.sections.length ?? 0}
          </span>
        </div>
        <div
          ref={listRef}
          role="listbox"
          onKeyDown={onListKeyDown}
          aria-label="Repositories and pull requests"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {loadFailed ? (
            <p className="px-2.5 py-2 text-[12px] text-muted-foreground">
              Could not read the workspace profiles.
            </p>
          ) : null}
          {active?.sections.map((section) => (
            <div key={section.key}>
              {/* No disclosure control: the header's only job is to pin. */}
              <div className="sticky top-0 z-10 flex min-w-0 items-center gap-1.5 border-b bg-background px-2.5 py-1.5">
                <span
                  className="min-w-0 flex-1 truncate text-[11.5px] font-semibold"
                  title={section.key}
                >
                  <span className="text-muted-foreground">
                    {section.owner}/
                  </span>
                  {section.repo}
                </span>
                {section.data.loadError === undefined ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    {section.data.totalCount ?? "—"}
                  </span>
                ) : (
                  <TriangleAlert
                    className="size-3.5 shrink-0 text-status-warning"
                    aria-label="Repository failed to load"
                  />
                )}
              </div>
              <SectionBody
                section={section}
                selected={selected}
                focusKey={focusKey ?? rows[0]}
                onFocusRow={setFocusKey}
                onSelectRow={setSelected}
              />
            </div>
          ))}
        </div>
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
        {workspace.awaitingReview ? (
          <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-status-warning ring-2 ring-background" />
        ) : null}
      </button>
    </div>
  );
}

function SectionBody({
  section,
  selected,
  focusKey,
  onFocusRow,
  onSelectRow,
}: {
  readonly section: RepoSection;
  readonly selected: string;
  readonly focusKey: string | undefined;
  readonly onFocusRow: (key: string) => void;
  readonly onSelectRow: (key: string) => void;
}): React.JSX.Element {
  if (section.data.loadError !== undefined)
    return <NoteRow text={section.data.loadError} failed />;
  if (section.shown.length === 0)
    return <NoteRow text="No open pull requests" failed={false} />;
  return (
    <>
      {section.shown.map((row) => {
        const key = prototypeRowKey(section.key, row.number);
        return (
          <PullRow
            key={key}
            rowKey={key}
            row={row}
            selected={selected === key}
            focused={focusKey === key}
            onFocusRow={onFocusRow}
            onSelectRow={onSelectRow}
          />
        );
      })}
      {section.hasMore ? (
        <div
          data-row-key={`${section.key}:more`}
          role="option"
          aria-selected={false}
          tabIndex={focusKey === `${section.key}:more` ? 0 : -1}
          onClick={() => onFocusRow(`${section.key}:more`)}
          className="flex h-7 items-center pr-2 pl-7 text-[12px] text-primary outline-none hover:bg-muted/50 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {section.data.totalCount === undefined
            ? "View all"
            : `View all ${section.data.totalCount}`}
        </div>
      ) : null}
    </>
  );
}

function PullRow({
  rowKey,
  row,
  selected,
  focused,
  onFocusRow,
  onSelectRow,
}: {
  readonly rowKey: string;
  readonly row: PrototypePullRequestRow;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly onFocusRow: (key: string) => void;
  readonly onSelectRow: (key: string) => void;
}): React.JSX.Element {
  return (
    <div
      data-row-key={rowKey}
      role="option"
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      onClick={() => {
        onFocusRow(rowKey);
        onSelectRow(rowKey);
      }}
      className={cn(
        "relative flex h-7 min-w-0 items-center gap-1.5 pr-2 pl-2.5 outline-none",
        "hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        selected && "bg-primary/10",
      )}
    >
      {selected ? (
        <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />
      ) : null}
      <PullIcon row={row} />
      <span
        className="min-w-0 flex-1 truncate text-[12.5px]"
        title={`#${row.number} ${row.title} — ${row.author}`}
      >
        <span className="text-muted-foreground tabular-nums">
          #{row.number}
        </span>{" "}
        {row.title}
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        {row.reviewRequestedForMe ? (
          <Eye
            className="size-3.5 text-primary"
            aria-label="Awaiting your review"
          />
        ) : null}
        <ChecksIcon row={row} />
      </span>
    </div>
  );
}

function NoteRow({
  text,
  failed,
}: {
  readonly text: string;
  readonly failed: boolean;
}): React.JSX.Element {
  return (
    <p
      className={cn(
        "truncate py-1 pr-2 pl-7 text-[12px]",
        failed ? "text-destructive" : "text-muted-foreground",
      )}
      title={text}
    >
      {text}
    </p>
  );
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

const checkFaces = {
  SUCCESS: [CircleCheck, "text-status-success", "Checks passing"],
  FAILURE: [CircleX, "text-destructive", "Checks failing"],
  ERROR: [CircleX, "text-destructive", "Checks failing"],
  PENDING: [Clock3, "text-status-warning", "Checks running"],
  none: [CircleDot, "text-muted-foreground/50", "No checks"],
} as const;

function ChecksIcon({
  row,
}: {
  readonly row: PrototypePullRequestRow;
}): React.JSX.Element {
  const [Icon, tone, label] = checkFaces[row.checks ?? "none"];
  return <Icon className={cn("size-3.5", tone)} aria-label={label} />;
}

function toWorkspace(profile: Profile, selected: string): Workspace {
  const sections = (profile.repos ?? []).map((repo) => {
    const key = prototypeRepoKey(repo.owner, repo.repo);
    const data = prototypePullRequests(key);
    const shown = data.rows.slice(0, prototypeVisibleRowLimit);
    return {
      key,
      owner: repo.owner,
      repo: repo.repo,
      data,
      shown,
      hasMore:
        shown.length > 0 &&
        (data.totalCount === undefined || data.totalCount > shown.length),
    } satisfies RepoSection;
  });
  return {
    profile,
    sections,
    awaitingReview: sections.some((section) =>
      section.data.rows.some((row) => row.reviewRequestedForMe),
    ),
    holdsSelected: sections.some((section) =>
      section.shown.some(
        (row) => prototypeRowKey(section.key, row.number) === selected,
      ),
    ),
  };
}

function navigableKeys(
  sections: ReadonlyArray<RepoSection>,
): ReadonlyArray<string> {
  const keys: Array<string> = [];
  for (const section of sections) {
    for (const row of section.shown)
      keys.push(prototypeRowKey(section.key, row.number));
    if (section.hasMore) keys.push(`${section.key}:more`);
  }
  return keys;
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
