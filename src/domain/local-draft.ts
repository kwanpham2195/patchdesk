import * as v from "valibot";

import { definedProps } from "./defined-props";
import type { ReviewAnchorFingerprint } from "./diff-anchor";
import {
  parseFindingId,
  parseInsightRunId,
  parseIsoTimestamp,
  parseLocalNoteId,
  parseRepoRelativePath,
  parseReviewSessionId,
  type FindingId,
  type InsightRunId,
  type IsoTimestamp,
  type LocalNoteId,
  type ReviewSessionId,
} from "./ids";
import { err, ok, type Result } from "./result";
import type { FindingSuggestedReplacement } from "./review-result";

/**
 * One Finding a maintainer added to a local Review's draft list (ADR 0050
 * "Local drafts"), kept readable without the Analysis it came from: the
 * anchor fingerprint to map it into a later patch, and the comment and
 * suggestion the agent prompt carries. Not editable.
 */
export type FindingDraft = {
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
  /** Set when a confirmed Apply wrote this Finding's suggestion; the draft stays listed and leaves the agent prompt. */
  readonly appliedAt?: IsoTimestamp;
  readonly carry?: LocalDraftCarry;
};

/** A note the maintainer wrote on diff lines of a local Review (ADR 0051); the maintainer may edit its text. */
export type MaintainerNote = {
  readonly author: "maintainer";
  readonly noteId: LocalNoteId;
  /** The session whose patch the anchor was fingerprinted against. */
  readonly sessionId: ReviewSessionId;
  readonly anchor: ReviewAnchorFingerprint;
  readonly text: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly carry?: LocalDraftCarry;
};

/**
 * What the last move of the Review to a new session decided for one draft
 * (#452): its lines are unchanged, changed since the note, or could not be
 * placed and need the maintainer's attention.
 */
type LocalDraftCarry = {
  readonly state: LocalDraftCarryState;
  /** The session the draft was carried to. */
  readonly sessionId: ReviewSessionId;
};

export type LocalDraftCarryState = "unchanged" | "changed" | "needs_attention";

/** One entry of a local Review's Local draft list: feedback for the coding agent. */
export type LocalDraft = FindingDraft | MaintainerNote;

/** What names one Local draft for removal: its Finding, or its note id. */
export type LocalDraftTarget =
  | { readonly runId: InsightRunId; readonly findingId: FindingId }
  | { readonly noteId: LocalNoteId };

/** What the workbench lists for one Local draft. A Finding draft's comment and suggestion stay in the main process; a note's text is shown and edited inline. */
export type LocalDraftEntry =
  | {
      readonly kind: "finding";
      readonly findingId: FindingId;
      readonly analysisRunId: InsightRunId;
      readonly sessionId: ReviewSessionId;
      readonly path: string;
      readonly side: "new" | "old";
      readonly startLine: number;
      readonly line: number;
      readonly title: string;
      readonly suggests: boolean;
      readonly state?: LocalDraftState;
    }
  | {
      readonly kind: "note";
      readonly noteId: LocalNoteId;
      readonly sessionId: ReviewSessionId;
      readonly path: string;
      readonly side: "new" | "old";
      readonly startLine: number;
      readonly line: number;
      readonly text: string;
      readonly state?: LocalDraftState;
    };

/** What the workbench labels a draft with; absent until the Review first moves to a new session. */
export type LocalDraftState = LocalDraftCarryState | "applied";

export type InvalidLocalDraft = { readonly _tag: "InvalidLocalDraft" };

/** GitHub's comment body limit; a note is feedback of the same kind. */
export const MAX_MAINTAINER_NOTE_LENGTH = 65_536;

const lineNumber = v.pipe(v.number(), v.integer(), v.minValue(1));
const nonEmpty = v.pipe(v.string(), v.minLength(1));
const storedAnchorSchema = v.strictObject({
  path: nonEmpty,
  side: v.picklist(["new", "old"]),
  startLine: lineNumber,
  line: lineNumber,
  selectedLines: v.array(v.string()),
  before: v.array(v.string()),
  after: v.array(v.string()),
});
const storedCarrySchema = v.optional(
  v.strictObject({
    state: v.picklist(["unchanged", "changed", "needs_attention"]),
    sessionId: nonEmpty,
  }),
);

/** The stored form of one Local draft; unknown fields are refused. A Finding draft has no `author`. */
export const storedLocalDraftSchema = v.union([
  v.strictObject({
    findingId: nonEmpty,
    analysisRunId: nonEmpty,
    sessionId: nonEmpty,
    anchor: storedAnchorSchema,
    title: nonEmpty,
    comment: nonEmpty,
    suggestion: v.optional(v.strictObject({ code: nonEmpty })),
    addedAt: nonEmpty,
    appliedAt: v.optional(nonEmpty),
    carry: storedCarrySchema,
  }),
  v.strictObject({
    author: v.literal("maintainer"),
    noteId: nonEmpty,
    sessionId: nonEmpty,
    anchor: storedAnchorSchema,
    text: v.pipe(v.string(), v.maxLength(MAX_MAINTAINER_NOTE_LENGTH)),
    createdAt: nonEmpty,
    updatedAt: nonEmpty,
    carry: storedCarrySchema,
  }),
]);

type StoredLocalDraft = v.InferOutput<typeof storedLocalDraftSchema>;

/** Refine schema-checked stored drafts into branded values; one bad entry refuses the list. */
export function parseStoredLocalDrafts(
  raw: ReadonlyArray<StoredLocalDraft>,
): Result<ReadonlyArray<LocalDraft>, InvalidLocalDraft> {
  const drafts: LocalDraft[] = [];
  for (const entry of raw) {
    const draft = parseStoredLocalDraft(entry);
    if (draft === undefined) return err({ _tag: "InvalidLocalDraft" });
    drafts.push(draft);
  }
  return ok(drafts);
}

function parseStoredLocalDraft(
  entry: StoredLocalDraft,
): LocalDraft | undefined {
  const sessionId = parseReviewSessionId(entry.sessionId);
  const path = parseRepoRelativePath(entry.anchor.path);
  const carriedTo =
    entry.carry === undefined
      ? undefined
      : parseReviewSessionId(entry.carry.sessionId);
  if (
    sessionId._tag === "err" ||
    path._tag === "err" ||
    carriedTo?._tag === "err" ||
    entry.anchor.line < entry.anchor.startLine
  )
    return undefined;
  const anchor = { ...entry.anchor, path: path.value };
  const carry =
    entry.carry === undefined || carriedTo === undefined
      ? undefined
      : { state: entry.carry.state, sessionId: carriedTo.value };
  if ("author" in entry) {
    const noteId = parseLocalNoteId(entry.noteId);
    const text = parseMaintainerNoteText(entry.text);
    const createdAt = parseIsoTimestamp(entry.createdAt);
    const updatedAt = parseIsoTimestamp(entry.updatedAt);
    if (
      noteId._tag === "err" ||
      text._tag === "err" ||
      createdAt._tag === "err" ||
      updatedAt._tag === "err"
    )
      return undefined;
    return {
      author: "maintainer",
      noteId: noteId.value,
      sessionId: sessionId.value,
      anchor,
      text: text.value,
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
      ...definedProps({ carry }),
    };
  }
  const findingId = parseFindingId(entry.findingId);
  const analysisRunId = parseInsightRunId(entry.analysisRunId);
  const addedAt = parseIsoTimestamp(entry.addedAt);
  const appliedAt =
    entry.appliedAt === undefined
      ? undefined
      : parseIsoTimestamp(entry.appliedAt);
  if (
    findingId._tag === "err" ||
    analysisRunId._tag === "err" ||
    addedAt._tag === "err" ||
    appliedAt?._tag === "err"
  )
    return undefined;
  return {
    findingId: findingId.value,
    analysisRunId: analysisRunId.value,
    sessionId: sessionId.value,
    anchor,
    title: entry.title,
    comment: entry.comment,
    ...definedProps({ suggestion: entry.suggestion }),
    addedAt: addedAt.value,
    ...definedProps({ appliedAt: appliedAt?.value, carry }),
  };
}

/** A note's text: anything but whitespace, within the comment length limit. */
export function parseMaintainerNoteText(
  text: string,
): Result<string, InvalidLocalDraft> {
  return text.trim().length === 0 || text.length > MAX_MAINTAINER_NOTE_LENGTH
    ? err({ _tag: "InvalidLocalDraft" })
    : ok(text);
}

export function isMaintainerNote(draft: LocalDraft): draft is MaintainerNote {
  return "author" in draft;
}

/** A Finding draft is keyed by the Finding it came from: one Analysis run and one Finding id. */
function isDraftOfFinding(
  draft: LocalDraft,
  finding: { readonly runId: InsightRunId; readonly findingId: FindingId },
): boolean {
  return (
    !isMaintainerNote(draft) &&
    draft.analysisRunId === finding.runId &&
    draft.findingId === finding.findingId
  );
}

export function isLocalDraftOf(
  draft: LocalDraft,
  target: LocalDraftTarget,
): boolean {
  return "noteId" in target
    ? isMaintainerNote(draft) && draft.noteId === target.noteId
    : isDraftOfFinding(draft, target);
}

/** An applied Finding draft is done, whatever its lines did afterwards. */
export function localDraftState(
  draft: LocalDraft,
): LocalDraftState | undefined {
  return !isMaintainerNote(draft) && draft.appliedAt !== undefined
    ? "applied"
    : draft.carry?.state;
}

export function projectLocalDraft(draft: LocalDraft): LocalDraftEntry {
  const location = {
    sessionId: draft.sessionId,
    path: draft.anchor.path,
    side: draft.anchor.side,
    startLine: draft.anchor.startLine,
    line: draft.anchor.line,
    ...definedProps({ state: localDraftState(draft) }),
  };
  return isMaintainerNote(draft)
    ? { kind: "note", noteId: draft.noteId, ...location, text: draft.text }
    : {
        kind: "finding",
        findingId: draft.findingId,
        analysisRunId: draft.analysisRunId,
        ...location,
        title: draft.title,
        suggests: draft.suggestion !== undefined,
      };
}
