import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import {
  ArrowLeft,
  BookOpenCheck,
  CheckCircle2,
  CircleAlert,
  ChevronDown,
  FileText,
  Square,
  Star,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { walkthroughCopy } from "@/review-copy";
import type { ReviewViewPreferences } from "@/review-view-preferences";

import { NarrativeWalkthroughDiff } from "./narrative-walkthrough-diff";
import type { ReviewInlineAnnotation } from "./review-diff-view";
import type { ReviewDiffSourceSession } from "@/hooks/use-review-diff-hydration";

type NarrativeHunk = {
  readonly id: string;
  readonly path: string;
  readonly header: string;
  readonly raw: string;
  readonly filePrefix?: string | undefined;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
};
type NarrativeSection = {
  readonly id: string;
  readonly title: string;
  readonly prose: string;
  readonly hunkIds: ReadonlyArray<string>;
  readonly hunks: ReadonlyArray<NarrativeHunk>;
};
type NarrativeWalkthroughModel = {
  readonly snapshot: {
    readonly profileId: string;
    readonly sessionId: string;
    readonly headSha: string;
    readonly patchHash: string;
  };
  readonly title: string;
  readonly focus: string;
  readonly chapters: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly sections: ReadonlyArray<NarrativeSection>;
  }>;
  readonly support: {
    readonly id: "support";
    readonly title: "Support";
    readonly hunkIds: ReadonlyArray<string>;
    readonly hunks: ReadonlyArray<NarrativeHunk>;
  };
};

export type NarrativeWalkthroughActions = {
  readonly onBackToFiles: () => void;
  readonly onMarkSectionReviewed: (sectionId: string) => void;
  readonly onMarkSupportReviewed: () => void;
  readonly onSelectSection: (sectionId: string) => void;
};

export type NarrativeWalkthroughRefAction = {
  readonly focusBackToFiles: () => void;
  readonly focusCurrentSection: () => void;
};

export function NarrativeWalkthrough({
  walkthrough,
  reviewedSectionIds,
  supportReviewed,
  currentSectionId,
  onActionRef,
  actions,
  preferences,
  rawPatch,
  sourceSession,
  annotations,
}: {
  readonly walkthrough: NarrativeWalkthroughModel;
  readonly reviewedSectionIds: ReadonlyArray<string>;
  readonly supportReviewed: boolean;
  readonly currentSectionId?: string;
  readonly rawPatch?: string;
  readonly sourceSession?: ReviewDiffSourceSession;
  readonly annotations?: ReadonlyArray<ReviewInlineAnnotation>;
  readonly onActionRef?: (ref: NarrativeWalkthroughRefAction) => void;
  readonly actions: NarrativeWalkthroughActions;
  readonly preferences?: ReviewViewPreferences;
}): React.JSX.Element {
  const sections = useMemo(
    () => walkthrough.chapters.flatMap((chapter) => chapter.sections),
    [walkthrough.chapters],
  );
  const [localCurrentSectionId, setLocalCurrentSectionId] = useState(
    currentSectionId ?? sections[0]?.id,
  );
  useEffect(() => {
    if (currentSectionId !== undefined)
      setLocalCurrentSectionId(currentSectionId);
  }, [currentSectionId]);
  const sectionIndex = useMemo(
    () =>
      Math.max(
        0,
        sections.findIndex((section) => section.id === localCurrentSectionId),
      ),
    [localCurrentSectionId, sections],
  );
  const fallbackSection = sections[0] as NarrativeSection | undefined;
  const activeSection: NarrativeSection =
    sections[sectionIndex] ?? fallbackSection ?? nullSection();
  const [supportOpen, setSupportOpen] = useState(false);
  const backToFilesButtonRef = useRef<HTMLButtonElement>(null);
  const sectionHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (onActionRef === undefined) return;
    onActionRef({
      focusBackToFiles: () =>
        backToFilesButtonRef.current?.focus({ preventScroll: false }),
      focusCurrentSection: () =>
        sectionHeadingRef.current?.focus({ preventScroll: false }),
    });
  }, [onActionRef, activeSection.id]);

  const reviewedSet = useMemo(
    () => new Set(reviewedSectionIds),
    [reviewedSectionIds],
  );
  const canGoPrev = sectionIndex > 0;
  const canGoNext = sectionIndex >= 0 && sectionIndex < sections.length - 1;

  const focusHeading = useCallback(() => {
    sectionHeadingRef.current?.focus();
  }, []);

  const focusHeadingAfterMoveRef = useRef(false);
  const selectSection = useCallback(
    (sectionId: string) => {
      focusHeadingAfterMoveRef.current = true;
      setLocalCurrentSectionId(sectionId);
      actions.onSelectSection(sectionId);
    },
    [actions],
  );
  const goToOffset = useCallback(
    (offset: -1 | 1) => {
      const target = sections[sectionIndex + offset];
      if (target === undefined) return;
      selectSection(target.id);
    },
    [sectionIndex, sections, selectSection],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
        const role = target.getAttribute("role");
        if (role === "textbox" || role === "combobox") {
          return;
        }
      }
      if (event.key === "ArrowLeft" || event.key === "j") {
        event.preventDefault();
        if (canGoPrev) goToOffset(-1);
        return;
      }
      if (event.key === "ArrowRight" || event.key === "k") {
        event.preventDefault();
        if (canGoNext) goToOffset(1);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        backToFilesButtonRef.current?.focus();
      }
    },
    [canGoNext, canGoPrev, goToOffset],
  );

  useEffect(() => {
    if (!focusHeadingAfterMoveRef.current) return;
    focusHeadingAfterMoveRef.current = false;
    focusHeading();
  }, [activeSection.id, focusHeading]);

  const allHunks = useMemo(
    () => [
      ...sections.flatMap((section) => section.hunks),
      ...walkthrough.support.hunks,
    ],
    [sections, walkthrough.support.hunks],
  );

  return (
    <div
      data-walkthrough-takeover
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-card px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            ref={backToFilesButtonRef}
            variant="ghost"
            size="sm"
            data-testid="back-to-files"
            aria-label="Back to files"
            onClick={actions.onBackToFiles}
          >
            <ArrowLeft />
            Back to files
          </Button>
          <Separator orientation="vertical" className="h-5" />
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              Walkthrough · {walkthrough.title}
            </p>
            <p className="text-xs text-muted-foreground">
              Focus: {walkthrough.focus}
            </p>
          </div>
        </div>
        <Badge variant="outline">
          <BookOpenCheck />
          Reading
        </Badge>
      </header>
      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 min-[1280px]:grid-cols-[16rem_minmax(0,1fr)]">
        <aside
          role="region"
          aria-label="Walkthrough chapters"
          className="min-w-0 overflow-auto border-r bg-card p-3"
        >
          <h2 className="px-1 text-sm font-semibold">Chapters</h2>
          <p className="mt-1 px-1 text-xs text-muted-foreground">
            Persistent rail; arrow keys move sections.
          </p>
          <Separator className="my-3" />
          <ol className="flex flex-col gap-1" aria-label="Walkthrough sections">
            {walkthrough.chapters.flatMap((chapter) =>
              chapter.sections.map((section) => {
                const active = section.id === activeSection.id;
                const reviewed = reviewedSet.has(section.id);
                return (
                  <li key={section.id}>
                    <Button
                      type="button"
                      variant={active ? "secondary" : "ghost"}
                      size="sm"
                      className="h-auto w-full justify-between whitespace-normal px-2 py-2 text-left"
                      aria-current={active ? "true" : undefined}
                      onClick={() => selectSection(section.id)}
                    >
                      <span className="min-w-0">
                        <span className="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                          {chapter.title}
                        </span>
                        <span className="block text-sm font-medium leading-5">
                          {section.title}
                        </span>
                      </span>
                      {reviewed ? (
                        <Badge variant="outline" aria-label="Reviewed">
                          reviewed
                        </Badge>
                      ) : null}
                    </Button>
                  </li>
                );
              }),
            )}
          </ol>
          <Separator className="my-3" />
          <Collapsible open={supportOpen} onOpenChange={setSupportOpen}>
            <CollapsibleTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-between px-1"
                />
              }
            >
              <span className="min-w-0">Support</span>
              <ChevronDown
                data-disclosure-motion="chevron"
                className={supportOpen ? "size-4" : "size-4 -rotate-90"}
                aria-hidden="true"
              />
            </CollapsibleTrigger>
            <CollapsibleContent motion="disclosure" className="pt-2">
              <p className="px-1 text-xs text-foreground/85">
                Every hunk the model did not cover.
              </p>
              <ul
                className="mt-2 space-y-1 px-1 text-xs text-foreground/85"
                aria-label="Support hunks"
              >
                {walkthrough.support.hunks.map((hunk) => (
                  <li key={hunk.id} className="break-all">
                    {hunk.id} · {hunk.path}
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                variant={supportReviewed ? "secondary" : "outline"}
                size="sm"
                className="mt-3 w-full"
                aria-pressed={supportReviewed}
                onClick={actions.onMarkSupportReviewed}
              >
                <Square />
                {supportReviewed ? "Support reviewed" : "Mark Support reviewed"}
              </Button>
            </CollapsibleContent>
          </Collapsible>
        </aside>
        <ScrollArea
          role="region"
          aria-label="Walkthrough reading surface"
          className="min-h-0"
        >
          <article
            aria-label={`Section: ${activeSection.title}`}
            data-walkthrough-section-id={activeSection.id}
            className="flex min-h-0 min-w-0 flex-col gap-3 p-4"
          >
            <h3
              ref={sectionHeadingRef}
              tabIndex={-1}
              className="text-lg font-semibold outline-none"
            >
              {activeSection.title}
            </h3>
            <p className="text-sm text-muted-foreground">
              {activeSection.prose}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">
                <CircleAlert />
                {activeSection.hunks.length} hunk
                {activeSection.hunks.length === 1 ? "" : "s"}
              </Badge>
              {reviewedSet.has(activeSection.id) ? (
                <Badge variant="outline" aria-label="Reviewed">
                  reviewed
                </Badge>
              ) : null}
            </div>
            {activeSection.hunks.length === 0 ? (
              <Alert>
                <AlertTitle>This section has no supporting hunks.</AlertTitle>
                <AlertDescription>
                  Patchdesk routes every source hunk to a section or Support.
                </AlertDescription>
              </Alert>
            ) : (
              activeSection.hunks.map((hunk, index) => (
                <NarrativeWalkthroughDiff
                  key={`${activeSection.id}::${hunk.id}`}
                  blockId={`${activeSection.id}::${hunk.id}::${index}`}
                  {...(rawPatch === undefined ? {} : { patch: rawPatch })}
                  {...(sourceSession === undefined ? {} : { sourceSession })}
                  hunkIds={[hunk.id]}
                  hunks={[hunk]}
                  allHunks={allHunks}
                  {...(annotations === undefined ? {} : { annotations })}
                  {...(preferences === undefined ? {} : { preferences })}
                />
              ))
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={
                  reviewedSet.has(activeSection.id) ? "secondary" : "outline"
                }
                onClick={() =>
                  actions.onMarkSectionReviewed(activeSection.id)
                }
                disabled={reviewedSet.has(activeSection.id)}
                aria-pressed={reviewedSet.has(activeSection.id)}
              >
                <CheckCircle2 />
                {reviewedSet.has(activeSection.id)
                  ? "Section reviewed"
                  : "Mark section reviewed"}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => goToOffset(-1)}
                disabled={!canGoPrev}
                aria-label="Previous section"
              >
                <ArrowLeft />
                Previous section
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => goToOffset(1)}
                disabled={!canGoNext}
                aria-label="Next section"
              >
                Next section
                <ArrowLeft className="rotate-180" />
              </Button>
              <span
                className="text-xs text-muted-foreground"
                aria-label="Section progress"
              >
                {sectionIndex + 1} of {sections.length}
              </span>
            </div>
            <Separator />
            <Card>
              <CardHeader>
                <CardTitle>
                  <FileText />
                  Support coverage
                </CardTitle>
                <CardDescription>
                  {walkthrough.support.hunks.length} hunk
                  {walkthrough.support.hunks.length === 1 ? "" : "s"} not
                  covered by the model.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {walkthrough.support.hunks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Every source hunk is in a section.
                  </p>
                ) : (
                  <div className="space-y-2">
                    <ul className="space-y-1 text-sm">
                      {walkthrough.support.hunks.map((hunk) => (
                        <li key={hunk.id} className="break-all">
                          <code className="font-mono text-xs">{hunk.id}</code> ·{" "}
                          {hunk.path}
                        </li>
                      ))}
                    </ul>
                    {walkthrough.support.hunks.map((hunk, index) => (
                      <NarrativeWalkthroughDiff
                        key={`support::${hunk.id}`}
                        blockId={`support::${hunk.id}::${index}`}
                        {...(rawPatch === undefined ? {} : { patch: rawPatch })}
                        {...(sourceSession === undefined
                          ? {}
                          : { sourceSession })}
                        hunkIds={[hunk.id]}
                        hunks={[hunk]}
                        allHunks={allHunks}
                        {...(annotations === undefined ? {} : { annotations })}
                        {...(preferences === undefined ? {} : { preferences })}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            <p
              className="text-xs text-muted-foreground"
              aria-label="Walkthrough copy"
            >
              {walkthroughCopy("ready").reassurance}
            </p>
            <Badge variant="secondary">
              <Star />
              {reviewedSet.size} of {sections.length} section
              {sections.length === 1 ? "" : "s"} reviewed
            </Badge>
          </article>
        </ScrollArea>
      </div>
    </div>
  );
}

function nullSection(): NarrativeSection {
  return {
    id: "section-empty",
    title: "Empty walkthrough",
    prose: "This snapshot produced no primary sections.",
    hunkIds: [],
    hunks: [],
  };
}
