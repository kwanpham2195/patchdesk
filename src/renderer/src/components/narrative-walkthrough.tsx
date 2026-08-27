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
  CheckCircle2,
  CircleAlert,
  ChevronDown,
  Focus,
  Square,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { walkthroughCopy } from "@/review-copy";
import type { ReviewViewPreferences } from "@/review-view-preferences";
import { cn } from "@/lib/utils";

import { NarrativeWalkthroughDiff } from "./narrative-walkthrough-diff";
import type { ReadOnlyConversationAnnotation } from "../inline-conversation-mapping";
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
  readonly citationStatus: "verified" | "partially_verified" | "unverified";
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
  readonly onMarkSectionReviewed: (sectionId: string) => void;
  readonly onMarkSupportReviewed: () => void;
  readonly onSelectSection: (sectionId: string) => void;
};

// NarrativeWalkthrough shows the guided review: the chapter dock, the prose
// and diff hunks of the open section, the reviewed marks, and the keyboard
// moves between sections.
// The file is just over 600 lines. No split of this component is scheduled,
// and the file stays under the 1,000-line ratchet, so nothing holds it at this
// size.
// react-doctor reads staged files. It reported this component when a lint fix
// put the file in a commit. The component did not grow.
// react-doctor-disable-next-line react-doctor/no-giant-component -- see comment above
export function NarrativeWalkthrough({
  walkthrough,
  reviewedSectionIds,
  supportReviewed,
  currentSectionId,
  actions,
  preferences,
  rawPatch,
  sourceSession,
  annotations,
  discussionUnavailable,
  focused = false,
  onFocusedChange,
}: {
  readonly walkthrough: NarrativeWalkthroughModel;
  readonly reviewedSectionIds: ReadonlyArray<string>;
  readonly supportReviewed: boolean;
  readonly currentSectionId?: string;
  readonly rawPatch?: string;
  readonly sourceSession?: ReviewDiffSourceSession;
  readonly annotations?: ReadonlyArray<ReadOnlyConversationAnnotation>;
  readonly discussionUnavailable?: boolean;
  readonly focused?: boolean;
  readonly onFocusedChange?: (focused: boolean) => void;
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
  const fallbackSection = sections[0];
  const activeSection: NarrativeSection =
    sections[sectionIndex] ?? fallbackSection ?? nullSection();
  const activeChapter = useMemo(
    () =>
      walkthrough.chapters.find((chapter) =>
        chapter.sections.some((section) => section.id === activeSection.id),
      ),
    [activeSection.id, walkthrough.chapters],
  );
  const [supportOpen, setSupportOpen] = useState(false);
  const sectionHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusToggleRef = useRef<HTMLButtonElement>(null);
  const restoreFocusAfterExitRef = useRef(false);
  const sectionButtonRefs = useRef<Record<string, HTMLButtonElement | null>>(
    {},
  );

  const reviewedSet = useMemo(
    () => new Set(reviewedSectionIds),
    [reviewedSectionIds],
  );
  const canGoPrev = sectionIndex > 0;
  const canGoNext = sectionIndex >= 0 && sectionIndex < sections.length - 1;

  const focusHeading = useCallback(() => {
    sectionHeadingRef.current?.focus();
  }, []);

  const requestFocusChange = useCallback(
    (next: boolean) => {
      if (!next) restoreFocusAfterExitRef.current = true;
      onFocusedChange?.(next);
    },
    [onFocusedChange],
  );

  useEffect(() => {
    if (focused || !restoreFocusAfterExitRef.current) return;
    restoreFocusAfterExitRef.current = false;
    focusToggleRef.current?.focus();
  }, [focused]);

  const focusHeadingAfterMoveRef = useRef(false);
  const scrollSectionAfterMoveRef = useRef(false);
  const selectSection = useCallback(
    (sectionId: string) => {
      focusHeadingAfterMoveRef.current = true;
      scrollSectionAfterMoveRef.current = true;
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
        if (focused) {
          requestFocusChange(false);
          return;
        }
        focusHeading();
      }
    },
    [
      canGoNext,
      canGoPrev,
      focusHeading,
      focused,
      goToOffset,
      requestFocusChange,
    ],
  );

  useEffect(() => {
    if (!focusHeadingAfterMoveRef.current && !scrollSectionAfterMoveRef.current)
      return;
    const sectionButton = sectionButtonRefs.current[activeSection.id];
    if (scrollSectionAfterMoveRef.current) {
      scrollSectionAfterMoveRef.current = false;
      sectionButton?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    }
    if (focusHeadingAfterMoveRef.current) {
      focusHeadingAfterMoveRef.current = false;
      focusHeading();
    }
  }, [activeSection.id, focusHeading]);

  const allHunks = useMemo(
    () => [
      ...sections.flatMap((section) => section.hunks),
      ...walkthrough.support.hunks,
    ],
    [sections, walkthrough.support.hunks],
  );
  const reviewedCount = sections.filter((section) =>
    reviewedSet.has(section.id),
  ).length;

  return (
    <div
      role="region"
      aria-label="Review walkthrough"
      data-walkthrough-takeover
      data-walkthrough-layout={focused ? "focused" : "docked"}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div
        data-walkthrough-stage
        className={cn(
          "flex h-full min-h-0 min-w-0 flex-1 flex-col min-[1280px]:grid",
          focused
            ? "min-[1280px]:grid-cols-1"
            : "min-[1280px]:grid-cols-[16rem_minmax(0,1fr)]",
        )}
      >
        {focused ? null : (
          <aside
            role="region"
            aria-label="Walkthrough chapters"
            data-walkthrough-chapter-dock
            className="max-h-40 min-h-0 min-w-0 shrink-0 overflow-y-auto border-b bg-card px-3 py-2 min-[1280px]:max-h-none min-[1280px]:border-r min-[1280px]:border-b-0"
          >
            <div className="flex items-baseline justify-between gap-2 px-1">
              <h2 className="text-sm font-semibold">Chapters</h2>
              <span
                role="status"
                aria-label="Walkthrough progress"
                data-walkthrough-progress
                className="text-[11px] tabular-nums text-muted-foreground"
              >
                {sectionIndex + 1}/{sections.length} · {reviewedCount} of{" "}
                {sections.length} section
                {sections.length === 1 ? "" : "s"} reviewed
              </span>
            </div>
            <Separator className="my-1.5" />
            <ol
              className="flex min-w-0 flex-col gap-3"
              aria-label="Walkthrough sections"
            >
              {walkthrough.chapters.map((chapter) => (
                <li key={chapter.id} className="min-w-0">
                  <h3
                    className="truncate px-1 text-[11px] font-semibold text-muted-foreground"
                    title={chapter.title}
                  >
                    {chapter.title}
                  </h3>
                  <ol
                    className="mt-1 flex min-w-0 flex-col gap-0.5 border-l border-border/60 pl-2"
                    aria-label={`${chapter.title} sections`}
                  >
                    {chapter.sections.map((section, chapterSectionIndex) => {
                      const active = section.id === activeSection.id;
                      const reviewed = reviewedSet.has(section.id);
                      return (
                        <li key={section.id} className="min-w-0">
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  ref={(node) => {
                                    sectionButtonRefs.current[section.id] =
                                      node;
                                  }}
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className={cn(
                                    "h-auto min-h-7 min-w-0 w-full justify-start gap-2 rounded-md px-2 py-1 text-left text-xs leading-4",
                                    active &&
                                      "border-l-2 border-primary bg-muted pl-[6px] font-semibold text-foreground",
                                  )}
                                  aria-current={active ? "true" : undefined}
                                  title={section.title}
                                  onClick={() => selectSection(section.id)}
                                />
                              }
                            >
                              <span
                                aria-hidden="true"
                                className="w-4 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground"
                              >
                                {String(chapterSectionIndex + 1).padStart(
                                  2,
                                  "0",
                                )}
                              </span>
                              <span className="min-w-0 flex-1 truncate">
                                {section.title}
                              </span>
                              {reviewed ? (
                                <Badge
                                  variant="outline"
                                  className="h-4 px-1 text-[10px]"
                                  aria-label="Reviewed"
                                >
                                  done
                                </Badge>
                              ) : null}
                            </TooltipTrigger>
                            <TooltipContent
                              side="right"
                              align="start"
                              className="max-w-80"
                            >
                              {section.title}
                            </TooltipContent>
                          </Tooltip>
                        </li>
                      );
                    })}
                  </ol>
                </li>
              ))}
            </ol>
            <Separator className="my-1.5" />
            <Collapsible open={supportOpen} onOpenChange={setSupportOpen}>
              <CollapsibleTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-full justify-between px-1 text-xs"
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
                <p className="walkthrough-support-copy px-1 text-xs">
                  {walkthrough.support.hunks.length} supporting or mechanical
                  hunk
                  {walkthrough.support.hunks.length === 1 ? "" : "s"} outside
                  the reading path.
                </p>
                <ul
                  className="walkthrough-support-copy mt-2 max-h-48 overflow-y-auto px-1 text-xs"
                  aria-label="Support hunks"
                >
                  {walkthrough.support.hunks.map((hunk) => (
                    <li key={hunk.id} className="break-all py-0.5">
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
                  {supportReviewed
                    ? "Support reviewed"
                    : "Mark Support reviewed"}
                </Button>
              </CollapsibleContent>
            </Collapsible>
          </aside>
        )}
        <ScrollArea
          role="region"
          aria-label="Walkthrough reading surface"
          data-walkthrough-reader
          className="h-full min-h-0 min-w-0 flex-1 overflow-hidden"
        >
          <article
            aria-label={`Section: ${activeSection.title}`}
            data-walkthrough-section-id={activeSection.id}
            className="flex min-h-full min-w-0 flex-col gap-3 p-4"
          >
            <p
              className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground"
              title={activeChapter?.title ?? "Walkthrough"}
            >
              CHAPTER · {activeChapter?.title ?? "Walkthrough"}
            </p>
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
            {discussionUnavailable ? (
              <p role="status" className="text-sm text-muted-foreground">
                Inline discussion is unavailable or incomplete. Refresh GitHub
                state to check for replies.
              </p>
            ) : null}
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
              {onFocusedChange === undefined ? null : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        ref={focusToggleRef}
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        aria-label={focused ? "Exit focus" : "Focus section"}
                        aria-pressed={focused}
                        onClick={() => requestFocusChange(!focused)}
                      />
                    }
                  >
                    <Focus aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent>
                    {focused ? "Exit focus" : "Focus section"}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            {walkthrough.citationStatus === "verified" ? null : (
              <Alert>
                <AlertTitle>Diff citations need regeneration.</AlertTitle>
                <AlertDescription>
                  This retained Walkthrough predates verified hunk aliases, so
                  Patchdesk keeps its prose but withholds ungrounded diff links.
                  Run it again to rebuild evidence from the alias manifest.
                </AlertDescription>
              </Alert>
            )}
            {activeSection.hunks.length === 0 ? (
              <Alert>
                <AlertTitle>
                  This section has no verified supporting hunks.
                </AlertTitle>
                <AlertDescription>
                  Its prose is retained, while Patchdesk routes source hunks to
                  Support until a regenerated Walkthrough verifies the
                  citations.
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
                onClick={() => actions.onMarkSectionReviewed(activeSection.id)}
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
            <p
              className="text-xs text-muted-foreground"
              aria-label="Support coverage"
            >
              Support stays compact so it does not interrupt the Walkthrough.
              Browse its bounded list in the chapter rail, then return to Files
              for full diff navigation.
            </p>
            <p
              className="text-xs text-muted-foreground"
              aria-label="Walkthrough copy"
            >
              {walkthroughCopy("ready").reassurance}
            </p>
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
