import * as v from "valibot";

import {
  parseFindingId,
  parseInsightRunId,
  parseIsoTimestamp,
  parseLocalNoteId,
  type IsoTimestamp,
} from "./ids";
import {
  isMaintainerNote,
  type LocalDraft,
  type LocalDraftTarget,
} from "./local-draft";
import { err, ok, type Result } from "./result";

/** What the coding agent says it did about one Local draft (ADR 0052 "Replies"). */
const localDraftReplyStatuses = ["addressed", "skipped", "question"] as const;

export type LocalDraftReplyStatus = (typeof localDraftReplyStatuses)[number];

/** A reply is a short answer. The cap keeps each entry small; `get_feedback`'s byte-bounded pager, not this cap, keeps a page under its size bound. */
const MAX_LOCAL_DRAFT_REPLY_LENGTH = 4_096;

/**
 * The coding agent's latest reply to one Local draft. It is stored on the
 * Review beside the drafts, never in them, so the agent never writes the
 * maintainer's text, and a new reply to the same draft replaces it. The text
 * is untrusted: it is shown to the maintainer and returned by `get_feedback`,
 * and never enters an Insight prompt or the Copy as agent prompt Markdown.
 */
export type LocalDraftReply = {
  readonly draft: LocalDraftTarget;
  readonly status: LocalDraftReplyStatus;
  readonly text: string;
  readonly repliedAt: IsoTimestamp;
};

const nonEmpty = v.pipe(v.string(), v.minLength(1));

/** The stored and wire form of one reply; the workbench projection and the detection answer send the same shape. */
export const localDraftReplySchema = v.strictObject({
  draft: v.union([
    v.strictObject({ noteId: nonEmpty }),
    v.strictObject({ runId: nonEmpty, findingId: nonEmpty }),
  ]),
  status: v.picklist(localDraftReplyStatuses),
  text: v.pipe(nonEmpty, v.maxLength(MAX_LOCAL_DRAFT_REPLY_LENGTH)),
  repliedAt: nonEmpty,
});

type StoredLocalDraftReply = v.InferOutput<typeof localDraftReplySchema>;

/** Refines stored replies; an empty list is stored as no list, and one bad entry refuses the list. */
export function parseStoredLocalDraftReplies(
  raw: ReadonlyArray<StoredLocalDraftReply>,
): Result<ReadonlyArray<LocalDraftReply>, "invalid"> {
  if (raw.length === 0) return err("invalid");
  const replies: LocalDraftReply[] = [];
  for (const entry of raw) {
    const draft = parseLocalDraftTarget(entry.draft);
    const text = parseLocalDraftReplyText(entry.text);
    const repliedAt = parseIsoTimestamp(entry.repliedAt);
    if (draft === undefined || text._tag === "err" || repliedAt._tag === "err")
      return err("invalid");
    replies.push({
      draft,
      status: entry.status,
      text: text.value,
      repliedAt: repliedAt.value,
    });
  }
  return ok(replies);
}

/** The draft a stored reply or a Resolve request names, as branded ids. */
export function parseLocalDraftTarget(
  raw: StoredLocalDraftReply["draft"],
): LocalDraftTarget | undefined {
  if ("noteId" in raw) {
    const noteId = parseLocalNoteId(raw.noteId);
    return noteId._tag === "ok" ? { noteId: noteId.value } : undefined;
  }
  const runId = parseInsightRunId(raw.runId);
  const findingId = parseFindingId(raw.findingId);
  return runId._tag === "ok" && findingId._tag === "ok"
    ? { runId: runId.value, findingId: findingId.value }
    : undefined;
}

/** A reply's text: anything but whitespace, within the reply length limit. */
export function parseLocalDraftReplyText(
  text: string,
): Result<string, "invalid"> {
  return text.trim().length === 0 || text.length > MAX_LOCAL_DRAFT_REPLY_LENGTH
    ? err("invalid")
    : ok(text);
}

/**
 * A Local draft's id as `get_feedback` lists it and `reply_to_note` names it:
 * a note's id, or `<analysisRunId>/<findingId>` for a Finding draft. A Finding
 * id never holds `/`, so the last one splits the two.
 */
export function localDraftId(draft: LocalDraft): string {
  return localDraftTargetId(
    isMaintainerNote(draft)
      ? { noteId: draft.noteId }
      : { runId: draft.analysisRunId, findingId: draft.findingId },
  );
}

/** The `localDraftId` of the draft `target` names. */
export function localDraftTargetId(target: LocalDraftTarget): string {
  return "noteId" in target
    ? target.noteId
    : `${target.runId}/${target.findingId}`;
}

/** The draft a `localDraftId` names; undefined for a string no draft id can be. */
export function parseLocalDraftId(id: string): LocalDraftTarget | undefined {
  const split = id.lastIndexOf("/");
  if (split === -1) {
    const noteId = parseLocalNoteId(id);
    return noteId._tag === "ok" ? { noteId: noteId.value } : undefined;
  }
  const runId = parseInsightRunId(id.slice(0, split));
  const findingId = parseFindingId(id.slice(split + 1));
  return runId._tag === "ok" && findingId._tag === "ok"
    ? { runId: runId.value, findingId: findingId.value }
    : undefined;
}
