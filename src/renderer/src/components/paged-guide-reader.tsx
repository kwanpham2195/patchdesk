import { useMemo, useRef, useState } from "react";

import { ChevronsUpDown } from "lucide-react";

import { useGuideProgress } from "#src/renderer/src/hooks/use-guide-progress";
import { usePagedGuide } from "#src/renderer/src/hooks/use-paged-guide";
import type { GuideSummaryState } from "#src/renderer/src/hooks/use-guide-summary";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import {
  publishedGuideReviewDisabledReason,
  publishedGuideRevisionMatches,
} from "./guide-review-controls";
import {
  loadReviewViewPreferences,
  type ReviewViewPreferences,
} from "@/review-view-preferences";
import { GuideReadingSaveError } from "./guide-reader";
import { GuideMinimap } from "./guide-minimap";
import { useGuideReadingPosition } from "./guide-reading-position";
import { InlineError } from "./ui/inline-error";
import { PagedGuideSections } from "./paged-guide-sections";
import {
  ReviewDiffOptionRow,
  ReviewDiffOptionsPopover,
} from "./review-diff-options-popover";
import type { WalkthroughDiffAuthoring } from "./walkthrough-diff-authoring";

/**
 * Reads the published Guide through bounded pages. Group text, members and Others arrive as separate small requests;
 * nothing here holds the patch or the whole inventory, and Others is the list the worker stored. File rows expand the
 * Review's own diff block and open the same file in the Diff tab by path.
 */
export function PagedGuideReader({
  profileId,
  reviewId,
  workbench,
  summaryState,
  empty,
  preferences,
  diffAuthoring,
  onOpenFileInDiff,
}: {
  readonly profileId: string;
  readonly reviewId: string;
  readonly workbench: WorkbenchResponse;
  readonly summaryState: GuideSummaryState;
  /** Shown when no Guide is published yet. */
  readonly empty: React.ReactNode;
  readonly preferences?: ReviewViewPreferences;
  readonly diffAuthoring?: WalkthroughDiffAuthoring;
  readonly onOpenFileInDiff?: (path: string) => void;
}): React.JSX.Element {
  const identity = useMemo(
    () => ({ profileId, reviewId }),
    [profileId, reviewId],
  );
  const paged = usePagedGuide(identity, summaryState);
  const { guide } = paged;
  const summary = guide.status === "ready" ? guide.summary : undefined;
  const outdated =
    summary !== undefined && !publishedGuideRevisionMatches(workbench, summary);
  const openDisabled = publishedGuideReviewDisabledReason(workbench, summary);
  const fileControls =
    openDisabled === undefined
      ? { onOpenFileInDiff, diffAuthoring }
      : { onOpenFileInDiff: undefined, diffAuthoring: undefined };
  const reading = useGuideProgress(identity, outdated ? undefined : summary);
  const root = useRef<HTMLDivElement>(null);
  useGuideReadingPosition(root, paged.positionReady ? reading : undefined);
  const [viewPreferences, setViewPreferences] = useState(
    () => preferences ?? loadReviewViewPreferences(),
  );
  const changeViewPreferences = (
    update: Partial<ReviewViewPreferences>,
  ): void => setViewPreferences((current) => ({ ...current, ...update }));
  const reviewed = useMemo(
    () => new Set<string>(reading?.progress.reviewedGroupIds),
    [reading?.progress.reviewedGroupIds],
  );
  const minimapGroups = useMemo(() => {
    if (guide.status !== "ready") return [];
    const pathOf = (
      file: {
        readonly status: string;
        readonly oldPath: string;
        readonly newPath: string;
      } | null,
      fileId: string,
    ) =>
      file === null
        ? fileId
        : file.status === "removed"
          ? file.oldPath
          : file.newPath;
    return [
      ...guide.groups.map((group) => ({
        id: group.id,
        title: group.title,
        explanation: group.explanationText,
        reviewed: reviewed.has(group.id),
        files: group.members.map((member) => ({
          id: member.fileId,
          path: pathOf(member.file, member.fileId),
        })),
      })),
      ...(guide.others.length === 0
        ? []
        : [
            {
              id: "others",
              title: "Others",
              explanation: "Changed files outside the Guide's groups.",
              files: guide.others.map((other) => ({
                id: other.fileId,
                path: pathOf(other.file, other.fileId),
              })),
            },
          ]),
    ];
  }, [guide, reviewed]);

  if (guide.status === "loading")
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading Guide…
      </p>
    );
  if (guide.status === "none") return <>{guide.run === null ? empty : null}</>;
  if (guide.status === "failed")
    return (
      <InlineError>
        The Guide could not be read. Its stored result is unchanged; reopen the
        Review to retry.
      </InlineError>
    );
  const source = { profileId, reviewId, digest: guide.summary.digest };
  const completeness = guide.summary.completeness;
  const contextNotice =
    Math.max(
      completeness.knownOmittedChecks,
      completeness.knownOmittedThreads,
      completeness.knownOmittedRules,
    ) > 0
      ? "Partial source context"
      : {
          complete: null,
          partial: "Partial source context",
          unknown: "Source context completeness unknown",
        }[completeness.upstreamCompleteness];
  return (
    <div
      aria-label="Guide"
      data-guide-reader
      className="@container flex h-full min-h-0 min-w-0 flex-col"
    >
      <GuideReadingSaveError reading={reading} />
      <div className="mb-2 flex shrink-0 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <p>
            {guide.summary.groups} groups ·{" "}
            {guide.summary.inventory - guide.summary.others} of{" "}
            {guide.summary.inventory} files in groups
            {reading === undefined
              ? null
              : ` · ${guide.groups.filter((group) => reviewed.has(group.id)).length}/${guide.summary.groups} reviewed`}
          </p>
          {contextNotice === null ? null : <p role="note">{contextNotice}</p>}
          {openDisabled === undefined ? null : (
            <p role="note">{openDisabled}</p>
          )}
        </div>
        <ReviewDiffOptionsPopover
          preferences={viewPreferences}
          onPreferencesChange={changeViewPreferences}
        >
          <ReviewDiffOptionRow
            icon={<ChevronsUpDown aria-hidden="true" />}
            label="Full context"
            checked={false}
            disabledReason="Only the Review's patch context is available in Guide."
            onCheckedChange={() => undefined}
          />
        </ReviewDiffOptionsPopover>
      </div>
      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-4 @min-[48rem]:grid-cols-[3rem_minmax(0,1fr)] @min-[48rem]:grid-rows-[minmax(0,1fr)]">
        <GuideMinimap root={root} groups={minimapGroups} />
        <div
          data-guide-viewport
          className="min-h-0 min-w-0 overflow-auto [container-type:size]"
        >
          <div ref={root}>
            <PagedGuideSections
              guide={guide}
              paged={paged}
              source={source}
              reading={reading}
              reviewed={reviewed}
              viewPreferences={viewPreferences}
              changeViewPreferences={changeViewPreferences}
              {...fileControls}
              openDisabled={openDisabled}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
