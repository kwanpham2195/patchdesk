import type { FileDiffMetadata } from "@pierre/diffs";
import { ChevronDown, ChevronsUpDown, FileCode2, Files } from "lucide-react";

import type { ReviewViewPreferences } from "@/review-view-preferences";
import type {
  ReviewContextControl,
  ReviewContextStatus,
} from "@/review-context-control";
import type { ChangeScopeBucket } from "../../../domain/change-scope";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { ReviewDiffOptionsPopover } from "./review-diff-options-popover";
import { SCOPE_BUCKET_FILLS, SCOPE_BUCKET_LABELS } from "./scope-gauge-buckets";

/** The Scope buckets the diff can be narrowed to, and the state of that choice. */
export type ScopeFilterControl = {
  /** The populated buckets in gauge order; an empty bucket is never offered. */
  readonly buckets: ReadonlyArray<{
    readonly bucket: ChangeScopeBucket;
    readonly files: number;
  }>;
  readonly activeBucket: ChangeScopeBucket | undefined;
  readonly onSelect: (bucket: ChangeScopeBucket) => void;
  readonly onClear: () => void;
};

/** The radio value standing for "no bucket"; buckets carry their own names. */
const ALL_FILES_VALUE = "all";

function ScopeBucketSwatch({
  bucket,
}: {
  readonly bucket: ChangeScopeBucket;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-[2px]",
        SCOPE_BUCKET_FILLS[bucket],
      )}
    />
  );
}

function ReviewDiffScopePicker({
  scopeFilter,
}: {
  readonly scopeFilter: ScopeFilterControl;
}): React.JSX.Element | null {
  const { buckets, activeBucket, onSelect, onClear } = scopeFilter;
  if (buckets.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="secondary" size="xs" aria-label="Scope filter">
            {activeBucket === undefined ? null : (
              <ScopeBucketSwatch bucket={activeBucket} />
            )}
            {activeBucket === undefined
              ? "Scope"
              : SCOPE_BUCKET_LABELS[activeBucket]}
            <ChevronDown aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent className="w-44">
        <DropdownMenuRadioGroup value={activeBucket ?? ALL_FILES_VALUE}>
          <DropdownMenuRadioItem
            value={ALL_FILES_VALUE}
            closeOnClick
            onClick={onClear}
          >
            All files
          </DropdownMenuRadioItem>
          {buckets.map(({ bucket, files }) => (
            <DropdownMenuRadioItem
              key={bucket}
              value={bucket}
              closeOnClick
              onClick={() => onSelect(bucket)}
            >
              <ScopeBucketSwatch bucket={bucket} />
              {SCOPE_BUCKET_LABELS[bucket]}
              <DropdownMenuShortcut>{files}</DropdownMenuShortcut>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Drives the Diff/Preview switch for the file currently on screen. */
export type MarkdownPreviewControl = {
  readonly path: string;
  readonly active: boolean;
  readonly onChange: (active: boolean) => void;
};

function MarkdownPreviewModeSwitch({
  preview,
}: {
  readonly preview: MarkdownPreviewControl;
}): React.JSX.Element {
  return (
    <ButtonGroup aria-label={`Display mode for ${preview.path}`}>
      <Button
        variant={preview.active ? "ghost" : "secondary"}
        size="xs"
        aria-pressed={!preview.active}
        onClick={() => preview.onChange(false)}
      >
        Diff
      </Button>
      <Button
        variant={preview.active ? "secondary" : "ghost"}
        size="xs"
        aria-pressed={preview.active}
        onClick={() => preview.onChange(true)}
      >
        Preview
      </Button>
    </ButtonGroup>
  );
}

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
  scopeFilter,
  markdownPreview,
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
  /** Drives the Scope picker; absent where the diff cannot be filtered by bucket. */
  readonly scopeFilter?: ScopeFilterControl | undefined;
  /** Absent where the file on screen has no Markdown preview to switch to. */
  readonly markdownPreview?: MarkdownPreviewControl | undefined;
}): React.JSX.Element {
  // A showing preview replaces the CodeView, so every control that describes
  // one is suppressed; the Scope picker stays because it also filters Browse.
  const previewing = markdownPreview?.active === true;
  return (
    <div
      data-review-diff-toolbar
      className="z-20 flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-1 border-b bg-card/95 px-2 py-1 backdrop-blur"
    >
      <div className="flex flex-wrap items-center gap-1">
        {previewing ? null : (
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
              variant={
                preferences.fileMode === "selected" ? "secondary" : "ghost"
              }
              size="xs"
              aria-pressed={preferences.fileMode === "selected"}
              disabled={selectedPath === undefined}
              onClick={() => onPreferencesChange({ fileMode: "selected" })}
            >
              <FileCode2 /> Selected
            </Button>
          </ButtonGroup>
        )}
        {markdownPreview === undefined ? null : (
          <MarkdownPreviewModeSwitch preview={markdownPreview} />
        )}
        {scopeFilter === undefined ? null : (
          <ReviewDiffScopePicker scopeFilter={scopeFilter} />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1">
        {previewing ? null : (
          <ReviewDiffOptionsPopover
            preferences={preferences}
            onPreferencesChange={onPreferencesChange}
          />
        )}
        {previewing ? null : (
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
        )}
        {previewing ? null : (
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
        )}
      </div>
    </div>
  );
}
