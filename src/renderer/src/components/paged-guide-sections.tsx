import type { PagedGuideControls } from "#src/renderer/src/hooks/use-paged-guide";
import type { GuideReadingControls } from "#src/renderer/src/hooks/use-guide-reading-state";
import type { ReviewViewPreferences } from "@/review-view-preferences";
import { PagedGuideFileRow, PagedGuideGroupHeader } from "./paged-guide-group";
import { Button } from "./ui/button";
import type { WalkthroughDiffAuthoring } from "./walkthrough-diff-authoring";

/** Renders the published groups and Others with their paging and file appearance controls. */
export function PagedGuideSections({
  guide,
  paged,
  source,
  reading,
  reviewed,
  viewPreferences,
  changeViewPreferences,
  onOpenFileInDiff,
  diffAuthoring,
  openDisabled,
}: {
  readonly guide: Extract<PagedGuideControls["guide"], { status: "ready" }>;
  readonly paged: PagedGuideControls;
  readonly source: {
    readonly profileId: string;
    readonly reviewId: string;
    readonly digest: string;
  };
  readonly reading: GuideReadingControls | undefined;
  readonly reviewed: ReadonlySet<string>;
  readonly viewPreferences: ReviewViewPreferences;
  readonly changeViewPreferences: (
    update: Partial<ReviewViewPreferences>,
  ) => void;
  readonly onOpenFileInDiff: ((path: string) => void) | undefined;
  readonly diffAuthoring: WalkthroughDiffAuthoring | undefined;
  readonly openDisabled: string | undefined;
}): React.JSX.Element {
  return (
    <>
      <ol className="m-0 list-none divide-y border-y p-0">
        {guide.groups.map((group, index) => (
          <li
            key={group.id}
            data-guide-group={group.id}
            data-guide-minimap-group={group.id}
            className="grid min-w-0 gap-4 py-5 @min-[48rem]:grid-cols-[minmax(0,0.6fr)_minmax(0,1.4fr)]"
          >
            <PagedGuideGroupHeader
              id={group.id}
              index={index}
              total={guide.summary.groups}
              title={group.title}
              explanation={group.explanationText}
              hasMoreExplanation={group.explanationNext !== null}
              onLoadMoreExplanation={() => paged.loadMoreExplanation(group.id)}
              reviewed={reviewed.has(group.id)}
              {...(reading === undefined ? {} : { reading })}
            />
            <div className="min-w-0 space-y-2">
              <ul
                aria-label={`${group.title} files`}
                className="min-w-0 space-y-2"
              >
                {group.members.map((member) => (
                  <PagedGuideFileRow
                    key={member.fileId}
                    fileId={member.fileId}
                    groupId={group.id}
                    file={member.file}
                    relevance={member.relevance.text}
                    source={source}
                    preferences={viewPreferences}
                    onPreferencesChange={changeViewPreferences}
                    {...(reading === undefined ? {} : { reading })}
                    {...(onOpenFileInDiff === undefined
                      ? {}
                      : { onOpenInDiff: onOpenFileInDiff })}
                    {...(diffAuthoring === undefined ? {} : { diffAuthoring })}
                    {...(openDisabled === undefined
                      ? {}
                      : { disabledReason: openDisabled })}
                  />
                ))}
              </ul>
              {group.membersLoaded ? null : (
                <p role="status" className="text-xs text-muted-foreground">
                  Loading files…
                </p>
              )}
              {group.membersNext === null ? null : (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => paged.loadMoreMembers(group.id)}
                >
                  Show more files ({group.memberCount - group.members.length}{" "}
                  remaining)
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>
      <section
        aria-labelledby="guide-others"
        data-guide-minimap-group="others"
        className="grid min-w-0 gap-4 py-5 @min-[48rem]:grid-cols-[minmax(0,0.6fr)_minmax(0,1.4fr)]"
      >
        <div className="min-w-0 space-y-2">
          <h3 id="guide-others" className="text-base font-semibold">
            Others · {guide.summary.others}{" "}
            {guide.summary.others === 1 ? "file" : "files"}
          </h3>
          <p className="text-sm text-muted-foreground">
            Changed files outside the Guide's groups.
          </p>
        </div>
        {guide.summary.others === 0 ? (
          <p className="text-sm text-muted-foreground">
            Every changed file appears in a group.
          </p>
        ) : (
          <div className="min-w-0 space-y-2">
            <ul aria-label="Others files" className="min-w-0 space-y-2">
              {guide.others.map((other) => (
                <PagedGuideFileRow
                  key={other.fileId}
                  fileId={other.fileId}
                  groupId="others"
                  file={other.file}
                  source={source}
                  preferences={viewPreferences}
                  onPreferencesChange={changeViewPreferences}
                  {...(reading === undefined ? {} : { reading })}
                  {...(onOpenFileInDiff === undefined
                    ? {}
                    : { onOpenInDiff: onOpenFileInDiff })}
                  {...(diffAuthoring === undefined ? {} : { diffAuthoring })}
                  {...(openDisabled === undefined
                    ? {}
                    : { disabledReason: openDisabled })}
                />
              ))}
            </ul>
            {guide.othersNext === null ? null : (
              <Button
                size="xs"
                variant="outline"
                onClick={paged.loadMoreOthers}
              >
                Show more files ({guide.summary.others - guide.others.length}{" "}
                remaining)
              </Button>
            )}
          </div>
        )}
      </section>
    </>
  );
}
