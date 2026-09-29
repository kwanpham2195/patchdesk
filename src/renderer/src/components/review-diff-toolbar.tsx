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
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  ReviewDiffChangesMenu,
  type DiffChangesControl,
} from "./review-diff-changes-menu";
import {
  ReviewDiffOptionRow,
  ReviewDiffOptionsPopover,
} from "./review-diff-options-popover";
import { SCOPE_BUCKET_FILLS, SCOPE_BUCKET_LABELS } from "./scope-gauge-buckets";

// `secondary` alone is the same fill as an idle button, so a pressed segment
// takes the selection accent the file tree and commit list use.
const PRESSED_SEGMENT_CLASS =
  "aria-pressed:bg-accent aria-pressed:text-accent-foreground";

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
          <Button variant="outline" size="xs" aria-label="Scope filter">
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
            Clear scope
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

/** The diff navigation keys, which only act in All files mode. */
const NAVIGATION_KEYS = [
  { keys: [",", "."], label: "Previous / next file" },
  { keys: ["[", "]"], label: "Previous / next change" },
  { keys: ["{", "}"], label: "Previous / next comment" },
  { keys: ["(", ")"], label: "Previous / next Finding" },
  { keys: ["p", "n"], label: "Previous / next unviewed file" },
  { keys: ["v"], label: "Toggle viewed" },
] as const;

function NavigationKeysTooltip(): React.JSX.Element {
  return (
    <TooltipContent className="flex-col items-stretch gap-1">
      {NAVIGATION_KEYS.map(({ keys, label }) => (
        <span key={label} className="flex items-center justify-between gap-3">
          {label}
          <span className="flex gap-1">
            {keys.map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </span>
        </span>
      ))}
    </TooltipContent>
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
        className={PRESSED_SEGMENT_CLASS}
        aria-pressed={!preview.active}
        onClick={() => preview.onChange(false)}
      >
        Diff
      </Button>
      <Button
        variant={preview.active ? "secondary" : "ghost"}
        size="xs"
        className={PRESSED_SEGMENT_CLASS}
        aria-pressed={preview.active}
        onClick={() => preview.onChange(true)}
      >
        Preview
      </Button>
    </ButtonGroup>
  );
}

/** All files and Selected, inside View options; neither is pressed while Since your review owns the diff. */
function FileModeSwitch({
  pressed,
  selectedPath,
  onSelect,
}: {
  readonly pressed: "all" | "selected" | undefined;
  readonly selectedPath: string | undefined;
  readonly onSelect: (fileMode: "all" | "selected") => void;
}): React.JSX.Element {
  return (
    <ButtonGroup aria-label="File display mode" className="px-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={pressed === "all" ? "secondary" : "ghost"}
              size="xs"
              className={PRESSED_SEGMENT_CLASS}
              aria-pressed={pressed === "all"}
              onClick={() => onSelect("all")}
            />
          }
        >
          <Files /> All files
        </TooltipTrigger>
        <NavigationKeysTooltip />
      </Tooltip>
      <Button
        variant={pressed === "selected" ? "secondary" : "ghost"}
        size="xs"
        className={PRESSED_SEGMENT_CLASS}
        aria-pressed={pressed === "selected"}
        disabled={selectedPath === undefined}
        onClick={() => onSelect("selected")}
      >
        <FileCode2 /> Selected
      </Button>
    </ButtonGroup>
  );
}

/** The viewed count, whose menu marks every shown file viewed or clears those marks. */
function ReviewDiffViewedMenu({
  viewedCount,
  fileCount,
  onSetAllCollapsed,
}: {
  readonly viewedCount: number;
  readonly fileCount: number;
  readonly onSetAllCollapsed: (collapsed: boolean) => void;
}): React.JSX.Element {
  const allViewed = viewedCount === fileCount && fileCount > 0;
  return (
    <DropdownMenu>
      {/* Chromium leaves a button unnamed when its text sits in a status region, so the count is named twice. */}
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            aria-label={`${viewedCount}/${fileCount} viewed`}
          />
        }
      >
        <span role="status" className="tabular-nums">
          {viewedCount}/{fileCount} viewed
        </span>
        <ChevronDown aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem onClick={() => onSetAllCollapsed(!allViewed)}>
          {allViewed ? "Show all" : "Mark all viewed"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Renders the diff toolbar: the Changes, Scope, and View menus, the Markdown Diff/Preview switch, and the viewed count's menu. */
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
  leadingAction,
  changes,
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
  /** Drawn before every other control, such as the review navigator toggle. */
  readonly leadingAction?: React.ReactNode;
  /** What the Changes menu offers; absent where the diff has no other comparison. */
  readonly changes?: DiffChangesControl | undefined;
}): React.JSX.Element {
  // A showing preview replaces the CodeView, so every control that describes
  // one is suppressed; the Scope picker stays because it also filters Browse,
  // and the Patch view stays because it chooses the file being previewed.
  const previewing = markdownPreview?.active === true;
  // Viewed and collapsed are one state; counting against `files` ignores paths a Scope filter hid.
  const viewedCount = files.filter((file) =>
    collapsedPaths.has(file.name),
  ).length;
  const sinceReview = changes?.sinceReview;
  const sinceReviewActive = sinceReview?.active === true;
  const selectFileMode = (fileMode: "all" | "selected"): void => {
    if (sinceReviewActive) sinceReview?.onChange(false);
    onPreferencesChange({ fileMode });
  };
  const fileModeControls = virtualized && !previewing;
  const shownChanges: DiffChangesControl = {
    patchView: changes?.patchView,
    sinceReview:
      sinceReview === undefined || !fileModeControls
        ? undefined
        : {
            ...sinceReview,
            onChange: (active) => {
              if (active) onPreferencesChange({ fileMode: "all" });
              sinceReview.onChange(active);
            },
          },
  };
  return (
    <div
      data-review-diff-toolbar
      className="z-20 flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-1 border-b bg-card/95 px-2 py-1 backdrop-blur"
    >
      <div className="flex flex-wrap items-center gap-1">
        {leadingAction}
        <ReviewDiffChangesMenu changes={shownChanges} />
        {scopeFilter === undefined ? null : (
          <ReviewDiffScopePicker scopeFilter={scopeFilter} />
        )}
        {previewing ? null : (
          <ReviewDiffOptionsPopover
            preferences={preferences}
            onPreferencesChange={onPreferencesChange}
            triggerLabel={
              !virtualized
                ? undefined
                : preferences.fileMode === "all"
                  ? "All files"
                  : "Selected"
            }
          >
            {virtualized ? (
              <FileModeSwitch
                pressed={sinceReviewActive ? undefined : preferences.fileMode}
                selectedPath={selectedPath}
                onSelect={selectFileMode}
              />
            ) : null}
            <ReviewDiffOptionRow
              icon={
                contextStatus === "loading" ? (
                  <Spinner />
                ) : (
                  <ChevronsUpDown aria-hidden="true" />
                )
              }
              label={contextControl.label}
              checked={expandUnchanged}
              disabledReason={
                contextControl.disabled ? contextControl.description : undefined
              }
              onCheckedChange={(checked) => onExpandUnchangedChange(checked)}
            />
          </ReviewDiffOptionsPopover>
        )}
        {markdownPreview === undefined ? null : (
          <MarkdownPreviewModeSwitch preview={markdownPreview} />
        )}
      </div>
      {fileModeControls ? (
        <ReviewDiffViewedMenu
          viewedCount={viewedCount}
          fileCount={files.length}
          onSetAllCollapsed={onSetAllCollapsed}
        />
      ) : null}
    </div>
  );
}
