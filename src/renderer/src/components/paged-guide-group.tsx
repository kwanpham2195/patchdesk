import { useMemo, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import * as v from "valibot";

import {
  guideFileIdSchema,
  guideInventoryEntrySchema,
} from "#src/domain/guide";

import type { GuideFileSummary } from "#src/domain/guide-progress";
import type { GuideInventoryEntry } from "#src/domain/guide";
import type { GuideReadingControls } from "#src/renderer/src/hooks/use-guide-reading-state";
import type { ReviewViewPreferences } from "@/review-view-preferences";
import { parseReviewDiff } from "@/review-diff-data";
import { useCapturedText } from "#src/renderer/src/hooks/use-paged-guide";
import { GeneratedMarkdown } from "./generated-markdown";
import { GuideFileDiff } from "./guide-file-diff";
import { Button } from "./ui/button";
import type { WalkthroughDiffAuthoring } from "./walkthrough-diff-authoring";

const evidenceLabels = {
  text: "",
  metadata: "Metadata only",
  binary: "Binary file",
  submodule: "Submodule change",
  omitted: "Diff omitted",
} satisfies Readonly<Record<GuideFileSummary["evidence"], string>>;

/** One file appearance in a group or in Others; the diff it expands is the Review's own block for that path. */
export function PagedGuideFileRow({
  fileId,
  groupId,
  file: summarized,
  relevance,
  reading,
  source,
  preferences,
  onPreferencesChange,
  onOpenInDiff,
  diffAuthoring,
  disabledReason,
}: {
  readonly fileId: string;
  readonly groupId: string;
  /** Null when the entry was too large to summarize; the identity still names the row. */
  readonly file: GuideFileSummary | null;
  readonly relevance?: string;
  readonly reading?: GuideReadingControls;
  /** Where this file's captured patch and full entry are read from: the published result's immutable evidence. */
  readonly source: {
    readonly profileId: string;
    readonly reviewId: string;
    readonly digest: string;
  };
  readonly preferences: ReviewViewPreferences;
  readonly onPreferencesChange: (
    update: Partial<ReviewViewPreferences>,
  ) => void;
  readonly onOpenInDiff?: ((path: string) => void) | undefined;
  readonly diffAuthoring?: WalkthroughDiffAuthoring | undefined;
  readonly disabledReason?: string | undefined;
}): React.JSX.Element {
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [wantDetails, setWantDetails] = useState(false);
  const identity = { profileId: source.profileId, reviewId: source.reviewId };
  // A row whose entry was too large to summarize keeps its identity and loads the whole entry on request.
  const entry = useCapturedText(
    identity,
    source.digest,
    { type: "inventory_entry", fileId: v.parse(guideFileIdSchema, fileId) },
    wantDetails && summarized === null,
  );
  const file = useMemo(
    () => summarized ?? summaryFromEntry(entry),
    [summarized, entry],
  );
  const expanded =
    reading === undefined
      ? previewExpanded
      : reading.progress.expandedAppearances.some(
          (appearance) =>
            appearance.groupId === groupId && appearance.fileId === fileId,
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
              appearance.groupId !== groupId || appearance.fileId !== fileId,
          )
        : [...expandedAppearances, { groupId, fileId }],
    });
  };
  const path =
    file === null
      ? fileId
      : file.status === "removed"
        ? file.oldPath
        : file.newPath;
  const cut = path.lastIndexOf("/");
  const inventoryEntry: GuideInventoryEntry | undefined = useMemo(
    () =>
      file === null
        ? undefined
        : { ...file, id: v.parse(guideFileIdSchema, fileId), metadata: [] },
    [file, fileId],
  );
  const captured = useCapturedText(
    identity,
    source.digest,
    { type: "captured_patch", fileId: v.parse(guideFileIdSchema, fileId) },
    expanded && file !== null,
  );
  const evidence = useMemo(
    () =>
      captured.status !== "ready" || file === null
        ? undefined
        : {
            patch: captured.text,
            diff:
              file.evidence === "text"
                ? parseReviewDiff(captured.text)
                : undefined,
          },
    [captured, file],
  );
  return (
    <li
      data-guide-file={`${groupId}/${fileId}`}
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
          {file === null ? null : (
            <span className="shrink-0 text-xs text-muted-foreground">
              {file.status} ·{" "}
              <span className="text-green-500">+{file.additions}</span>{" "}
              <span className="text-red-400">−{file.deletions}</span>
            </span>
          )}
        </button>
        {onOpenInDiff === undefined ||
        file === null ||
        disabledReason !== undefined ? null : (
          <Button
            size="xs"
            variant="outline"
            aria-label={`Open ${path} in Diff`}
            onClick={() => onOpenInDiff(path)}
          >
            Open in Diff
          </Button>
        )}
      </div>
      {file === null ? (
        <div className="px-2.5 pb-2">
          <Button
            size="xs"
            variant="outline"
            disabled={wantDetails && entry.status === "loading"}
            onClick={() => setWantDetails(true)}
          >
            {entry.status === "failed"
              ? "Retry loading file details"
              : "Load file details"}
          </Button>
        </div>
      ) : null}
      {relevance === undefined ? null : (
        <p className="min-w-0 break-words px-2.5 pb-2 text-xs text-muted-foreground">
          {relevance}
        </p>
      )}
      {file === null || file.evidence === "text" ? null : (
        <p className="px-2.5 pb-2 text-xs text-muted-foreground">
          {evidenceLabels[file.evidence]}
        </p>
      )}
      {expanded && inventoryEntry !== undefined ? (
        captured.status === "loading" || captured.status === "idle" ? (
          <p
            role="status"
            className="px-2.5 pb-2 text-xs text-muted-foreground"
          >
            Loading the captured diff…
          </p>
        ) : evidence === undefined ? (
          <p role="note" className="px-2.5 pb-2 text-xs text-muted-foreground">
            The captured diff for this file could not be read.
          </p>
        ) : (
          <GuideFileDiff
            file={inventoryEntry}
            evidence={evidence}
            {...(disabledReason === undefined && diffAuthoring !== undefined
              ? { diffAuthoring }
              : {})}
            preferences={preferences}
            onPreferencesChange={onPreferencesChange}
          />
        )
      ) : null}
    </li>
  );
}

/** A group header: title, reviewed mark and the explanation, with its remaining text on request. */
export function PagedGuideGroupHeader({
  id,
  index,
  total,
  title,
  explanation,
  hasMoreExplanation,
  onLoadMoreExplanation,
  reading,
  reviewed,
}: {
  readonly id: string;
  readonly index: number;
  readonly total: number;
  readonly title: string;
  readonly explanation: string;
  readonly hasMoreExplanation: boolean;
  readonly onLoadMoreExplanation: () => void;
  readonly reading?: GuideReadingControls;
  readonly reviewed: boolean;
}): React.JSX.Element {
  return (
    <section aria-labelledby={`guide-${id}`} className="min-w-0 space-y-3">
      <p className="font-mono text-xs text-muted-foreground">
        {String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}
      </p>
      <h3 id={`guide-${id}`} className="text-base font-semibold">
        {title}
      </h3>
      {reading === undefined ? null : (
        <Button
          size="xs"
          variant={reviewed ? "secondary" : "outline"}
          className={reviewed ? "text-status-success" : undefined}
          aria-label={`Reviewed ${title}`}
          aria-pressed={reviewed}
          onClick={() => {
            const { reviewedGroupIds, expandedAppearances, anchor } =
              reading.progress;
            reading.edit({
              reviewedGroupIds: reviewed
                ? reviewedGroupIds.filter((groupId) => groupId !== id)
                : [...reviewedGroupIds, id],
              expandedAppearances,
              anchor,
            });
          }}
        >
          {reviewed ? (
            <Check data-icon="inline-start" aria-hidden="true" />
          ) : null}
          {reviewed ? "Reviewed" : "Mark reviewed"}
        </Button>
      )}
      <GeneratedMarkdown
        markdown={explanation}
        className="break-words text-sm"
      />
      {hasMoreExplanation ? (
        <Button size="xs" variant="outline" onClick={onLoadMoreExplanation}>
          Show the rest of this explanation
        </Button>
      ) : null}
    </section>
  );
}

/** The facts a row shows, from a fully loaded inventory entry; no path length cap applies here. */
function summaryFromEntry(entry: {
  readonly status: string;
  readonly text: string;
}): GuideFileSummary | null {
  if (entry.status !== "ready") return null;
  try {
    const parsed = v.safeParse(
      guideInventoryEntrySchema,
      JSON.parse(entry.text),
    );
    if (!parsed.success) return null;
    const { oldPath, newPath, status, additions, deletions, evidence } =
      parsed.output;
    return { oldPath, newPath, status, additions, deletions, evidence };
  } catch {
    return null;
  }
}
