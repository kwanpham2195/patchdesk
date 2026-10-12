import { useMemo, useRef, useState } from "react";
import type { GuideReadingControls } from "#src/renderer/src/hooks/use-guide-reading-state";
import { useGuideReadingPosition } from "./guide-reading-position";
import { Check, ChevronRight, ChevronsUpDown } from "lucide-react";
import {
  loadReviewViewPreferences,
  type ReviewViewPreferences,
} from "@/review-view-preferences";
import { FileViewedCheckbox } from "./review-diff-file-header";
import {
  ReviewDiffOptionRow,
  ReviewDiffOptionsPopover,
} from "./review-diff-options-popover";
import { GuideMinimap } from "./guide-minimap";
import {
  decomposeGuidePatch,
  type GuideFileEvidence,
} from "./guide-file-evidence";
import { GuideFileDiff } from "./guide-file-diff";
import {
  guideOthers,
  type GuideInventoryEntry,
  type RetainedGuide,
} from "#src/domain/guide";
import { GeneratedMarkdown } from "./generated-markdown";
import { Button } from "./ui/button";
import { InlineError } from "./ui/inline-error";
import type { WalkthroughDiffAuthoring } from "./walkthrough-diff-authoring";

/** The lifetime owner keeps a failed queue actionable even when its Guide reader is hidden. */
export function GuideReadingSaveError({
  reading,
}: {
  readonly reading: GuideReadingControls | undefined;
}): React.JSX.Element | null {
  if (reading === undefined || !reading.saveFailed) return null;
  return (
    <InlineError>
      Guide reading progress could not be saved.{" "}
      <Button size="xs" variant="outline" onClick={() => void reading.retry()}>
        Retry reading progress
      </Button>
    </InlineError>
  );
}

const evidenceLabels = {
  text: "",
  metadata: "Metadata only",
  binary: "Binary file",
  submodule: "Submodule change",
  omitted: "Diff omitted",
} satisfies Readonly<Record<GuideInventoryEntry["evidence"], string>>;

/** Continuous overview resolves memberships only from its retained inventory. */
export function GuideReader({
  guide,
  preferences,
  diffAuthoring,
  disabledReason,
  reading,
  viewedPaths,
}: {
  readonly reading?: GuideReadingControls;
  /** Combined marks remain readable when another Diff view disables mutation. */
  readonly viewedPaths?: ReadonlySet<string>;
  readonly guide: RetainedGuide;
  readonly preferences?: ReviewViewPreferences;
  readonly diffAuthoring?: WalkthroughDiffAuthoring;
  readonly disabledReason?: string;
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  useGuideReadingPosition(root, reading);
  const [viewPreferences, setViewPreferences] = useState(
    () => preferences ?? loadReviewViewPreferences(),
  );
  const changeViewPreferences = (
    update: Partial<ReviewViewPreferences>,
  ): void => setViewPreferences((current) => ({ ...current, ...update }));
  const files = useMemo(
    () => new Map(guide.inventory.map((file) => [file.id, file])),
    [guide],
  );
  const evidence = useMemo(() => decomposeGuidePatch(guide), [guide]);
  const others = useMemo(() => guideOthers(guide), [guide]);
  const reviewed = useMemo(
    () => new Set(reading?.progress.reviewedGroupIds),
    [reading?.progress.reviewedGroupIds],
  );
  const minimapGroups = useMemo(
    () => [
      ...guide.groups.map((group) => ({
        ...group,
        reviewed: reviewed.has(group.id),
        files: group.files.flatMap((membership) => {
          const file = files.get(membership.fileId);
          return file === undefined
            ? []
            : [
                {
                  id: file.id,
                  path: file.status === "removed" ? file.oldPath : file.newPath,
                },
              ];
        }),
      })),
      ...(others.length === 0
        ? []
        : [
            {
              id: "others",
              title: "Others",
              explanation: "Changed files outside the Guide's groups.",
              files: others.map((file) => ({
                id: file.id,
                path: file.status === "removed" ? file.oldPath : file.newPath,
              })),
            },
          ]),
    ],
    [guide.groups, files, reviewed, others],
  );
  return (
    <div
      aria-label="Guide"
      data-guide-reader
      className="@container flex h-full min-h-0 min-w-0 flex-col"
    >
      {disabledReason === undefined ? null : (
        <p role="note" className="mb-3 text-sm text-muted-foreground">
          {disabledReason}
        </p>
      )}
      {diffAuthoring?.viewedFiles?.saveFailed ? (
        <InlineError>Viewed marks could not be saved.</InlineError>
      ) : null}
      <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold">Review Guide</h2>
          <p className="text-xs text-muted-foreground">
            {guide.groups.length} groups · {guide.inventory.length} files
            {reading === undefined
              ? null
              : ` · ${guide.groups.filter((group) => reviewed.has(group.id)).length}/${guide.groups.length} reviewed`}
          </p>
        </div>
        <ReviewDiffOptionsPopover
          preferences={viewPreferences}
          onPreferencesChange={changeViewPreferences}
        >
          <ReviewDiffOptionRow
            icon={<ChevronsUpDown aria-hidden="true" />}
            label="Full context"
            checked={false}
            disabledReason="Only retained patch context is available in Guide."
            onCheckedChange={() => undefined}
          />
        </ReviewDiffOptionsPopover>
      </div>
      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-4 @min-[48rem]:grid-cols-[3rem_minmax(0,1fr)] @min-[48rem]:grid-rows-[minmax(0,1fr)]">
        <GuideMinimap root={root} groups={minimapGroups} />
        <div data-guide-viewport className="min-h-0 min-w-0 overflow-auto">
          <div ref={root}>
            <ol className="m-0 list-none divide-y border-y p-0">
              {guide.groups.map((group, index) => (
                <li
                  key={group.id}
                  data-guide-group={group.id}
                  data-guide-minimap-group={group.id}
                  className="grid min-w-0 gap-4 py-5 @min-[48rem]:grid-cols-[minmax(0,0.6fr)_minmax(0,1.4fr)]"
                >
                  <section
                    aria-labelledby={`guide-${group.id}`}
                    className="min-w-0 space-y-3"
                  >
                    <p className="font-mono text-xs text-muted-foreground">
                      {String(index + 1).padStart(2, "0")} /{" "}
                      {String(guide.groups.length).padStart(2, "0")}
                    </p>
                    <h3
                      id={`guide-${group.id}`}
                      className="text-base font-semibold"
                    >
                      {group.title}
                    </h3>
                    {reading === undefined ? null : (
                      <Button
                        size="xs"
                        variant={
                          reviewed.has(group.id) ? "secondary" : "outline"
                        }
                        className={
                          reviewed.has(group.id)
                            ? "text-status-success"
                            : undefined
                        }
                        aria-label={`Reviewed ${group.title}`}
                        aria-pressed={reviewed.has(group.id)}
                        onClick={() => {
                          const {
                            reviewedGroupIds,
                            expandedAppearances,
                            anchor,
                          } = reading.progress;
                          reading.edit({
                            reviewedGroupIds: reviewed.has(group.id)
                              ? reviewedGroupIds.filter((id) => id !== group.id)
                              : [...reviewedGroupIds, group.id],
                            expandedAppearances,
                            anchor,
                          });
                        }}
                      >
                        {reviewed.has(group.id) ? (
                          <Check data-icon="inline-start" aria-hidden="true" />
                        ) : null}
                        {reviewed.has(group.id) ? "Reviewed" : "Mark reviewed"}
                      </Button>
                    )}
                    <GeneratedMarkdown
                      markdown={group.explanation}
                      className="break-words text-sm"
                    />
                  </section>
                  <ul
                    aria-label={`${group.title} files`}
                    className="min-w-0 space-y-2"
                  >
                    {group.files.map((membership) => {
                      const file = files.get(membership.fileId);
                      const fileEvidence = evidence.get(membership.fileId);
                      return file === undefined ||
                        fileEvidence === undefined ? null : (
                        <GuideFileRow
                          key={membership.fileId}
                          groupId={group.id}
                          {...(reading === undefined ? {} : { reading })}
                          file={file}
                          evidence={fileEvidence}
                          preferences={viewPreferences}
                          onPreferencesChange={changeViewPreferences}
                          {...(viewedPaths === undefined
                            ? {}
                            : { viewedPaths })}
                          {...(diffAuthoring === undefined
                            ? {}
                            : { diffAuthoring })}
                          {...(disabledReason === undefined
                            ? {}
                            : { disabledReason })}
                        />
                      );
                    })}
                  </ul>
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
                  Others · {others.length}{" "}
                  {others.length === 1 ? "file" : "files"}
                </h3>
                <p className="text-sm text-muted-foreground">
                  Changed files outside the Guide's groups.
                </p>
              </div>
              {others.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Every changed file appears in a group.
                </p>
              ) : (
                <ul aria-label="Others files" className="min-w-0 space-y-2">
                  {others.map((file) => {
                    const fileEvidence = evidence.get(file.id);
                    return fileEvidence === undefined ? null : (
                      <GuideFileRow
                        key={file.id}
                        groupId="others"
                        {...(reading === undefined ? {} : { reading })}
                        file={file}
                        evidence={fileEvidence}
                        {...(viewedPaths === undefined ? {} : { viewedPaths })}
                        preferences={viewPreferences}
                        onPreferencesChange={changeViewPreferences}
                        {...(diffAuthoring === undefined
                          ? {}
                          : { diffAuthoring })}
                        {...(disabledReason === undefined
                          ? {}
                          : { disabledReason })}
                      />
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function GuideFileRow({
  file,
  groupId,
  reading,
  evidence,
  preferences,
  diffAuthoring,
  disabledReason,
  viewedPaths,
  onPreferencesChange,
}: {
  readonly onPreferencesChange: (
    update: Partial<ReviewViewPreferences>,
  ) => void;
  readonly groupId: string;
  readonly viewedPaths?: ReadonlySet<string>;
  readonly reading?: GuideReadingControls;
  readonly diffAuthoring?: WalkthroughDiffAuthoring;
  readonly disabledReason?: string;
  readonly file: GuideInventoryEntry;
  readonly evidence: GuideFileEvidence;
  readonly preferences: ReviewViewPreferences;
}): React.JSX.Element {
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const expanded =
    reading === undefined
      ? previewExpanded
      : reading.progress.expandedAppearances.some(
          (appearance) =>
            appearance.groupId === groupId && appearance.fileId === file.id,
        );
  const toggleExpanded = (): void => {
    if (reading === undefined) {
      setPreviewExpanded((value) => !value);
      return;
    }
    const { reviewedGroupIds, expandedAppearances, anchor } = reading.progress;
    reading.edit({
      reviewedGroupIds,
      anchor,
      expandedAppearances: expanded
        ? expandedAppearances.filter(
            (appearance) =>
              appearance.groupId !== groupId || appearance.fileId !== file.id,
          )
        : [...expandedAppearances, { groupId, fileId: file.id }],
    });
  };
  const path = file.status === "removed" ? file.oldPath : file.newPath;
  const cut = path.lastIndexOf("/");
  const viewedFiles =
    disabledReason === undefined ? diffAuthoring?.viewedFiles : undefined;
  const viewedDisabledReason =
    disabledReason ??
    (viewedFiles === undefined
      ? "Viewed marks require the Combined Diff view."
      : undefined);
  return (
    <li
      data-guide-file={`${groupId}/${file.id}`}
      className="min-w-0 overflow-hidden rounded-md border bg-card"
    >
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          aria-label={`File ${path}`}
          aria-expanded={expanded}
          onClick={toggleExpanded}
          className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-2 text-left"
        >
          <span className="flex min-w-0 items-start gap-2 break-all font-mono text-xs">
            <ChevronRight
              aria-hidden="true"
              className={`size-3.5 shrink-0 ${expanded ? "rotate-90" : ""}`}
            />
            <span>
              <span className="text-muted-foreground">
                {path.slice(0, cut + 1)}
              </span>
              <strong className="font-semibold">{path.slice(cut + 1)}</strong>
            </span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {file.status} ·{" "}
            <span className="text-green-500">+{file.additions}</span>{" "}
            <span className="text-red-400">−{file.deletions}</span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <FileViewedCheckbox
            label={`Viewed ${path}`}
            checked={
              (diffAuthoring?.viewedFiles?.paths ?? viewedPaths)?.has(path) ??
              false
            }
            disabled={viewedDisabledReason !== undefined}
            onToggle={() => {
              if (viewedFiles === undefined) return;
              const paths = new Set(viewedFiles.paths);
              if (paths.has(path)) paths.delete(path);
              else paths.add(path);
              viewedFiles.setPaths(paths);
            }}
          />
        </div>
      </div>
      {viewedDisabledReason === undefined ? null : (
        <p
          role="note"
          className="min-w-0 break-words px-2.5 pb-2 text-xs text-muted-foreground"
        >
          {viewedDisabledReason}
        </p>
      )}
      <div className="px-2.5 empty:hidden">
        {file.status === "renamed" ? (
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
            From {file.oldPath}
          </p>
        ) : null}
        {file.evidence === "text" ? null : (
          <p className="mt-1 text-xs text-muted-foreground">
            {evidenceLabels[file.evidence]}
          </p>
        )}
      </div>
      {expanded ? (
        <GuideFileDiff
          file={file}
          key={disabledReason ?? "current"}
          evidence={evidence}
          {...(disabledReason === undefined && diffAuthoring !== undefined
            ? { diffAuthoring }
            : {})}
          preferences={preferences}
          onPreferencesChange={onPreferencesChange}
        />
      ) : null}
    </li>
  );
}
