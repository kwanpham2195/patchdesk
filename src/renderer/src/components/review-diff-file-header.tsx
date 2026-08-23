import {
  Check,
  ChevronDown,
  FileCode2,
  FileMinus2,
  FilePlus2,
  FileSymlink,
} from "lucide-react";

import type { FileChangeStats } from "@/review-diff-data";
import type { FileDiffMetadata } from "@pierre/diffs";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function FileChangeCounts({
  stats,
}: {
  readonly stats: FileChangeStats;
}): React.JSX.Element {
  return (
    <span
      className="ml-auto inline-flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums"
      data-file-header-change-stats
      data-additions={stats.additions}
      data-deletions={stats.deletions}
      aria-label={`${stats.additions} additions, ${stats.deletions} deletions`}
    >
      <span className="text-status-success">+{stats.additions}</span>
      <span className="text-destructive">-{stats.deletions}</span>
    </span>
  );
}

type FileChangeType = FileDiffMetadata["type"];

// Icon + tint per Pierre change type, so a renamed/added/deleted file reads
// at a glance without opening its diff. A switch (rather than a lookup
// object) keeps the return type inferred instead of widened to a dictionary.
function fileChangeTypeIcon(type: FileChangeType) {
  switch (type) {
    case "new":
      return {
        Icon: FilePlus2,
        className: "text-status-success",
      };
    case "deleted":
      return {
        Icon: FileMinus2,
        className: "text-destructive",
      };
    case "rename-pure":
    case "rename-changed":
      return {
        Icon: FileSymlink,
        className: "text-status-info",
      };
    case "change":
      return {
        Icon: FileCode2,
        className: "text-muted-foreground",
      };
  }
}

// Badge label per change type; `change` (the common case) returns undefined
// so the header stays quiet for ordinary edits.
function fileChangeTypeBadgeLabel(type: FileChangeType) {
  switch (type) {
    case "new":
      return "New";
    case "deleted":
      return "Deleted";
    case "rename-pure":
    case "rename-changed":
      return "Renamed";
    case "change":
      return undefined;
  }
}

/** Splits a path into its directory prefix (including the trailing slash)
 * and basename, so the header can dim the directory while keeping the
 * basename prominent. A path with no directory returns an empty prefix. */
function splitFileHeaderPath(path: string) {
  const slashIndex = path.lastIndexOf("/");
  if (slashIndex === -1) return { dirPrefix: "", baseName: path };
  return {
    dirPrefix: path.slice(0, slashIndex + 1),
    baseName: path.slice(slashIndex + 1),
  };
}

/** Toggles the collapsed/viewed state for a file header; collapsed and
 * viewed are the same boolean in this app, so both the chevron and the
 * Viewed pill drive this one callback. */
type FileHeaderToggle = {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
};

export function FileHeaderRow({
  file,
  stats,
  toggle,
}: {
  readonly file: Pick<FileDiffMetadata, "name" | "prevName" | "type">;
  readonly stats: React.JSX.Element;
  readonly toggle?: FileHeaderToggle;
}): React.JSX.Element {
  const path = file.name;
  const { Icon, className: iconClassName } = fileChangeTypeIcon(file.type);
  const badgeLabel = fileChangeTypeBadgeLabel(file.type);
  const { dirPrefix, baseName } = splitFileHeaderPath(path);
  const title =
    file.prevName !== undefined ? `${file.prevName} → ${path}` : path;
  return (
    <div
      className="flex min-w-0 items-center gap-2 px-3 py-2 text-sm"
      data-review-diff-file-header={path}
    >
      {toggle !== undefined ? (
        <button
          type="button"
          aria-expanded={!toggle.collapsed}
          aria-label={
            toggle.collapsed ? `Expand file ${path}` : `Collapse file ${path}`
          }
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          onClick={toggle.onToggle}
        >
          <ChevronDown
            className={cn(
              "size-4 transition-transform",
              toggle.collapsed && "-rotate-90",
            )}
          />
        </button>
      ) : null}
      <Icon
        className={cn("size-4 shrink-0", iconClassName)}
        aria-hidden="true"
      />
      <span className="min-w-0 truncate" title={title}>
        {dirPrefix.length > 0 ? (
          <span className="text-muted-foreground">{dirPrefix}</span>
        ) : null}
        <span className="font-medium text-foreground">{baseName}</span>
      </span>
      {badgeLabel !== undefined ? (
        <Badge
          variant="outline"
          className="h-5 shrink-0 px-1.5 text-[10px] font-medium uppercase tracking-wide"
        >
          {badgeLabel}
        </Badge>
      ) : null}
      {stats}
      {toggle !== undefined ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={toggle.collapsed}
          aria-label={
            toggle.collapsed
              ? `Show file ${path}`
              : `Mark file ${path} as viewed`
          }
          onClick={toggle.onToggle}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors hover:border-primary/60 hover:text-foreground focus-visible:outline",
            toggle.collapsed
              ? "border-primary/60 text-foreground"
              : "border-border/70 text-muted-foreground",
          )}
        >
          <span className="inline-flex size-3.5 items-center justify-center rounded-[4px] border border-current">
            {toggle.collapsed ? <Check className="size-2.5" /> : null}
          </span>
          Viewed
        </button>
      ) : null}
    </div>
  );
}
