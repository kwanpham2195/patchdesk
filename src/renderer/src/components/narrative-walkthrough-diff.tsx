import { useMemo, useState } from "react";

import type { ReviewViewPreferences } from "@/review-view-preferences";
import {
  DEFAULT_REVIEW_VIEW_PREFERENCES,
} from "@/review-view-preferences";
import { parseReviewDiff } from "@/review-diff-data";
import type { ReviewDiffSourceSession } from "@/hooks/use-review-diff-hydration";
import {
  ReviewDiffView,
  type LocalCommentAuthoring,
  type ReviewInlineAnnotation,
} from "./review-diff-view";
import { filterNarrativePatchToHunks } from "../../../domain/narrative-walkthrough";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

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
  return `diff --git a/${path} b/${path}\n--- ${oldPath}\n+++ ${newPath}`;
}

function orderedHunks(hunks: ReadonlyArray<NarrativeHunk>): ReadonlyArray<NarrativeHunk> {
  return [...hunks].sort((left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)));
}

function buildFallbackPatch(hunks: ReadonlyArray<NarrativeHunk>): string {
  return orderedHunks(hunks)
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
  sourceSession,
  preferences,
  annotations = [],
  localCommentAuthoring,
}: {
  readonly blockId: string;
  readonly patch?: string;
  readonly hunkIds: ReadonlyArray<string>;
  readonly hunks: ReadonlyArray<NarrativeHunk>;
  readonly allHunks?: ReadonlyArray<NarrativeHunk>;
  readonly sourceSession?: ReviewDiffSourceSession;
  readonly preferences?: ReviewViewPreferences;
  readonly annotations?: ReadonlyArray<ReviewInlineAnnotation>;
  readonly localCommentAuthoring?: LocalCommentAuthoring;
}): React.JSX.Element {
  const sourcePatch = useMemo(
    () => patch ?? buildFallbackPatch(allHunks ?? hunks),
    [allHunks, hunks, patch],
  );
  const fallbackHunks = allHunks ?? hunks;
  const filteredPatch = useMemo(() => {
    const requestedIds = patch === undefined
      ? hunkIds.flatMap((id) => {
          const index = orderedHunks(fallbackHunks).findIndex((hunk) => hunk.id === id);
          return index < 0 ? [] : [`h${index + 1}`];
        })
      : hunkIds;
    return filterNarrativePatchToHunks(sourcePatch, requestedIds);
  }, [fallbackHunks, hunkIds, patch, sourcePatch]);
  const parsedDiff = useMemo(() => parseReviewDiff(filteredPatch), [filteredPatch]);
  const [localPreferences, setLocalPreferences] = useState<ReviewViewPreferences>(
    () => preferences ?? DEFAULT_REVIEW_VIEW_PREFERENCES,
  );
  const visibleAnnotations = useMemo(
    () =>
      annotations.filter((annotation) =>
        hunks.some((hunk) => {
          if (hunk.path !== annotation.path) return false;
          const start = annotation.side === "new" ? hunk.newStart : hunk.oldStart;
          const count = annotation.side === "new" ? hunk.newLines : hunk.oldLines;
          return count > 0 && annotation.start >= start && annotation.start < start + count;
        }),
      ),
    [annotations, hunks],
  );
  const selectedPath = hunks[0]?.path;
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentBody, setCommentBody] = useState("");
  const [commentSaving, setCommentSaving] = useState(false);
  const commentHunk = hunks[0];
  const canAddComment = localCommentAuthoring?.enabled === true && commentHunk !== undefined && localCommentAuthoring.canAuthor?.({ path: commentHunk.path, startLine: commentHunk.newStart, line: commentHunk.newStart, side: "new" }) !== false;
  const saveComment = async (): Promise<void> => {
    if (!canAddComment || commentHunk === undefined || commentBody.trim().length === 0 || commentSaving) return;
    setCommentSaving(true);
    try {
      await localCommentAuthoring?.onSave({ path: commentHunk.path, startLine: commentHunk.newStart, line: commentHunk.newStart, side: "new", body: commentBody });
      setCommentBody("");
      setCommentOpen(false);
    } finally {
      setCommentSaving(false);
    }
  };

  return (
    <div
      data-walkthrough-diff-block={blockId}
      className="overflow-hidden rounded-md border bg-card"
    >
      <div className="flex min-w-0 items-center gap-2 border-b bg-muted/40 px-2 py-1.5 text-xs">
        <span className="truncate font-mono">
          {hunks.map((hunk) => hunk.path).filter((path, index, paths) => paths.indexOf(path) === index).join(", ")}
        </span>
        <span className="shrink-0 text-muted-foreground">{hunks.length} hunk{hunks.length === 1 ? "" : "s"}</span>
        {canAddComment ? <Button size="xs" variant="ghost" onClick={() => setCommentOpen(true)}>Add local comment on {commentHunk?.path}</Button> : null}
      </div>
      {commentOpen && canAddComment ? <div className="border-b p-3"><Textarea aria-label="Local comment" value={commentBody} onChange={(event) => setCommentBody(event.target.value)} placeholder="Write a local inline comment" /><div className="mt-2 flex gap-2"><Button size="sm" disabled={commentBody.trim().length === 0 || commentSaving} onClick={() => void saveComment()}>{commentSaving ? "Saving…" : "Save local comment"}</Button><Button size="sm" variant="outline" disabled={commentSaving} onClick={() => { setCommentOpen(false); setCommentBody(""); }}>Cancel</Button></div></div> : null}
      {filteredPatch.length === 0 || parsedDiff.files.length === 0 ? (
        <p className="p-3 text-sm text-muted-foreground">Stored patch unavailable for this section.</p>
      ) : (
        <ReviewDiffView
          patch={filteredPatch}
          parsedFiles={parsedDiff.files}
          fileStatsByPath={parsedDiff.statsByPath}
          {...(selectedPath === undefined ? {} : { selectedPath })}
          annotations={visibleAnnotations}
          preferences={localPreferences}
          collapsedPaths={new Set()}
          onPreferencesChange={(update) => setLocalPreferences((current) => ({ ...current, ...update }))}
          onCollapsedPathsChange={() => undefined}
          {...(sourceSession === undefined ? {} : { sourceSession })}
          virtualized={false}
        />
      )}
    </div>
  );
}
