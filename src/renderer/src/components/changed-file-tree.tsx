import { useEffect, useRef, useState } from "react";
import { FileCode2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { FileChangeStats } from "@/review-diff-data";

export type ChangedFileTreeItem = {
  readonly path: string;
  readonly stats: FileChangeStats;
};

/** One visible, keyboard-complete tree owns changed-file selection. */
export function ChangedFileTree({
  files,
  selectedPath,
  onSelect,
  maxVisibleItems,
}: {
  readonly files: ReadonlyArray<ChangedFileTreeItem>;
  readonly selectedPath?: string;
  readonly onSelect: (path: string) => void;
  /** Keeps exceptionally large unfiltered navigators responsive. */
  readonly maxVisibleItems?: number;
}): React.JSX.Element {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const typeahead = useRef("");
  const typeaheadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const visibleFiles =
    maxVisibleItems === undefined ? files : files.slice(0, maxVisibleItems);

  useEffect(() => {
    setFocusedIndex((current) => Math.min(current, Math.max(0, visibleFiles.length - 1)));
  }, [visibleFiles.length]);

  const move = (index: number): void => {
    const bounded = Math.max(0, Math.min(visibleFiles.length - 1, index));
    setFocusedIndex(bounded);
    buttons.current[bounded]?.focus();
  };

  return (
    <div>
      <p className="mb-2 px-2 text-xs text-muted-foreground" role="status">{files.length} changed {files.length === 1 ? "file" : "files"}</p>
      {visibleFiles.length < files.length ? (
        <p className="mb-2 px-2 text-xs text-muted-foreground">
          Showing the first {visibleFiles.length}. Filter to locate the rest.
        </p>
      ) : null}
      <div role="tree" aria-label="Changed files" className="space-y-0.5">
        {visibleFiles.map(({ path, stats }, index) => {
          const descriptionId = `changed-file-stats-${index}`;
          return (
            <Button
              key={path}
              ref={(node) => { buttons.current[index] = node; }}
              role="treeitem"
              variant="ghost"
              tabIndex={focusedIndex === index ? 0 : -1}
              aria-label={path}
              aria-describedby={descriptionId}
              aria-selected={selectedPath === path}
              className={cn("h-7 min-h-7 w-full min-w-0 justify-start gap-1 px-1.5 py-1 text-left text-xs font-normal", selectedPath === path && "bg-accent text-accent-foreground")}
              onClick={() => { setFocusedIndex(index); onSelect(path); }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") { event.preventDefault(); move(index + 1); return; }
                if (event.key === "ArrowUp") { event.preventDefault(); move(index - 1); return; }
                if (event.key === "Home") { event.preventDefault(); move(0); return; }
                if (event.key === "End") { event.preventDefault(); move(files.length - 1); return; }
                if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
                clearTimeout(typeaheadTimer.current);
                typeahead.current += event.key.toLowerCase();
                const match = visibleFiles.findIndex((candidate) => candidate.path.toLowerCase().startsWith(typeahead.current));
                if (match >= 0) move(match);
                typeaheadTimer.current = setTimeout(() => { typeahead.current = ""; }, 600);
              }}
            >
              <FileCode2 className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate" title={path}>{path}</span>
              <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums" aria-hidden="true" data-file-change-stats data-additions={stats.additions} data-deletions={stats.deletions}>
                <span className="text-emerald-700 dark:text-emerald-400">+{stats.additions}</span>
                <span className="text-rose-700 dark:text-rose-400">-{stats.deletions}</span>
              </span>
              <span id={descriptionId} className="sr-only">{stats.additions} additions, {stats.deletions} deletions</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
