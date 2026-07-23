import { useCallback, useEffect, useMemo, useState } from "react";
import { LocateFixed, Search } from "lucide-react";

import {
  mapFindingLocation,
  parseUnifiedPatch,
  type FindingLocationInput,
} from "../../../domain/patch";
import { ChangedFileTree } from "./changed-file-tree";
import { ReviewDiffView } from "./review-diff-view";
import { parseReviewDiff } from "@/review-diff-data";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DEFAULT_REVIEW_VIEW_PREFERENCES,
  type ReviewViewPreferences,
} from "@/review-view-preferences";
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
}: {
  readonly patch: string;
  readonly finding?: FindingLocationInput;
  readonly sourceSession?: { readonly profileId: string; readonly sessionId: string };
  readonly className?: string;
  readonly fillViewport?: boolean;
}): React.JSX.Element {
  const files = useMemo(() => parseUnifiedPatch(patch), [patch]);
  const parsedDiff = useMemo(() => parseReviewDiff(patch), [patch]);
  const [query, setQuery] = useState("");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | undefined>(
    files[0]?.newPath,
  );
  const [preferences, setPreferences] = useState<ReviewViewPreferences>({
    ...DEFAULT_REVIEW_VIEW_PREFERENCES,
    fileMode: "all",
  });
  const [pendingLargeFileMode, setPendingLargeFileMode] = useState<string>();
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const updatePreferences = useCallback(
    (update: Partial<ReviewViewPreferences>): void => {
      if (update.fileMode !== undefined) setPendingLargeFileMode(undefined);
      setPreferences((current) => ({ ...current, ...update }));
    },
    [],
  );
  useEffect(() => {
    if (pendingLargeFileMode === undefined) return;
    // Do not let a single deep selection synchronously reconstruct a 10 MB
    // virtual surface. A brief quiet period still opens the requested file,
    // while quick navigator movement remains responsive.
    const timer = window.setTimeout(() => {
      setPreferences((current) =>
        current.fileMode === "selected"
          ? current
          : { ...current, fileMode: "selected" },
      );
      setPendingLargeFileMode(undefined);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [pendingLargeFileMode]);
  const selectFile = useCallback(
    (path: string): void => {
      setSelectedPath(path);
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
    [files],
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
      })),
    [files, parsedDiff.statsByPath],
  );
  const visibleFiles = useMemo(
    () =>
      fileRows.filter((file) =>
        file.path.toLowerCase().includes(query.toLowerCase()),
      ),
    [fileRows, query],
  );
  const navigatorWindow = query.length === 0 && visibleFiles.length > 200
    ? 20
    : undefined;
  const mapped =
    finding === undefined ? undefined : mapFindingLocation(files, finding);
  const mappedPath =
    mapped?.mappingStatus === "mapped" ? mapped.path : undefined;
  return (
    <section
      aria-label="Diff workbench"
      data-patch-bytes={patch.length}
      className={cn(
        "grid min-w-0 grid-cols-[15rem_minmax(0,1fr)] max-[1099px]:grid-cols-1",
        fillViewport ? "min-h-[calc(100vh-3.5rem)]" : "h-full min-h-0",
        className,
      )}
    >
      <aside
        aria-label="Review navigation"
        className="min-w-0 border-r bg-card p-3 max-[1099px]:hidden"
      >
        <Tabs defaultValue="files">
          <TabsList className="w-full">
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="findings">Findings</TabsTrigger>
          </TabsList>
          <TabsContent value="files" className="mt-3">
            <Label htmlFor="changed-file-search" className="sr-only">
              Search changed files
            </Label>
            <InputGroup className="mb-3">
              <InputGroupAddon>
                <Search aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                id="changed-file-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter files"
              />
            </InputGroup>
            <ChangedFileTree
              files={visibleFiles}
              {...(selectedPath === undefined ? {} : { selectedPath })}
              onSelect={selectFile}
              {...(navigatorWindow === undefined
                ? {}
                : { maxVisibleItems: navigatorWindow })}
            />
          </TabsContent>
          <TabsContent
            value="findings"
            className="mt-3 text-sm text-muted-foreground"
          >
            {mappedPath === undefined ? (
              "No mapped finding selected."
            ) : (
              <Button
                variant="outline"
                className="w-full justify-start"
                onClick={() => selectFile(mappedPath)}
              >
                <LocateFixed />
                Go to mapped finding
              </Button>
            )}
          </TabsContent>
        </Tabs>
      </aside>
      <div className="min-w-0 overflow-auto bg-background">
        <header className="sticky top-0 z-10 flex min-h-12 items-center justify-between gap-3 border-b bg-background/95 px-4 backdrop-blur">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {selectedPath ?? "No file selected"}
            </p>
            <p className="text-xs text-muted-foreground">
              Stored unified patch · read only
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
              <SheetTrigger
                render={<Button variant="outline" size="sm" className="max-[1099px]:inline-flex min-[1100px]:hidden" />}
              >
                Files and findings
              </SheetTrigger>
              <SheetContent side="left">
                <SheetHeader>
                  <SheetTitle>Files and findings</SheetTitle>
                  <SheetDescription>
                    Choose a changed file or mapped finding.
                  </SheetDescription>
                </SheetHeader>
                <div className="min-h-0 overflow-auto p-4">
                  <Tabs defaultValue="files">
                    <TabsList className="w-full">
                      <TabsTrigger value="files">Files</TabsTrigger>
                      <TabsTrigger value="findings">Findings</TabsTrigger>
                    </TabsList>
                    <TabsContent value="files" className="mt-3">
                      <Label
                        htmlFor="compact-changed-file-search"
                        className="sr-only"
                      >
                        Search changed files
                      </Label>
                      <InputGroup className="mb-3">
                        <InputGroupAddon>
                          <Search aria-hidden="true" />
                        </InputGroupAddon>
                        <InputGroupInput
                          id="compact-changed-file-search"
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                          placeholder="Filter files"
                        />
                      </InputGroup>
                      <ChangedFileTree
                        files={visibleFiles}
                        {...(selectedPath === undefined
                          ? {}
                          : { selectedPath })}
                        onSelect={(path) => {
                          selectFile(path);
                          setNavigationOpen(false);
                        }}
                        {...(navigatorWindow === undefined
                          ? {}
                          : { maxVisibleItems: navigatorWindow })}
                      />
                    </TabsContent>
                    <TabsContent
                      value="findings"
                      className="mt-3 text-sm text-muted-foreground"
                    >
                      {mappedPath === undefined ? (
                        "No mapped finding selected."
                      ) : (
                        <Button
                          variant="outline"
                          className="w-full justify-start"
                          onClick={() => {
                            selectFile(mappedPath);
                            setNavigationOpen(false);
                          }}
                        >
                          <LocateFixed />
                          Go to mapped finding
                        </Button>
                      )}
                    </TabsContent>
                  </Tabs>
                </div>
              </SheetContent>
            </Sheet>
            <Sheet open={contextOpen} onOpenChange={setContextOpen}>
              <SheetTrigger render={<Button variant="outline" size="sm" />}>
                Review context
              </SheetTrigger>
              <SheetContent side="right">
                <SheetHeader>
                  <SheetTitle>Review context</SheetTitle>
                  <SheetDescription>
                    The stored diff is local and read-only.
                  </SheetDescription>
                </SheetHeader>
                <div className="p-4 text-sm text-muted-foreground">
                  <p>
                    Findings must map to a verified line before they can enter a
                    GitHub draft.
                  </p>
                  {mapped === undefined ? null : (
                    <div className="mt-4 rounded-lg border p-3">
                      <p className="font-medium text-foreground">
                        Finding location
                      </p>
                      <p className="mt-1">
                        {mapped.mappingStatus === "mapped"
                          ? `${mapped.path}:${mapped.line ?? "hunk"}`
                          : "Unmapped and not postable"}
                      </p>
                    </div>
                  )}
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </header>
        <ReviewDiffView
          patch={patch}
          parsedFiles={parsedDiff.files}
          fileStatsByPath={parsedDiff.statsByPath}
          {...(selectedPath === undefined ? {} : { selectedPath })}
          preferences={preferences}
          collapsedPaths={collapsedPaths}
          onPreferencesChange={updatePreferences}
          onCollapsedPathsChange={setCollapsedPaths}
          {...(sourceSession === undefined ? {} : { sourceSession })}
        />
      </div>
    </section>
  );
}
