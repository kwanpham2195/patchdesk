import * as v from "valibot";

import { definedProps } from "./defined-props";
import type { ReviewAnchorFingerprint } from "./diff-anchor";
import {
  parseFindingId,
  parseInsightRunId,
  parseIsoTimestamp,
  parseRepoRelativePath,
  parseReviewSessionId,
  type FindingId,
  type InsightRunId,
  type IsoTimestamp,
  type ReviewSessionId,
} from "./ids";
import { err, ok, type Result } from "./result";
import type { FindingSuggestedReplacement } from "./review-result";

/**
 * One Finding a maintainer added to a local Review's draft list (ADR 0050
 * "Local drafts"). It keeps everything handoff needs without the Analysis:
 * the anchor fingerprint to map it into the pull request patch, and the
 * comment and suggestion the ADR 0048 fence serializer writes.
 */
export type LocalDraft = {
  readonly findingId: FindingId;
  readonly analysisRunId: InsightRunId;
  /** The session whose patch the anchor was fingerprinted against. */
  readonly sessionId: ReviewSessionId;
  readonly anchor: ReviewAnchorFingerprint;
  readonly title: string;
  /** The Finding's suggested comment, or its explanation when it has none. */
  readonly comment: string;
  /** Present only when the Finding's replacement resolved in the session patch. */
  readonly suggestion?: FindingSuggestedReplacement;
  readonly addedAt: IsoTimestamp;
};

/** What the workbench lists for one Local draft; the comment and suggestion stay in the main process. */
export type LocalDraftEntry = {
  readonly findingId: FindingId;
  readonly analysisRunId: InsightRunId;
  readonly sessionId: ReviewSessionId;
  readonly path: string;
  readonly side: "new" | "old";
  readonly startLine: number;
  readonly line: number;
  readonly title: string;
  readonly suggests: boolean;
};

export type InvalidLocalDraft = { readonly _tag: "InvalidLocalDraft" };

const lineNumber = v.pipe(v.number(), v.integer(), v.minValue(1));
const nonEmpty = v.pipe(v.string(), v.minLength(1));

/** The stored form of one Local draft; unknown fields are refused. */
export const storedLocalDraftSchema = v.strictObject({
  findingId: nonEmpty,
  analysisRunId: nonEmpty,
  sessionId: nonEmpty,
  anchor: v.strictObject({
    path: nonEmpty,
    side: v.picklist(["new", "old"]),
    startLine: lineNumber,
    line: lineNumber,
    selectedLines: v.array(v.string()),
    before: v.array(v.string()),
    after: v.array(v.string()),
  }),
  title: nonEmpty,
  comment: nonEmpty,
  suggestion: v.optional(v.strictObject({ code: nonEmpty })),
  addedAt: nonEmpty,
});

type StoredLocalDraft = v.InferOutput<typeof storedLocalDraftSchema>;

/** Refine schema-checked stored drafts into branded values; one bad entry refuses the list. */
export function parseStoredLocalDrafts(
  raw: ReadonlyArray<StoredLocalDraft>,
): Result<ReadonlyArray<LocalDraft>, InvalidLocalDraft> {
  const drafts: LocalDraft[] = [];
  for (const entry of raw) {
    const findingId = parseFindingId(entry.findingId);
    const analysisRunId = parseInsightRunId(entry.analysisRunId);
    const sessionId = parseReviewSessionId(entry.sessionId);
    const path = parseRepoRelativePath(entry.anchor.path);
    const addedAt = parseIsoTimestamp(entry.addedAt);
    if (
      findingId._tag === "err" ||
      analysisRunId._tag === "err" ||
      sessionId._tag === "err" ||
      path._tag === "err" ||
      addedAt._tag === "err" ||
      entry.anchor.line < entry.anchor.startLine
    )
      return err({ _tag: "InvalidLocalDraft" });
    drafts.push({
      findingId: findingId.value,
      analysisRunId: analysisRunId.value,
      sessionId: sessionId.value,
      anchor: { ...entry.anchor, path: path.value },
      title: entry.title,
      comment: entry.comment,
      ...definedProps({ suggestion: entry.suggestion }),
      addedAt: addedAt.value,
    });
  }
  return ok(drafts);
}

/** A draft is keyed by the Finding it came from: one Analysis run and one Finding id. */
export function isDraftOfFinding(
  draft: Pick<LocalDraft, "analysisRunId" | "findingId">,
  finding: { readonly runId: InsightRunId; readonly findingId: FindingId },
): boolean {
  return (
    draft.analysisRunId === finding.runId &&
    draft.findingId === finding.findingId
  );
}

export function projectLocalDraft(draft: LocalDraft): LocalDraftEntry {
  return {
    findingId: draft.findingId,
    analysisRunId: draft.analysisRunId,
    sessionId: draft.sessionId,
    path: draft.anchor.path,
    side: draft.anchor.side,
    startLine: draft.anchor.startLine,
    line: draft.anchor.line,
    title: draft.title,
    suggests: draft.suggestion !== undefined,
  };
}
