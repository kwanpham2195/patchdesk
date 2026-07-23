import { useMemo, useState } from "react";
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

/** Read-only three-pane diff workbench with deterministic file and finding navigation. */
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
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const visibleFiles = files
    .map((file) => ({
      path: file.newPath,
      stats: parsedDiff.statsByPath.get(file.newPath) ?? {
        path: file.newPath,
        additions: 0,
        deletions: 0,
      },
    }))
    .filter((file) => file.path.toLowerCase().includes(query.toLowerCase()));
  const mapped =
    finding === undefined ? undefined : mapFindingLocation(files, finding);
  return (
    <section
      aria-label="Diff workbench"
      data-patch-bytes={patch.length}
      className={cn(
        "grid min-w-0 grid-cols-[15rem_minmax(0,1fr)_18rem] max-[1099px]:grid-cols-1",
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
              onSelect={setSelectedPath}
            />
          </TabsContent>
          <TabsContent
            value="findings"
            className="mt-3 text-sm text-muted-foreground"
          >
            {mapped?.mappingStatus === "mapped" && mapped.path !== undefined ? (
              <Button
                variant="outline"
                className="w-full justify-start"
                onClick={() => setSelectedPath(mapped.path)}
              >
                <LocateFixed />
                Go to mapped finding
              </Button>
            ) : (
              "No mapped finding selected."
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
          <div className="hidden shrink-0 gap-2 max-[1099px]:flex">
            <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
              <SheetTrigger render={<Button variant="outline" size="sm" />}>
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
                          setSelectedPath(path);
                          setNavigationOpen(false);
                        }}
                      />
                    </TabsContent>
                    <TabsContent
                      value="findings"
                      className="mt-3 text-sm text-muted-foreground"
                    >
                      {mapped?.mappingStatus === "mapped" &&
                      mapped.path !== undefined ? (
                        <Button
                          variant="outline"
                          className="w-full justify-start"
                          onClick={() => {
                            setSelectedPath(mapped.path);
                            setNavigationOpen(false);
                          }}
                        >
                          <LocateFixed />
                          Go to mapped finding
                        </Button>
                      ) : (
                        "No mapped finding selected."
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
          onPreferencesChange={(update) =>
            setPreferences((current) => ({ ...current, ...update }))
          }
          onCollapsedPathsChange={setCollapsedPaths}
          {...(sourceSession === undefined ? {} : { sourceSession })}
        />
      </div>
      <aside
        aria-label="Review context"
        className="border-l bg-card p-4 max-[1099px]:hidden"
      >
        <h2 className="font-semibold">Review context</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The diff is local and read-only. Findings must map to a verified line
          before they can enter a GitHub draft.
        </p>
        {mapped === undefined ? null : (
          <div className="mt-4 rounded-lg border p-3 text-sm">
            <p className="font-medium">Finding location</p>
            <p className="mt-1 text-muted-foreground">
              {mapped.mappingStatus === "mapped"
                ? `${mapped.path}:${mapped.line ?? "hunk"}`
                : "Unmapped and not postable"}
            </p>
          </div>
        )}
      </aside>
    </section>
  );
}
