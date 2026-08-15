import { useCallback, useEffect, useMemo, useState } from "react";
import {
  mapFindingLocation,
  parseUnifiedPatch,
  type FindingLocationInput,
} from "../../../domain/patch";
import { PierreFileTree } from "./pierre-file-tree";
import {
  ReviewDiffView,
  type LocalCommentAuthoring,
  type PendingReviewComposerActions,
  type ReviewConversationActions,
  type ReviewInlineAnnotation,
} from "./review-diff-view";
import { parseReviewDiff } from "@/review-diff-data";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_REVIEW_VIEW_PREFERENCES,
  type ReviewViewPreferences,
} from "@/review-view-preferences";
import { useLatestCommitted } from "@/hooks/use-latest-committed";
import { cn } from "@/lib/utils";
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
  surfaceAction,
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
  readonly surfaceAction?: React.ReactNode;
}): React.JSX.Element {
  const files = useMemo(() => parseUnifiedPatch(patch), [patch]);
  const parsedDiff = useMemo(() => parseReviewDiff(patch), [patch]);
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
  const [pendingLargeFileMode, setPendingLargeFileMode] = useState<string>();
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const updatePreferences = useCallback(
    (update: Partial<ReviewViewPreferences>): void => {
      if (update.fileMode !== undefined) setPendingLargeFileMode(undefined);
      setInternalPreferences((current) => ({ ...current, ...update }));
      onPreferencesChange?.(update);
    },
    [onPreferencesChange],
  );
  const updatePreferencesRef = useLatestCommitted(updatePreferences);
  useEffect(() => {
    if (pendingLargeFileMode === undefined) return;
    // Do not let a single deep selection synchronously reconstruct a 10 MB
    // virtual surface. A brief quiet period still opens the requested file,
    // while quick navigator movement remains responsive.
    const timer = window.setTimeout(() => {
      updatePreferencesRef.current({ fileMode: "selected" });
      setPendingLargeFileMode(undefined);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [pendingLargeFileMode, updatePreferencesRef]);
  const selectFile = useCallback(
    (path: string): void => {
      if (controlledSelectedPath === undefined) setInternalSelectedPath(path);
      onSelectedPathChange?.(path);
      setActivePath(path);
      const targetIndex = files.findIndex((file) => file.newPath === path);
      // A direct jump deep into an exceptionally large stream would require
      // synchronously materializing hundreds of file metrics. Switch to the
      // explicit selected-file view instead; the toolbar keeps All files one
      // click away, and ordinary review-sized streams retain their continuous
      // all-files navigation.
      if (files.length > 256 && targetIndex > 128) {
        setPendingLargeFileMode(path);
      } else {
        setPendingLargeFileMode(undefined);
      }
    },
    [controlledSelectedPath, files, onSelectedPathChange],
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
    <section
      aria-label="Diff workbench"
      data-patch-bytes={patch.length}
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
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {diffTitle ?? selectedPath ?? "No file selected"}
            </p>
            <p className="text-xs text-muted-foreground">
              {diffSubtitle ??
                "Review snapshot · GitHub writes require confirmation"}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            {surfaceAction}
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
                      {...(selectedPath === undefined ? {} : { selectedPath })}
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
          patch={patch}
          parsedFiles={parsedDiff.files}
          fileStatsByPath={parsedDiff.statsByPath}
          {...(selectedPath === undefined ? {} : { selectedPath })}
          onActiveFileChange={(path) => {
            setActivePath(path);
            onActiveFileChange?.(path);
          }}
          preferences={preferences}
          collapsedPaths={collapsedPaths}
          onPreferencesChange={updatePreferences}
          onCollapsedPathsChange={setCollapsedPaths}
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
          {...(annotations === undefined ? {} : { annotations })}
        />
      </div>
    </section>
  );
}
