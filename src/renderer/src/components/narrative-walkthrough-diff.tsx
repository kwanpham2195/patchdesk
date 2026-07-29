import { useEffect, useMemo, useRef, useState } from "react";

import { PatchDiff } from "@pierre/diffs/react";
import { Columns2, FileCode2, Rows3, WrapText } from "lucide-react";

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
import { filterNarrativePatchToHunks } from "../../../domain/narrative-walkthrough";

export type NarrativeHunk = {
  readonly id: string;
  readonly path: string;
  readonly header: string;
  readonly raw: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
};

const PATCH_PREFIX = "diff --git a/__walkthrough__.ts b/__walkthrough__.ts\n--- a/__walkthrough__.ts\n+++ b/__walkthrough__.ts\n";

/**
 * Renders one normalized hunk through Pierre, filtering the immutable raw patch to
 * only this hunk's aliases. Pierre is patch/file oriented, so we synthesize a tiny
 * single-hunk patch per section; the renderer must never mutate the global
 * `ReviewDiffView` state or filter a parsed hunk array.
 */
export function NarrativeWalkthroughDiff({
  blockId,
  hunk,
  preferences,
  onPreferencesChange,
}: {
  readonly blockId: string;
  readonly hunk: NarrativeHunk;
  readonly preferences?: ReviewViewPreferences;
  readonly onPreferencesChange?: (update: Partial<ReviewViewPreferences>) => void;
}): React.JSX.Element {
  const filtered = useMemo(() => {
    const source = PATCH_PREFIX + hunk.raw;
    return filterNarrativePatchToHunks(source, ["h1"]) || source;
  }, [hunk.raw]);
  const [appearance, setAppearance] = useState<ResolvedAppearance>(() =>
    document.documentElement.dataset.appearance === "light" ? "light" : "dark",
  );
  const [themePreferences, setThemePreferences] = useState<DiffThemePreferences>(() => loadDiffThemePreferences());
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">(preferences?.diffStyle ?? "unified");
  const [overflow, setOverflow] = useState<"scroll" | "wrap">(preferences?.overflow ?? "scroll");
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    onPreferencesChange?.({ diffStyle, overflow });
  }, [diffStyle, onPreferencesChange, overflow]);
  useEffect(() => {
    if (preferences === undefined) return;
    setDiffStyle(preferences.diffStyle);
    setOverflow(preferences.overflow);
  }, [preferences?.diffStyle, preferences?.overflow]);
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
  return (
    <div
      data-walkthrough-diff-block={blockId}
      className="overflow-hidden rounded-md border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-2 py-1.5 text-xs">
        <div className="flex items-center gap-1.5">
          <FileCode2 className="size-3.5" />
          <span className="truncate font-mono">{hunk.path}</span>
          <span className="text-muted-foreground">@ {hunk.header}</span>
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
            variant="ghost"
            size="xs"
            onClick={() => setOverflow((current) => (current === "wrap" ? "scroll" : "wrap"))}
          >
            {overflow === "wrap" ? <WrapText /> : <WrapText />}
            {overflow === "wrap" ? "Scroll" : "Wrap"}
          </Button>
        </ButtonGroup>
      </div>
      <div className="font-mono text-[12px]">
        <PatchDiff
          patch={filtered}
          disableWorkerPool
          className="visual-diff h-full max-h-[36rem] overflow-auto"
          options={{
            theme: diffThemeFor(themePreferences),
            themeType: appearance,
            disableBackground: false,
            diffStyle,
            overflow,
            hunkSeparators: "line-info",
            expandUnchanged: false,
            lineDiffType: "word-alt",
            diffIndicators: "bars",
          }}
          renderCustomHeader={() => (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              <code className="font-mono">{hunk.id}</code> · {hunk.path}
            </div>
          )}
        />
      </div>
    </div>
  );
}
