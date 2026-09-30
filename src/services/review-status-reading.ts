import { definedProps } from "../domain/defined-props";
import {
  readFeedbackHandoff,
  type FeedbackHandoffReading,
} from "../domain/feedback-handoff";
import type {
  FindingId,
  IsoTimestamp,
  RepoRelativePath,
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "../domain/ids";
import {
  isMaintainerNote,
  localDraftFeedbackState,
  type FindingDraft,
  type LocalDraft,
  type LocalDraftFeedbackState,
} from "../domain/local-draft";
import { compareLocalDraftsByFileThenLine } from "../domain/local-draft-agent-prompt";
import { ok, type Result } from "../domain/result";
import type {
  InsightReadingFailure,
  InsightStatusesReading,
  ReviewInsightReader,
} from "./review-insight-reading";
import type { ReviewSessionDescription } from "./review-session-description";

/** How many Local drafts of one kind are in each state `get_feedback` labels them with. */
type LocalDraftStateCounts = {
  readonly [State in LocalDraftFeedbackState]: number;
};

/** A Finding draft whose suggestion a confirmed Apply wrote to the checkout; its lines are numbered on the new side of the session it was drafted on. */
type AppliedFindingReading = {
  readonly findingId: FindingId;
  readonly title: string;
  readonly path: RepoRelativePath;
  readonly startLine: number;
  readonly line: number;
  readonly appliedAt: IsoTimestamp;
};

/**
 * What `get_review_status` answers (ADR 0052 "Tools, v1"): where a local
 * Review stands, without any Insight result or draft text, which
 * `get_insight` and `get_feedback` read. `handoff` and `changedSinceHandoff`
 * are present while the maintainer's hand-off stands (#603).
 */
export type ReviewStatus = ReviewSessionDescription &
  Partial<FeedbackHandoffReading> & {
    /** The session an agent's refresh prepared, present until the maintainer's Refresh moves the Review to it. */
    readonly preparedSessionId?: ReviewSessionId;
    readonly insights: InsightStatusesReading["insights"];
    readonly localDraftCounts: {
      readonly finding: LocalDraftStateCounts;
      readonly note: LocalDraftStateCounts;
    };
    /** In file then line order, as `get_feedback` lists drafts. */
    readonly appliedFindings: ReadonlyArray<AppliedFindingReading>;
  };

/**
 * Reads a local Review's status. It takes no snapshot, never answers
 * `in_progress`, and does not stamp `lastOpenedAt`; like `get_insight`, its
 * projection waits behind a write that holds the Review. The prepared
 * session and the drafts come from the Review record the Insight requests
 * were read from.
 */
export async function readReviewStatus(
  insightReader: Pick<ReviewInsightReader, "readStatuses">,
  request: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
  },
): Promise<Result<ReviewStatus, InsightReadingFailure>> {
  const read = await insightReader.readStatuses(request);
  if (read._tag === "err") return read;
  const { review, session, insights } = read.value;
  const drafts = review.localDrafts ?? [];
  return ok({
    ...session,
    ...definedProps({ preparedSessionId: review.preparedSessionId }),
    ...readFeedbackHandoff(review.handoff),
    insights,
    localDraftCounts: {
      finding: countByState(drafts.filter((draft) => !isMaintainerNote(draft))),
      note: countByState(drafts.filter(isMaintainerNote)),
    },
    appliedFindings: drafts
      .filter(isAppliedFindingDraft)
      .sort(compareLocalDraftsByFileThenLine)
      .map((draft) => ({
        findingId: draft.findingId,
        title: draft.title,
        path: draft.anchor.path,
        startLine: draft.anchor.startLine,
        line: draft.anchor.line,
        appliedAt: draft.appliedAt,
      })),
  });
}

function countByState(
  drafts: ReadonlyArray<LocalDraft>,
): LocalDraftStateCounts {
  const counts = {
    current: 0,
    unchanged: 0,
    changed: 0,
    needs_attention: 0,
    applied: 0,
  } satisfies Record<LocalDraftFeedbackState, number>;
  for (const draft of drafts) counts[localDraftFeedbackState(draft)] += 1;
  return counts;
}

function isAppliedFindingDraft(
  draft: LocalDraft,
): draft is FindingDraft & { readonly appliedAt: IsoTimestamp } {
  return !isMaintainerNote(draft) && draft.appliedAt !== undefined;
}
