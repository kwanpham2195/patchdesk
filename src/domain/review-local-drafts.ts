import { definedProps } from "./defined-props";
import {
  handoffAfterDraftChange,
  type FeedbackHandoff,
} from "./feedback-handoff";
import type { FindingId, InsightRunId, IsoTimestamp, LocalNoteId } from "./ids";
import {
  isLocalDraftOf,
  isMaintainerNote,
  type LocalDraft,
  type LocalDraftTarget,
  type MaintainerNote,
} from "./local-draft";
import { err, ok, type Result } from "./result";
import { laterTimestamp, type Review } from "./review";
import type { LocalReviewSource } from "./review-source";

/**
 * Add one Local draft to a local Review's list (ADR 0050, ADR 0051). A Finding
 * already drafted keeps its entry, so adding twice is one draft.
 */
export function addLocalDraft(
  review: Review<LocalReviewSource>,
  draft: LocalDraft,
): Result<Review<LocalReviewSource>, { readonly _tag: "ReviewTerminal" }> {
  if (review.status._tag === "Terminal") return err({ _tag: "ReviewTerminal" });
  const drafts = review.localDrafts ?? [];
  const target = isMaintainerNote(draft)
    ? { noteId: draft.noteId }
    : { runId: draft.analysisRunId, findingId: draft.findingId };
  if (drafts.some((entry) => isLocalDraftOf(entry, target))) return ok(review);
  const addedAt = isMaintainerNote(draft) ? draft.createdAt : draft.addedAt;
  return ok({
    ...review,
    localDrafts: [...drafts, draft],
    ...definedProps({
      handoff: handoffAfterDraftChange(review.handoff, addedAt),
    }),
    updatedAt: laterTimestamp(review.updatedAt, addedAt),
  });
}

/** Replace one maintainer note's text; a Finding draft is never edited (ADR 0051). */
export function editMaintainerNote(
  review: Review<LocalReviewSource>,
  edit: {
    readonly noteId: LocalNoteId;
    readonly text: string;
    readonly updatedAt: IsoTimestamp;
  },
): Result<
  Review<LocalReviewSource>,
  { readonly _tag: "ReviewTerminal" | "NoteNotFound" }
> {
  if (review.status._tag === "Terminal") return err({ _tag: "ReviewTerminal" });
  const drafts = review.localDrafts ?? [];
  const note = drafts.find(
    (entry): entry is MaintainerNote =>
      isMaintainerNote(entry) && entry.noteId === edit.noteId,
  );
  if (note === undefined) return err({ _tag: "NoteNotFound" });
  if (note.text === edit.text) return ok(review);
  const updatedAt = laterTimestamp(review.updatedAt, edit.updatedAt);
  return ok({
    ...review,
    localDrafts: drafts.map((entry) =>
      entry === note ? { ...note, text: edit.text, updatedAt } : entry,
    ),
    ...definedProps({
      handoff: handoffAfterDraftChange(review.handoff, edit.updatedAt),
    }),
    updatedAt,
  });
}

/**
 * Mark the Finding drafts a confirmed Apply wrote as applied (#452). They stay
 * listed for the maintainer and leave the agent prompt.
 */
export function markLocalDraftsApplied(
  review: Review<LocalReviewSource>,
  applied: {
    readonly runId: InsightRunId;
    readonly findingIds: ReadonlyArray<FindingId>;
    readonly appliedAt: IsoTimestamp;
  },
): Review<LocalReviewSource> {
  const drafts = review.localDrafts ?? [];
  const wrote = (draft: LocalDraft) =>
    !isMaintainerNote(draft) &&
    draft.appliedAt === undefined &&
    applied.findingIds.some((findingId) =>
      isLocalDraftOf(draft, { runId: applied.runId, findingId }),
    );
  if (!drafts.some(wrote)) return review;
  return {
    ...review,
    localDrafts: drafts.map((draft) =>
      wrote(draft) ? { ...draft, appliedAt: applied.appliedAt } : draft,
    ),
    updatedAt: laterTimestamp(review.updatedAt, applied.appliedAt),
  };
}

/** Remove one Local draft; removing a draft that is not listed changes nothing. */
export function removeLocalDraft(
  review: Review<LocalReviewSource>,
  target: LocalDraftTarget,
  updatedAt: IsoTimestamp,
): Result<Review<LocalReviewSource>, { readonly _tag: "ReviewTerminal" }> {
  if (review.status._tag === "Terminal") return err({ _tag: "ReviewTerminal" });
  const drafts = review.localDrafts ?? [];
  const kept = drafts.filter((entry) => !isLocalDraftOf(entry, target));
  if (kept.length === drafts.length) return ok(review);
  const { localDrafts: _removed, ...rest } = review;
  return ok({
    ...rest,
    ...definedProps({
      localDrafts: kept.length === 0 ? undefined : kept,
      handoff: handoffAfterDraftChange(review.handoff, updatedAt),
    }),
    updatedAt: laterTimestamp(review.updatedAt, updatedAt),
  });
}

/** Stamp a Feedback hand-off on a local Review, replacing an earlier one (ADR 0052). */
export function recordFeedbackHandoff(
  review: Review<LocalReviewSource>,
  handoff: Pick<FeedbackHandoff, "at" | "verdict">,
): Result<Review<LocalReviewSource>, { readonly _tag: "ReviewTerminal" }> {
  if (review.status._tag === "Terminal") return err({ _tag: "ReviewTerminal" });
  return ok({
    ...review,
    handoff: { at: handoff.at, ...definedProps({ verdict: handoff.verdict }) },
    updatedAt: laterTimestamp(review.updatedAt, handoff.at),
  });
}
