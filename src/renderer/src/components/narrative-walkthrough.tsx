import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { ArrowLeft, CheckCircle2, CircleAlert, Focus } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { WalkthroughPage } from "#src/domain/walkthrough-progress";

export type NarrativeWalkthroughActions = {
  /** Absent on a merged or closed Review: reviewed marks stay visible but cannot change. */
  readonly onToggleSectionReviewed?: (sectionId: string) => void;
  readonly onSelectSection: (sectionId: string) => void;
};

/** The reading layout receives only counts, one navigation window and the active section. */
// react-doctor-disable-next-line react-doctor/no-giant-component -- Existing layout exception: paging shrinks this component while keeping its keyboard and focus owner intact.
export function NarrativeWalkthrough({
  counts,
  navigation,
  activeSection,
  evidence,
  onNavigationPage,
  actions,
  onOpenDiff,
  discussionUnavailable,
  focused = false,
  onFocusedChange,
}: {
  readonly counts: {
    readonly sections: number;
    readonly reviewed: number;
    readonly citedHunks: number;
    readonly hunks: number;
    readonly uncited: number;
  };
  readonly navigation: Extract<WalkthroughPage, { kind: "navigation" }>;
  readonly activeSection: Extract<WalkthroughPage, { kind: "section" }> | null;
  readonly evidence: React.ReactNode;
  readonly onNavigationPage: (cursor: string | null) => void;
  readonly onOpenDiff?: () => void;
  readonly discussionUnavailable?: "stale" | "loading";
  readonly focused?: boolean;
  readonly onFocusedChange?: (focused: boolean) => void;
  readonly actions: NarrativeWalkthroughActions;
}): React.JSX.Element {
  const chapters = useMemo(() => {
    const grouped = new Map<
      string,
      {
        id: string;
        title: string;
        sections: Extract<WalkthroughPage, { kind: "navigation" }>["items"];
      }
    >();
    for (const item of navigation.items) {
      const chapter = grouped.get(item.chapter.id) ?? {
        ...item.chapter,
        sections: [],
      };
      chapter.sections.push(item);
      grouped.set(chapter.id, chapter);
    }
    return [...grouped.values()];
  }, [navigation]);
  const sectionHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusToggleRef = useRef<HTMLButtonElement>(null);
  const restoreFocusAfterExitRef = useRef(false);
  const sectionButtonRefs = useRef<Record<string, HTMLButtonElement | null>>(
    {},
  );

  const sectionPosition =
    activeSection === null ? 0 : activeSection.ordinal + 1;
  const canGoPrev = activeSection?.previous != null;
  const canGoNext = activeSection?.next != null;

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
      actions.onSelectSection(sectionId);
    },
    [actions],
  );
  const goToOffset = useCallback(
    (offset: -1 | 1) => {
      const target =
        offset === -1 ? activeSection?.previous : activeSection?.next;
      if (target == null) return;
      selectSection(target);
    },
    [activeSection, selectSection],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
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
      if (event.key === "ArrowLeft" || event.key === "k") {
        event.preventDefault();
        if (canGoPrev) goToOffset(-1);
        return;
      }
      if (event.key === "ArrowRight" || event.key === "j") {
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
    if (activeSection === null) return;
    const sectionButton = sectionButtonRefs.current[activeSection.sectionId];
    if (scrollSectionAfterMoveRef.current) {
      scrollSectionAfterMoveRef.current = false;
      sectionButton?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    }
    if (focusHeadingAfterMoveRef.current) {
      focusHeadingAfterMoveRef.current = false;
      focusHeading();
    }
  }, [activeSection, focusHeading]);

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
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
              <h2 className="text-sm font-semibold">Chapters</h2>
              <span
                role="status"
                aria-label="Walkthrough progress"
                data-walkthrough-progress
                className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground"
              >
                {sectionPosition}/{counts.sections} · {counts.reviewed} of{" "}
                {counts.sections} reviewed
              </span>
            </div>
            <Separator className="my-1.5" />
            <ol
              className="flex min-w-0 flex-col gap-3"
              aria-label="Walkthrough sections"
            >
              {chapters.map((chapter) => (
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
                    {chapter.sections.map((section) => {
                      const active =
                        section.sectionId === activeSection?.sectionId;
                      const reviewed = section.reviewed;
                      return (
                        <li key={section.sectionId} className="min-w-0">
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  ref={(node) => {
                                    if (node === null)
                                      delete sectionButtonRefs.current[
                                        section.sectionId
                                      ];
                                    else
                                      sectionButtonRefs.current[
                                        section.sectionId
                                      ] = node;
                                  }}
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className={cn(
                                    "h-auto min-h-7 min-w-0 w-full justify-start gap-2 rounded-md px-2 py-1 text-left text-xs leading-4",
                                    active &&
                                      "border-l-2 border-transparent border-l-primary bg-muted pl-[6px] font-semibold text-foreground",
                                  )}
                                  aria-current={active ? "true" : undefined}
                                  title={section.title}
                                  onClick={() =>
                                    selectSection(section.sectionId)
                                  }
                                />
                              }
                            >
                              <span
                                aria-hidden="true"
                                className="w-4 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground"
                              >
                                {String(section.ordinal + 1).padStart(2, "0")}
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
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={navigation.previous === null}
                onClick={() => onNavigationPage(navigation.previous)}
              >
                Previous chapters
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={navigation.next === null}
                onClick={() => onNavigationPage(navigation.next)}
              >
                More chapters
              </Button>
            </div>
            <Separator className="my-1.5" />
            <div className="space-y-2 px-1">
              <p
                role="status"
                aria-label="Walkthrough hunk coverage"
                className="text-xs text-muted-foreground"
              >
                {counts.citedHunks} of {counts.hunks} hunks cited in the reading
                path. {counts.uncited} {counts.uncited === 1 ? "hunk" : "hunks"}{" "}
                not explained in the reading path.
              </p>
              {onOpenDiff === undefined ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onOpenDiff}
                >
                  Open Diff
                </Button>
              )}
            </div>
          </aside>
        )}
        <ScrollArea
          role="region"
          aria-label="Walkthrough reading surface"
          data-walkthrough-reader
          className="h-full min-h-0 min-w-0 flex-1 overflow-hidden"
        >
          {activeSection === null ? (
            <p role="status">
              {counts.sections === 0 ? "Empty walkthrough" : "Loading section…"}
            </p>
          ) : (
            <article
              aria-label={`Section: ${activeSection.title}`}
              data-walkthrough-section-id={activeSection.sectionId}
              className="flex min-h-full min-w-0 flex-col gap-3 p-4"
            >
              <p
                className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground"
                title={activeSection.chapter.title}
              >
                CHAPTER · {activeSection.chapter.title}
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
              {discussionUnavailable === undefined ? null : (
                <p role="status" className="text-sm text-muted-foreground">
                  {discussionUnavailable === "stale"
                    ? "Older revision; regenerate to see replies."
                    : "Discussion unavailable; refresh to check."}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">
                  <CircleAlert />
                  {activeSection.citationCount} hunk
                  {activeSection.citationCount === 1 ? "" : "s"}
                </Badge>
                {activeSection.reviewed ? (
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
              {activeSection.citationCount === 0 ? (
                <Alert>
                  <AlertTitle>No verified hunks for this section</AlertTitle>
                  <AlertDescription>
                    Regenerate to restore citations, or review the full Diff.
                  </AlertDescription>
                </Alert>
              ) : (
                evidence
              )}
              {counts.sections === 0 ||
              (actions.onToggleSectionReviewed === undefined &&
                !activeSection.reviewed) ? null : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant={activeSection.reviewed ? "secondary" : "outline"}
                    onClick={() =>
                      actions.onToggleSectionReviewed?.(activeSection.sectionId)
                    }
                    disabled={actions.onToggleSectionReviewed === undefined}
                    aria-pressed={activeSection.reviewed}
                  >
                    <CheckCircle2 />
                    {activeSection.reviewed
                      ? "Section reviewed"
                      : "Mark section reviewed"}
                  </Button>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {counts.sections <= 1 ? null : (
                  <>
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
                  </>
                )}
                {focused ? (
                  <span
                    role="status"
                    className="text-xs text-muted-foreground"
                    aria-label="Section position"
                  >
                    {sectionPosition} of {counts.sections}
                  </span>
                ) : null}
              </div>
            </article>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}
