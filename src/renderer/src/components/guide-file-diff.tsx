import { useState } from "react";
import type { GuideInventoryEntry } from "#src/domain/guide";
import type { ReviewViewPreferences } from "@/review-view-preferences";
import type { GuideFileEvidence } from "./guide-file-evidence";
import { ReviewDiffView } from "./review-diff-view";
import { definedProps } from "#src/domain/defined-props";
import { deriveConversationThreadEntries } from "#src/renderer/src/conversation-thread-entries";
import type { WalkthroughDiffAuthoring } from "./walkthrough-diff-authoring";

/** Full retained file evidence uses shared actions without current-source hydration. */
export function GuideFileDiff({
  file,
  evidence,
  preferences,
  diffAuthoring,
  onPreferencesChange,
}: {
  readonly diffAuthoring?: WalkthroughDiffAuthoring;
  readonly file: GuideInventoryEntry;
  readonly evidence: GuideFileEvidence;
  readonly preferences: ReviewViewPreferences;
  readonly onPreferencesChange: (
    update: Partial<ReviewViewPreferences>,
  ) => void;
}): React.JSX.Element {
  const [markdownPreviewActive, setMarkdownPreviewActive] = useState(false);
  const path = file.status === "removed" ? file.oldPath : file.newPath;
  return (
    <div
      role="group"
      aria-label={`Guide evidence ${path}`}
      className="mt-3 min-w-0 overflow-hidden rounded-md border"
    >
      {evidence.diff === undefined ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-all p-3 font-mono text-xs">
          {file.metadata.join("\n")}
        </pre>
      ) : (
        <details className="border-b text-xs text-muted-foreground">
          <summary className="cursor-pointer px-3 py-2 font-medium">
            Patch metadata
          </summary>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all px-3 pb-3 font-mono text-xs">
            {file.metadata.join("\n")}
          </pre>
        </details>
      )}
      {evidence.diff === undefined ? null : (
        <ReviewDiffView
          patch={evidence.patch}
          parsedFiles={evidence.diff.files}
          fileStatsByPath={evidence.diff.statsByPath}
          selectedPath={path}
          {...(diffAuthoring === undefined
            ? {}
            : {
                annotations: deriveConversationThreadEntries(
                  diffAuthoring.conversationAnnotations ?? [],
                  diffAuthoring.annotations,
                ).filter((annotation) => annotation.path === path),
                pendingReviewDrafts: diffAuthoring.pendingReviewDrafts,
                conversationActions: diffAuthoring.conversationActions,
                ...definedProps({
                  localCommentAuthoring: diffAuthoring.localCommentAuthoring,
                  pendingReviewComposer: diffAuthoring.pendingReviewComposer,
                  bodyContext: diffAuthoring.bodyContext,
                }),
              })}
          preferences={preferences}
          collapsedPaths={new Set()}
          onPreferencesChange={onPreferencesChange}
          showViewOptions={false}
          markdownPreviewActive={markdownPreviewActive}
          onMarkdownPreviewChange={setMarkdownPreviewActive}
          onCollapsedPathsChange={() => undefined}
          virtualized={false}
        />
      )}
    </div>
  );
}
