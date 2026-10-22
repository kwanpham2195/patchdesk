import { useMemo, useState } from "react";

import type { ReviewViewPreferences } from "@/review-view-preferences";
import { loadReviewViewPreferences } from "@/review-view-preferences";
import { parseReviewDiff } from "@/review-diff-data";
import type { ReviewDiffSourceSession } from "@/hooks/use-review-diff-hydration";
import {
  ReviewDiffView,
  type ReviewInlineAnnotation,
} from "./review-diff-view";
import { definedProps } from "#src/domain/defined-props";
import { parseGitHubThreadId } from "#src/domain/ids";
import type { NarrativeHunk as CapturedNarrativeHunk } from "#src/domain/narrative-walkthrough";
import {
  citedHunkRelation,
  type ReadOnlyConversationAnnotation,
} from "#src/renderer/src/inline-conversation-mapping";
import { deriveConversationThreadEntries } from "#src/renderer/src/conversation-thread-entries";
import type { WalkthroughDiffAuthoring } from "./walkthrough-diff-authoring";

const EMPTY_ANNOTATIONS: ReadonlyArray<ReadOnlyConversationAnnotation> = [];

/** One captured hunk crosses the page transport with a string path and its mandatory original file prefix. */
export type NarrativeHunk = Omit<
  CapturedNarrativeHunk,
  "path" | "filePrefix"
> & {
  readonly path: string;
  readonly filePrefix: string;
};

/** Renders a bounded, reparsed section of the immutable walkthrough patch. */
export function NarrativeWalkthroughDiff({
  blockId,
  hunk,
  sourceSession,
  preferences,
  annotations = EMPTY_ANNOTATIONS,
  diffAuthoring,
}: {
  readonly blockId: string;
  readonly hunk: NarrativeHunk;
  readonly sourceSession?: ReviewDiffSourceSession;
  readonly preferences?: ReviewViewPreferences;
  readonly annotations?: ReadonlyArray<ReadOnlyConversationAnnotation>;
  /** Opens the Diff tab's composers on these hunks and shows its notes and pending comments there. */
  readonly diffAuthoring?: WalkthroughDiffAuthoring;
}): React.JSX.Element {
  const filteredPatch = `${hunk.filePrefix}${hunk.filePrefix.endsWith("\n") ? "" : "\n"}${hunk.raw}${hunk.raw.endsWith("\n") ? "" : "\n"}`;
  const parsedDiff = useMemo(
    () => parseReviewDiff(filteredPatch),
    [filteredPatch],
  );
  // Starts from the saved View options; a change made here stays in this block
  // and is never saved (#553).
  const [localPreferences, setLocalPreferences] =
    useState<ReviewViewPreferences>(
      () => preferences ?? loadReviewViewPreferences(),
    );
  const visibleConversation = useMemo(
    () =>
      annotations.flatMap((annotation) => {
        const relation = citedHunkRelation(annotation, hunk);
        return relation === undefined ? [] : [{ annotation, relation }];
      }),
    [annotations, hunk],
  );
  const publishedAnnotations: ReadonlyArray<ReviewInlineAnnotation> = useMemo(
    () =>
      visibleConversation.flatMap(({ annotation }) => {
        const threadId = parseGitHubThreadId(annotation.id);
        if (threadId._tag === "err") return [];
        return [
          {
            id: `walkthrough-conversation:${annotation.id}`,
            path: annotation.path,
            start: annotation.start,
            end: annotation.end,
            side: annotation.side,
            severity: "conversation" as const,
            title: "Conversation",
            explanation: "",
            conversationThread: {
              target: { _tag: "thread" as const, id: threadId.value },
              state: annotation.state,
              ...definedProps({ complete: annotation.complete }),
              comments: annotation.comments,
            },
          },
        ];
      }),
    [visibleConversation],
  );
  const authoredAnnotations = diffAuthoring?.annotations;
  // A pending comment's thread is also published to its author, so it shows once, as the pending card.
  const visibleAnnotations = useMemo(
    () =>
      deriveConversationThreadEntries(
        publishedAnnotations,
        (authoredAnnotations ?? []).filter(
          (annotation) => citedHunkRelation(annotation, hunk) !== undefined,
        ),
      ),
    [authoredAnnotations, hunk, publishedAnnotations],
  );
  const selectedPath = hunk.path;
  // The file header inside the diff names the path, so the toolbar carries only the hunk ids.
  const hunkLabel = `${hunk.id} · 1 hunk`;

  return (
    <div
      role="group"
      tabIndex={-1}
      aria-label={`Walkthrough evidence ${hunk.id} · ${hunk.path}`}
      data-walkthrough-diff-block={blockId}
      data-walkthrough-hunk-id={hunk.id}
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {visibleConversation.some(({ relation }) => relation === "partial") ? (
        <p className="border-b px-2 py-1.5 text-xs text-muted-foreground">
          A conversation thread overlaps this cited range; its GitHub anchor is
          shown without clipping.
        </p>
      ) : null}
      {filteredPatch.length === 0 || parsedDiff.files.length === 0 ? (
        <p className="p-3 text-sm text-muted-foreground">
          Stored patch unavailable for{" "}
          <span className="font-mono">{hunk.path}</span>.
        </p>
      ) : (
        <div
          data-walkthrough-diff-viewport
          className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
        >
          <ReviewDiffView
            patch={filteredPatch}
            parsedFiles={parsedDiff.files}
            fileStatsByPath={parsedDiff.statsByPath}
            {...(selectedPath === undefined ? {} : { selectedPath })}
            annotations={visibleAnnotations}
            preferences={localPreferences}
            collapsedPaths={new Set()}
            onPreferencesChange={(update) =>
              setLocalPreferences((current) => ({ ...current, ...update }))
            }
            onCollapsedPathsChange={() => undefined}
            {...(sourceSession === undefined ? {} : { sourceSession })}
            {...(diffAuthoring === undefined
              ? {}
              : {
                  pendingReviewDrafts: diffAuthoring.pendingReviewDrafts,
                  conversationActions: diffAuthoring.conversationActions,
                  ...definedProps({
                    localCommentAuthoring: diffAuthoring.localCommentAuthoring,
                    pendingReviewComposer: diffAuthoring.pendingReviewComposer,
                  }),
                })}
            virtualized={false}
            toolbarLeadingAction={
              <span className="px-1 text-xs text-muted-foreground tabular-nums">
                {hunkLabel}
              </span>
            }
          />
        </div>
      )}
    </div>
  );
}
