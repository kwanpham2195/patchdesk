import { useEffect, useMemo, useState } from "react";

import { PatchDiff } from "@pierre/diffs/react";
import type { DiffLineAnnotation } from "@pierre/diffs";
import { ChevronsUpDown, Columns2, FileCode2, Rows3, WrapText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  diffThemeFor,
  loadDiffThemePreferences,
  parseDiffThemePreferences,
  type DiffThemePreferences,
} from "@/diff-theme-preferences";
import type { ResolvedAppearance } from "@/appearance-preferences";
import type { ReviewViewPreferences } from "@/review-view-preferences";
import type { ReviewInlineAnnotation } from "./review-diff-view";
import { filterNarrativePatchToHunks } from "../../../domain/narrative-walkthrough";

export type NarrativeHunk = {
  readonly id: string;
  readonly path: string;
  readonly header: string;
  readonly raw: string;
  readonly filePrefix?: string | undefined;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
};

function fallbackFilePrefix(hunk: NarrativeHunk): string {
  const path = hunk.path;
  const oldPath = hunk.oldLines === 0 ? "/dev/null" : `a/${path}`;
  const newPath = hunk.newLines === 0 ? "/dev/null" : `b/${path}`;
  return `diff --git ${oldPath} ${newPath}\n--- ${oldPath}\n+++ ${newPath}`;
}

function buildFallbackPatch(hunks: ReadonlyArray<NarrativeHunk>): string {
  return [...hunks]
    .sort((left, right) => {
      const leftNumber = Number(left.id.slice(1));
      const rightNumber = Number(right.id.slice(1));
      return leftNumber - rightNumber;
    })
    .map((hunk) => `${hunk.filePrefix ?? fallbackFilePrefix(hunk)}\n${hunk.raw}`)
    .join("\n");
}

/** Renders a bounded, reparsed section of the immutable walkthrough patch. */
export function NarrativeWalkthroughDiff({
  blockId,
  patch,
  hunkIds,
  hunks,
  allHunks,
  preferences,
  annotations = [],
}: {
  readonly blockId: string;
  readonly patch?: string;
  readonly hunkIds: ReadonlyArray<string>;
  readonly hunks: ReadonlyArray<NarrativeHunk>;
  readonly allHunks?: ReadonlyArray<NarrativeHunk>;
  readonly preferences?: ReviewViewPreferences;
  readonly annotations?: ReadonlyArray<ReviewInlineAnnotation>;
}): React.JSX.Element {
  const sourcePatch = useMemo(
    () => patch ?? buildFallbackPatch(allHunks ?? hunks),
    [allHunks, hunks, patch],
  );
  const filteredPatch = useMemo(
    () => filterNarrativePatchToHunks(sourcePatch, hunkIds),
    [hunkIds, sourcePatch],
  );
  const [appearance, setAppearance] = useState<ResolvedAppearance>(() =>
    document.documentElement.dataset.appearance === "light" ? "light" : "dark",
  );
  const [themePreferences, setThemePreferences] = useState<DiffThemePreferences>(() => loadDiffThemePreferences());
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">(preferences?.diffStyle ?? "unified");
  const [overflow, setOverflow] = useState<"scroll" | "wrap">(preferences?.overflow ?? "scroll");
  const [expandUnchanged, setExpandUnchanged] = useState(false);

  useEffect(() => {
    const onAppearance = (event: Event): void => {
      const value = (event as CustomEvent<ResolvedAppearance>).detail;
      if (value === "light" || value === "dark") setAppearance(value);
    };
    const onTheme = (event: Event): void => {
      setThemePreferences(parseDiffThemePreferences((event as CustomEvent<unknown>).detail));
    };
    window.addEventListener("patchdesk:appearance", onAppearance);
    window.addEventListener("patchdesk:diff-theme", onTheme);
    return () => {
      window.removeEventListener("patchdesk:appearance", onAppearance);
      window.removeEventListener("patchdesk:diff-theme", onTheme);
    };
  }, []);

  const lineAnnotations = useMemo<ReadonlyArray<DiffLineAnnotation<ReviewInlineAnnotation>>>(
    () =>
      annotations
        .filter((annotation) =>
          hunks.some((hunk) => {
            if (hunk.path !== annotation.path) return false;
            const start = annotation.side === "new" ? hunk.newStart : hunk.oldStart;
            const count = annotation.side === "new" ? hunk.newLines : hunk.oldLines;
            return count > 0 && annotation.start >= start && annotation.start < start + count;
          }),
        )
        .map((annotation) => ({
          side: annotation.side === "new" ? "additions" : "deletions",
          lineNumber: annotation.start,
          metadata: annotation,
        })),
    [annotations, hunks],
  );

  return (
    <div
      data-walkthrough-diff-block={blockId}
      className="overflow-hidden rounded-md border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-2 py-1.5 text-xs">
        <div className="flex min-w-0 items-center gap-1.5">
          <FileCode2 className="size-3.5" />
          <span className="truncate font-mono">
            {hunks.map((hunk) => hunk.path).filter((path, index, paths) => paths.indexOf(path) === index).join(", ")}
          </span>
          <span className="text-muted-foreground">{hunks.length} hunk{hunks.length === 1 ? "" : "s"}</span>
        </div>
        <ButtonGroup className="items-center">
          <Button
            variant={diffStyle === "unified" ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={diffStyle === "unified"}
            onClick={() => setDiffStyle("unified")}
          >
            <Rows3 /> Unified
          </Button>
          <Button
            variant={diffStyle === "split" ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={diffStyle === "split"}
            onClick={() => setDiffStyle("split")}
          >
            <Columns2 /> Split
          </Button>
          <Button
            variant={expandUnchanged ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={expandUnchanged}
            title="Show context already present in this bounded patch"
            onClick={() => setExpandUnchanged((current) => !current)}
          >
            <ChevronsUpDown /> Context
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setOverflow((current) => (current === "wrap" ? "scroll" : "wrap"))}
          >
            <WrapText />
            {overflow === "wrap" ? "Scroll" : "Wrap"}
          </Button>
        </ButtonGroup>
      </div>
      <div className="font-mono text-[12px]">
        {filteredPatch.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">Stored patch unavailable for this section.</p>
        ) : (
          <PatchDiff<ReviewInlineAnnotation>
            patch={filteredPatch}
            disableWorkerPool
            className="visual-diff h-full max-h-[36rem] overflow-auto"
            options={{
              theme: diffThemeFor(themePreferences),
              themeType: appearance,
              disableBackground: false,
              diffStyle,
              overflow,
              hunkSeparators: "line-info",
              expandUnchanged,
              lineDiffType: "word-alt",
              diffIndicators: "bars",
            }}
            lineAnnotations={[...lineAnnotations]}
            renderAnnotation={(annotation) => (
              <div className="border-t bg-muted/50 px-3 py-2 text-xs not-italic">
                <strong>{annotation.metadata.title}</strong>
                <span className="ml-2 text-muted-foreground">{annotation.metadata.explanation}</span>
              </div>
            )}
          />
        )}
      </div>
    </div>
  );
}
