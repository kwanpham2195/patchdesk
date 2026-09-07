import { useCallback, useEffect, useMemo, useState } from "react";
import {
  mapFindingLocation,
  parseUnifiedPatch,
  type FindingLocationInput,
} from "../../../domain/patch";
import { filterUnifiedPatchFiles } from "../../../domain/unified-patch";
import { DiffWorkerPoolProvider } from "./diff-worker-pool";
import { PierreFileTree } from "./pierre-file-tree";
import {
  ReviewDiffView,
  type LocalCommentAuthoring,
  type PendingReviewComposerActions,
  type ReviewConversationActions,
  type ReviewInlineAnnotation,
  type SelectedDiffRange,
} from "./review-diff-view";
import type { ScopeFilterControl } from "./review-diff-toolbar";
import type { PullRequestBodyContext } from "./pull-request-description";
import { parseReviewDiff } from "@/review-diff-data";
import type { FileFindingCount } from "@/review-finding-counts";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_REVIEW_VIEW_PREFERENCES,
  type ReviewViewPreferences,
} from "@/review-view-preferences";
import { cn } from "@/lib/utils";
import { useMarkdownPreviewPaths } from "@/hooks/use-markdown-preview-paths";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

/** Read-only diff workbench with deterministic file and finding navigation. */
export function DiffWorkbench({
  patch,
  finding,
  sourceSession,
  className,
  fillViewport = true,
  localCommentAuthoring,
  pendingReviewComposer,
  conversationActions,
  bodyContext,
  controlledSelectedPath,
  onSelectedPathChange,
  onActiveFileChange,
  hideFileNavigation = false,
  diffTitle,
  diffSubtitle,
  copyValue,
  preferences: controlledPreferences,
  onPreferencesChange,
  annotations,
  findingCountsByPath,
  onOpenFindingInAnalysis,
  selectedRange,
  leadingAction,
  visiblePaths,
  scopeFilter,
}: {
  readonly patch: string;
  readonly finding?: FindingLocationInput;
  readonly sourceSession?: {
    readonly profileId: string;
    readonly sessionId: string;
  };
  readonly className?: string;
  readonly fillViewport?: boolean;
  readonly localCommentAuthoring?: LocalCommentAuthoring;
  readonly pendingReviewComposer?: PendingReviewComposerActions;
  readonly conversationActions?: ReviewConversationActions;
  /** What an inline conversation or pending card resolves its images and links against. */
  readonly bodyContext?: PullRequestBodyContext;
  readonly controlledSelectedPath?: string;
  readonly onSelectedPathChange?: (path: string) => void;
  readonly onActiveFileChange?: (path: string) => void;
  readonly hideFileNavigation?: boolean;
  readonly diffTitle?: string;
  readonly diffSubtitle?: string;
  readonly copyValue?: string;
  readonly preferences?: ReviewViewPreferences;
  readonly onPreferencesChange?: (
    update: Partial<ReviewViewPreferences>,
  ) => void;
  readonly annotations?: ReadonlyArray<ReviewInlineAnnotation>;
  readonly findingCountsByPath?: ReadonlyMap<string, FileFindingCount>;
  readonly onOpenFindingInAnalysis?: (findingId: string) => void;
  readonly selectedRange?: SelectedDiffRange;
  readonly leadingAction?: React.ReactNode;
  /** The only files to browse and render; absent when no filter is active. */
  readonly visiblePaths?: ReadonlySet<string>;
  /** Drives the toolbar Scope picker; absent where the diff cannot be filtered by bucket. */
  readonly scopeFilter?: ScopeFilterControl;
}): React.JSX.Element {
  // Narrowing the patch itself, not just its parsed metadata: the pane falls
  // back to rendering the patch text where Pierre's CodeView is unavailable.
  const visiblePatch = useMemo(
    () =>
      visiblePaths === undefined
        ? patch
        : filterUnifiedPatchFiles(patch, visiblePaths),
    [patch, visiblePaths],
  );
  const files = useMemo(() => parseUnifiedPatch(visiblePatch), [visiblePatch]);
  const parsedDiff = useMemo(
    () => parseReviewDiff(visiblePatch),
    [visiblePatch],
  );
  const mapped =
    finding === undefined ? undefined : mapFindingLocation(files, finding);
  const mappedPath =
    mapped?.mappingStatus === "mapped" ? mapped.path : undefined;
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [internalSelectedPath, setInternalSelectedPath] = useState<
    string | undefined
  >(files[0]?.newPath);
  const selectedPath = controlledSelectedPath ?? internalSelectedPath;
  const [activePath, setActivePath] = useState<string | undefined>(
    files[0]?.newPath,
  );
  // Keyboard nav (`,` `.` `[` `]` `{` `}` in review-diff-view) moves
  // activePath without changing selectedPath, so the fixed panel header
  // must prefer activePath to stay in sync with the file on screen. Hoisted
  // to a single value (rather than repeating the expression at both the
  // test-hook attribute and the displayed text) so the two can never
  // silently disagree.
  const headerPath = diffTitle ?? activePath ?? selectedPath;
  const [previousMappedPath, setPreviousMappedPath] = useState<
    string | undefined
  >(undefined);
  if (mappedPath !== previousMappedPath) {
    setPreviousMappedPath(mappedPath);
    if (mappedPath !== undefined) {
      setInternalSelectedPath(mappedPath);
      setActivePath(mappedPath);
    }
  }
  const [internalPreferences, setInternalPreferences] =
    useState<ReviewViewPreferences>({
      ...DEFAULT_REVIEW_VIEW_PREFERENCES,
      fileMode: "all",
    });
  const preferences = controlledPreferences ?? internalPreferences;
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const { paths: markdownPreviewPaths, setPreview: setMarkdownPreview } =
    useMarkdownPreviewPaths(visiblePatch, sourceSession);
  const updatePreferences = useCallback(
    (update: Partial<ReviewViewPreferences>): void => {
      setInternalPreferences((current) => ({ ...current, ...update }));
      onPreferencesChange?.(update);
    },
    [onPreferencesChange],
  );
  // Keyboard nav and scrolling move the file on screen without changing the
  // selection, so the header's path and the pane's path are reported through
  // this one callback.
  const reportActiveFile = useCallback(
    (path: string): void => {
      setActivePath(path);
      onActiveFileChange?.(path);
    },
    [onActiveFileChange],
  );
  const selectFile = useCallback(
    (path: string): void => {
      if (controlledSelectedPath === undefined) setInternalSelectedPath(path);
      onSelectedPathChange?.(path);
      setActivePath(path);
    },
    [controlledSelectedPath, onSelectedPathChange],
  );
  const fileRows = useMemo(
    () =>
      files.map((file) => ({
        path: file.newPath,
        stats: parsedDiff.statsByPath.get(file.newPath) ?? {
          path: file.newPath,
          additions: 0,
          deletions: 0,
        },
        gitStatus: parsedDiff.gitStatusByPath.get(file.newPath),
      })),
    [files, parsedDiff.gitStatusByPath, parsedDiff.statsByPath],
  );
  useEffect(() => {
    if (controlledSelectedPath !== undefined)
      setActivePath(controlledSelectedPath);
  }, [controlledSelectedPath]);
  return (
    <DiffWorkerPoolProvider>
      <section
        aria-label="Diff workbench"
        data-patch-bytes={visiblePatch.length}
        className={cn(
          `grid min-w-0 overflow-hidden ${hideFileNavigation ? "grid-cols-1" : "min-[1100px]:grid-cols-[15rem_minmax(0,1fr)] max-[1099px]:grid-cols-1"}`,
          fillViewport
            ? "min-h-[calc(100vh-3.5rem)] min-[1100px]:h-[calc(100vh-3.5rem)]"
            : "h-full min-h-0",
          className,
        )}
      >
        {hideFileNavigation ? null : (
          <aside
            aria-label="Review navigation"
            className="min-w-0 overflow-hidden border-r bg-card p-3 max-[1099px]:hidden"
          >
            <PierreFileTree
              files={fileRows}
              {...(selectedPath === undefined ? {} : { selectedPath })}
              {...(activePath === undefined ? {} : { activePath })}
              onSelect={selectFile}
            />
          </aside>
        )}
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background">
          <header className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b bg-background/95 px-4 backdrop-blur">
            <div className="flex min-w-0 items-center gap-3">
              {leadingAction}
              <div className="min-w-0">
                <p
                  className="truncate text-sm font-medium"
                  data-diff-workbench-header-path={headerPath}
                >
                  {headerPath ?? "No file selected"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {diffSubtitle ??
                    "Review snapshot · GitHub writes require confirmation"}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              {copyValue === undefined ? null : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void navigator.clipboard?.writeText(copyValue)}
                >
                  Copy commit SHA
                </Button>
              )}
              {hideFileNavigation ? null : (
                <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
                  <SheetTrigger
                    render={
                      <Button
                        variant="outline"
                        size="sm"
                        className="max-[1099px]:inline-flex min-[1100px]:hidden"
                      />
                    }
                  >
                    Files
                  </SheetTrigger>
                  <SheetContent side="left">
                    <SheetHeader>
                      <SheetTitle>Changed files</SheetTitle>
                      <SheetDescription>
                        Choose a file to inspect its change.
                      </SheetDescription>
                    </SheetHeader>
                    <div className="min-h-0 overflow-auto p-4">
                      <PierreFileTree
                        files={fileRows}
                        {...(selectedPath === undefined
                          ? {}
                          : { selectedPath })}
                        {...(activePath === undefined ? {} : { activePath })}
                        onSelect={(path) => {
                          selectFile(path);
                          setNavigationOpen(false);
                        }}
                      />
                    </div>
                  </SheetContent>
                </Sheet>
              )}
            </div>
          </header>
          <ReviewDiffView
            patch={visiblePatch}
            scopeFilter={scopeFilter}
            parsedFiles={parsedDiff.files}
            fileStatsByPath={parsedDiff.statsByPath}
            {...(selectedPath === undefined ? {} : { selectedPath })}
            onActiveFileChange={reportActiveFile}
            preferences={preferences}
            collapsedPaths={collapsedPaths}
            onPreferencesChange={updatePreferences}
            onCollapsedPathsChange={setCollapsedPaths}
            markdownPreviewActive={
              selectedPath !== undefined &&
              markdownPreviewPaths.has(selectedPath)
            }
            onMarkdownPreviewChange={(active) => {
              if (selectedPath === undefined) return;
              setMarkdownPreview(selectedPath, active);
              // In `all` file mode the header follows activePath, which
              // scrolling may have moved off the selection. The pane draws the
              // selected file, so the two have to be pulled back together.
              if (active) reportActiveFile(selectedPath);
            }}
            {...(sourceSession === undefined ? {} : { sourceSession })}
            {...(localCommentAuthoring === undefined
              ? {}
              : { localCommentAuthoring })}
            {...(pendingReviewComposer === undefined
              ? {}
              : { pendingReviewComposer })}
            {...(conversationActions === undefined
              ? {}
              : { conversationActions })}
            {...(bodyContext === undefined ? {} : { bodyContext })}
            {...(annotations === undefined ? {} : { annotations })}
            {...(findingCountsByPath === undefined
              ? {}
              : { findingCountsByPath })}
            {...(onOpenFindingInAnalysis === undefined
              ? {}
              : { onOpenFindingInAnalysis })}
            {...(selectedRange === undefined ? {} : { selectedRange })}
          />
        </div>
      </section>
    </DiffWorkerPoolProvider>
  );
}
