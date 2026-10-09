import { useState } from "react";
import type { GuideInventoryEntry } from "#src/domain/guide";
import {
  loadReviewViewPreferences,
  type ReviewViewPreferences,
} from "@/review-view-preferences";
import type { GuideFileEvidence } from "./guide-file-evidence";
import { ReviewDiffView } from "./review-diff-view";

/** Read-only complete file evidence; no current-source hydration or review authoring. */
export function GuideFileDiff({
  file,
  evidence,
  preferences,
}: {
  readonly file: GuideInventoryEntry;
  readonly evidence: GuideFileEvidence;
  readonly preferences?: ReviewViewPreferences;
}): React.JSX.Element {
  const [localPreferences, setLocalPreferences] = useState(
    () => preferences ?? loadReviewViewPreferences(),
  );
  const path = file.status === "removed" ? file.oldPath : file.newPath;
  return (
    <div
      role="group"
      aria-label={`Guide evidence ${path}`}
      className="mt-3 min-w-0 overflow-hidden rounded-md border"
    >
      <pre className="overflow-x-auto whitespace-pre-wrap break-all p-3 font-mono text-xs">
        {file.metadata.join("\n")}
      </pre>
      {evidence.diff === undefined ? null : (
        <ReviewDiffView
          patch={evidence.patch}
          parsedFiles={evidence.diff.files}
          fileStatsByPath={evidence.diff.statsByPath}
          selectedPath={path}
          preferences={localPreferences}
          collapsedPaths={new Set()}
          onPreferencesChange={(update) =>
            setLocalPreferences((current) => ({ ...current, ...update }))
          }
          onCollapsedPathsChange={() => undefined}
          virtualized={false}
        />
      )}
    </div>
  );
}
