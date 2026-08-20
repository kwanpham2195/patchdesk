import { useMemo } from "react";
import { PanelLeftClose } from "lucide-react";

import { parseUnifiedPatch } from "../../../domain/patch";
import {
  projectConversationThreadRows,
  type ConversationThreadRowState,
} from "../conversation-thread-entries";
import type { WorkbenchResponse } from "../renderer-contracts";
import { parseReviewDiff } from "../review-diff-data";
import { cn } from "@/lib/utils";
import type { ReviewInlineAnnotation } from "./review-diff-view";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { PierreFileTree, type PierreFileTreeItem } from "./pierre-file-tree";

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

export type ReviewNavigatorSection = "files" | "commits" | "threads";

type ReviewNavigatorProps = {
  readonly patch: string;
  readonly commits: WorkbenchResponse["commits"];
  readonly conversationThreadEntries: ReadonlyArray<ReviewInlineAnnotation>;
  readonly section: ReviewNavigatorSection;
  readonly selectedPath?: string;
  readonly activePath?: string;
  readonly selectedCommitSha?: string;
  readonly onSectionChange: (section: ReviewNavigatorSection) => void;
  readonly onFileSelect: (path: string) => void;
  readonly onCommitSelect: (sha: string) => void;
  readonly onThreadSelect: (path: string) => void;
  readonly onCollapse?: () => void;
};

/** The review navigator owns browsing and commit selection. */
export function ReviewNavigator({
  patch,
  commits,
  conversationThreadEntries,
  section,
  selectedPath,
  activePath,
  selectedCommitSha,
  onSectionChange,
  onFileSelect,
  onCommitSelect,
  onThreadSelect,
  onCollapse,
}: ReviewNavigatorProps): React.JSX.Element {
  const parsed = useMemo(() => {
    const files = parseUnifiedPatch(patch);
    const diff = parseReviewDiff(patch);
    const items: ReadonlyArray<PierreFileTreeItem> = files.map((file) => ({
      path: file.newPath,
      stats: diff.statsByPath.get(file.newPath) ?? {
        path: file.newPath,
        additions: 0,
        deletions: 0,
      },
      gitStatus: diff.gitStatusByPath.get(file.newPath),
    }));
    return { files: items, firstPath: items[0]?.path };
  }, [patch]);
  const threadRows = useMemo(
    () =>
      projectConversationThreadRows(
        conversationThreadEntries,
        parsed.files.map((file) => file.path),
      ),
    [conversationThreadEntries, parsed.files],
  );

  const fileTreeActivePath = activePath ?? selectedPath ?? parsed.firstPath;
  return (
    <aside
      aria-label="Review navigation"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-r bg-card"
    >
      <Tabs
        value={section}
        onValueChange={(value) =>
          // SAFETY: every TabsTrigger below is keyed by a ReviewNavigatorSection
          // literal ("files" | "commits" | "threads"), so Base UI's reported
          // value can only ever be one of those.
          onSectionChange(value as ReviewNavigatorSection)
        }
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex items-center justify-between gap-2 px-3 pt-3">
          <TabsList
            variant="line"
            aria-label="Review navigator"
            className="min-w-0 shrink-0"
          >
            <TabsTrigger value="files">Browse</TabsTrigger>
            <TabsTrigger value="commits">Commits</TabsTrigger>
            <TabsTrigger value="threads" className="gap-1.5">
              Threads
              <Badge
                variant="secondary"
                className="h-4 min-w-4 px-1 text-[10px]"
              >
                {threadRows.length}
              </Badge>
            </TabsTrigger>
          </TabsList>
          {onCollapse === undefined ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={onCollapse}
                    aria-label="Hide review navigator"
                  />
                }
              >
                <PanelLeftClose />
              </TooltipTrigger>
              <TooltipContent>Hide review navigator</TooltipContent>
            </Tooltip>
          )}
        </div>
        <TabsContent
          value="files"
          className="min-h-0 flex-1 overflow-hidden p-3"
          keepMounted
        >
          {parsed.files.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">
              No changed files.
            </p>
          ) : (
            <PierreFileTree
              files={parsed.files}
              {...(selectedPath === undefined ? {} : { selectedPath })}
              {...(fileTreeActivePath === undefined
                ? {}
                : { activePath: fileTreeActivePath })}
              onSelect={onFileSelect}
            />
          )}
        </TabsContent>
        <TabsContent
          value="commits"
          className="min-h-0 flex-1 overflow-auto p-3"
          keepMounted
        >
          <div className="flex flex-col gap-1" aria-label="Review commits">
            {commits.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">
                No commits recorded.
              </p>
            ) : (
              commits.map((commit) => (
                <button
                  key={commit.sha}
                  type="button"
                  aria-pressed={selectedCommitSha === commit.sha}
                  className="flex flex-col items-start gap-1 rounded-md px-2 py-2 text-left text-sm hover:bg-accent aria-pressed:bg-accent"
                  onClick={() => onCommitSelect(commit.sha)}
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="truncate font-medium">
                      {commit.message.split("\n", 1)[0]}
                    </span>
                    {commit.isHead ? (
                      <Badge variant="secondary">HEAD</Badge>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {commit.author} · {commit.sha.slice(0, 8)} ·{" "}
                    {formatCommitDate(commit.authoredAt)}
                  </span>
                </button>
              ))
            )}
          </div>
        </TabsContent>
        <TabsContent
          value="threads"
          className="min-h-0 flex-1 overflow-auto p-3"
          keepMounted
        >
          <div
            className="flex flex-col gap-1"
            aria-label="Conversation threads"
          >
            {threadRows.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">
                No Conversation threads on this revision.
              </p>
            ) : (
              threadRows.map((row) => {
                const badge = threadRowStateBadge(row.state);
                return (
                  <button
                    key={row.id}
                    type="button"
                    aria-pressed={selectedPath === row.path}
                    className="flex flex-col items-start gap-1 rounded-md px-2 py-2 text-left text-sm hover:bg-accent aria-pressed:bg-accent"
                    onClick={() => onThreadSelect(row.path)}
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="truncate font-medium">{row.author}</span>
                      <Badge
                        variant={badge.variant}
                        className={cn("shrink-0", badge.className)}
                      >
                        {badge.label}
                      </Badge>
                    </span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {row.preview.length === 0 ? "(no body)" : row.preview}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {row.path}:
                      {row.start === row.end
                        ? row.start
                        : `${row.start}-${row.end}`}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function formatCommitDate(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  const seconds = Math.round((timestamp - Date.now()) / 1_000);
  const units: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, divisor] of units)
    if (Math.abs(seconds) >= divisor)
      return relativeTimeFormatter.format(Math.round(seconds / divisor), unit);
  return relativeTimeFormatter.format(seconds, "second");
}

type ThreadStateBadge = {
  readonly label: string;
  readonly variant: "default" | "secondary" | "outline";
  readonly className?: string;
};

/**
 * Badge look for a Threads row's state. Published open, published resolved,
 * and pending must read as visually distinct at a glance: open is the
 * filled primary badge, resolved a muted secondary badge, and pending an
 * outline badge in a warm accent color so a not-yet-submitted reply never
 * reads as an already-published thread.
 */
function threadRowStateBadge(
  state: ConversationThreadRowState,
): ThreadStateBadge {
  switch (state) {
    case "open":
      return { label: "Open", variant: "default" };
    case "resolved":
      return { label: "Resolved", variant: "secondary" };
    case "outdated":
      return { label: "Outdated", variant: "outline" };
    case "unknown":
      return { label: "Unknown", variant: "outline" };
    case "pending":
      return {
        label: "Pending",
        variant: "outline",
        className: "border-amber-500/40 text-amber-600 dark:text-amber-400",
      };
  }
}
