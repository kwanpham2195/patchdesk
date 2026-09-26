import { locatePatchAnchor, type ReviewAnchorFingerprint } from "./diff-anchor";
import {
  isAcceptableSuggestionCode,
  resolveSuggestionTarget,
} from "./finding-suggestion";
import type { RepoRelativePath, ReviewSessionId } from "./ids";
import { isMaintainerNote, type LocalDraft } from "./local-draft";

/** The session a local Review moves to, as the carry rule reads it. */
export type LocalDraftCarryTarget = {
  readonly sessionId: ReviewSessionId;
  readonly patch: string;
  /** New-side text at the session head of each drafted path; a path is absent when its file is gone. */
  readonly files: ReadonlyMap<RepoRelativePath, string>;
};

/**
 * ADR 0002's carry rule for one Local draft (ADR 0050 "Local drafts", ADR
 * 0051 "Addressed or not", #452). The draft moves when its fingerprint maps to
 * exactly one location in the new patch, or else when its surrounding lines
 * are each found exactly once in the new file around at least one line, the
 * file's start or end standing in for an empty side; it moves to the lines
 * between them even when those left the patch. Any other draft needs
 * attention and keeps its anchor and session. The state describes
 * the lines under the draft, not how it was placed: changed once they differ
 * from the lines the maintainer saw, unchanged otherwise. No draft is
 * discarded, and an applied Finding draft is left as it is.
 */
export function carryLocalDraft(
  draft: LocalDraft,
  target: LocalDraftCarryTarget,
): LocalDraft {
  if (!isMaintainerNote(draft) && draft.appliedAt !== undefined) return draft;
  const notedLines = draft.carry?.notedLines ?? draft.anchor.selectedLines;
  const locations = locatePatchAnchor(target.patch, draft.anchor);
  const location = locations.length === 1 ? locations[0] : undefined;
  const anchor =
    location !== undefined
      ? { ...draft.anchor, ...location }
      : draft.anchor.side === "new"
        ? regionBetweenContext(
            draft.anchor,
            target.files.get(draft.anchor.path),
          )
        : undefined;
  if (anchor === undefined)
    return withoutStaleSuggestion(
      {
        ...draft,
        carry: {
          state: "needs_attention",
          sessionId: target.sessionId,
          notedLines,
        },
      },
      notedLines,
      target.patch,
    );
  // Once changed since the note, lines that stop moving are still changed since it.
  const state =
    draft.carry?.state === "changed" ||
    !sameLines(anchor.selectedLines, notedLines)
      ? "changed"
      : "unchanged";
  return withoutStaleSuggestion(
    {
      ...draft,
      sessionId: target.sessionId,
      anchor,
      carry: { state, sessionId: target.sessionId, notedLines },
    },
    notedLines,
    target.patch,
  );
}

/**
 * Keeps a Finding draft's suggestion only when it can still be serialized and
 * the new patch holds, at the draft's location, the exact lines the
 * suggestion was verified against; otherwise the draft stays without it.
 */
function withoutStaleSuggestion(
  draft: LocalDraft,
  verifiedAgainst: ReadonlyArray<string>,
  patch: string,
): LocalDraft {
  if (isMaintainerNote(draft) || draft.suggestion === undefined) return draft;
  const target = resolveSuggestionTarget(patch, {
    file: draft.anchor.path,
    lineStart: draft.anchor.startLine,
    lineEnd: draft.anchor.line,
    diffSide: draft.anchor.side,
  });
  if (
    isAcceptableSuggestionCode(draft.suggestion.code) &&
    target !== undefined &&
    sameLines(target.originalLines, verifiedAgainst)
  )
    return draft;
  const { suggestion: _dropped, ...rest } = draft;
  return rest;
}

/**
 * The lines between the draft's `before` and `after` context in the new file,
 * when each context block is found there exactly once, in order, around at
 * least one line. The file's start or end stands in for an empty block (#521).
 */
function regionBetweenContext(
  anchor: ReviewAnchorFingerprint,
  text: string | undefined,
): ReviewAnchorFingerprint | undefined {
  // An empty block matches everywhere, so it counts only as the file boundary on its side, beside a block that still matches.
  if (
    text === undefined ||
    (anchor.before.length === 0 && anchor.after.length === 0)
  )
    return undefined;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  // Leading context is missing at the file's start only when the note began on line 1; git's trailing context runs out only at the file's end.
  const before =
    anchor.before.length > 0
      ? onlyOccurrence(lines, anchor.before)
      : anchor.startLine === 1
        ? 0
        : undefined;
  const end =
    anchor.after.length > 0
      ? onlyOccurrence(lines, anchor.after)
      : lines.length;
  if (before === undefined || end === undefined) return undefined;
  const start = before + anchor.before.length;
  if (end <= start) return undefined;
  return {
    ...anchor,
    startLine: start + 1,
    line: end,
    selectedLines: lines.slice(start, end),
  };
}

function onlyOccurrence(
  lines: ReadonlyArray<string>,
  block: ReadonlyArray<string>,
): number | undefined {
  const found = occurrences(lines, block);
  return found.length === 1 ? found[0] : undefined;
}

function occurrences(
  lines: ReadonlyArray<string>,
  block: ReadonlyArray<string>,
): ReadonlyArray<number> {
  const found: number[] = [];
  for (let start = 0; start + block.length <= lines.length; start += 1)
    if (block.every((text, offset) => lines[start + offset] === text))
      found.push(start);
  return found;
}

function sameLines(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  return (
    left.length === right.length &&
    left.every((text, index) => text === right[index])
  );
}
