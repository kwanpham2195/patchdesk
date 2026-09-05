import type { FileDiffMetadata } from "@pierre/diffs";
import { ChevronsUpDown, FileCode2, Files } from "lucide-react";

import type { ReviewViewPreferences } from "@/review-view-preferences";
import type {
  ReviewContextControl,
  ReviewContextStatus,
} from "@/review-context-control";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Spinner } from "@/components/ui/spinner";
import { ReviewDiffOptionsPopover } from "./review-diff-options-popover";

/** Renders shared file selection, display, context, and viewed controls above a review diff. */
export function ReviewDiffToolbar({
  virtualized,
  preferences,
  selectedPath,
  onPreferencesChange,
  contextControl,
  contextStatus,
  expandUnchanged,
  onExpandUnchangedChange,
  collapsedPaths,
  files,
  onSetAllCollapsed,
}: {
  readonly virtualized: boolean;
  readonly preferences: Pick<
    ReviewViewPreferences,
    "fileMode" | "diffStyle" | "overflow" | "lineNumbers" | "backgrounds"
  >;
  readonly selectedPath: string | undefined;
  readonly onPreferencesChange: (
    update: Partial<ReviewViewPreferences>,
  ) => void;
  readonly contextControl: ReviewContextControl;
  readonly contextStatus: ReviewContextStatus;
  readonly expandUnchanged: boolean;
  readonly onExpandUnchangedChange: (expanded: boolean) => void;
  readonly collapsedPaths: ReadonlySet<string>;
  readonly files: ReadonlyArray<FileDiffMetadata>;
  readonly onSetAllCollapsed: (collapsed: boolean) => void;
}): React.JSX.Element {
  return (
    <div
      data-review-diff-toolbar
      className="z-20 flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-1 border-b bg-card/95 px-2 py-1 backdrop-blur"
    >
      <ButtonGroup
        className={`items-center ${virtualized ? "flex" : "hidden"}`}
      >
        <Button
          variant={preferences.fileMode === "all" ? "secondary" : "ghost"}
          size="xs"
          aria-pressed={preferences.fileMode === "all"}
          onClick={() => onPreferencesChange({ fileMode: "all" })}
        >
          <Files /> All files
        </Button>
        <Button
          variant={preferences.fileMode === "selected" ? "secondary" : "ghost"}
          size="xs"
          aria-pressed={preferences.fileMode === "selected"}
          disabled={selectedPath === undefined}
          onClick={() => onPreferencesChange({ fileMode: "selected" })}
        >
          <FileCode2 /> Selected
        </Button>
      </ButtonGroup>
      <div className="flex flex-wrap items-center justify-end gap-1">
        <ReviewDiffOptionsPopover
          preferences={preferences}
          onPreferencesChange={onPreferencesChange}
        />
        <Button
          variant={expandUnchanged ? "secondary" : "ghost"}
          size="xs"
          aria-pressed={expandUnchanged}
          aria-label={contextControl.description}
          title={contextControl.description}
          disabled={contextControl.disabled}
          onClick={() => onExpandUnchangedChange(!expandUnchanged)}
        >
          {contextStatus === "loading" ? <Spinner /> : <ChevronsUpDown />}
          {contextControl.label}
        </Button>
        <Button
          className={virtualized ? undefined : "hidden"}
          variant="ghost"
          size="xs"
          aria-pressed={
            collapsedPaths.size === files.length && files.length > 0
          }
          onClick={() =>
            onSetAllCollapsed(
              !(collapsedPaths.size === files.length && files.length > 0),
            )
          }
        >
          {collapsedPaths.size === files.length && files.length > 0
            ? "Show all"
            : "Mark all viewed"}
        </Button>
      </div>
    </div>
  );
}
