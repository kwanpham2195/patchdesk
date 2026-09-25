import { locatePatchAnchor, type ReviewAnchorFingerprint } from "./diff-anchor";
import {
  isAcceptableSuggestionCode,
  resolveSuggestionTarget,
} from "./finding-suggestion";
import type { RepoRelativePath, ReviewSessionId } from "./ids";
import {
  isMaintainerNote,
  type LocalDraft,
  type LocalDraftCarryState,
} from "./local-draft";

/** The session a local Review moves to, as the carry rule reads it. */
export type LocalDraftCarryTarget = {
  readonly sessionId: ReviewSessionId;
  readonly patch: string;
  /** New-side text at the session head of each drafted path; a path is absent when its file is gone. */
  readonly files: ReadonlyMap<RepoRelativePath, string>;
};

/**
 * ADR 0002's carry rule for one Local draft (ADR 0050 "Local drafts", #452).
 * A draft whose fingerprint maps to exactly one location in the new patch is
 * unchanged and moves there. A new-side draft whose surrounding lines are each
 * found exactly once in the new file, around lines that differ from the
 * drafted ones, changed since the note and moves to the lines between them.
 * Any other draft needs attention and keeps its original anchor and session.
 * No draft is discarded, and an applied Finding draft is left as it is.
 */
export function carryLocalDraft(
  draft: LocalDraft,
  target: LocalDraftCarryTarget,
): LocalDraft {
  if (!isMaintainerNote(draft) && draft.appliedAt !== undefined) return draft;
  const locations = locatePatchAnchor(target.patch, draft.anchor);
  const location = locations.length === 1 ? locations[0] : undefined;
  if (location !== undefined)
    return moved(
      draft,
      target,
      { ...draft.anchor, ...location },
      // Lines that stopped moving after they changed are still changed since the note.
      draft.carry?.state === "changed" ? "changed" : "unchanged",
    );
  const region =
    draft.anchor.side === "new"
      ? changedRegion(draft.anchor, target.files.get(draft.anchor.path))
      : undefined;
  if (region !== undefined) return moved(draft, target, region, "changed");
  return withoutStaleSuggestion(
    {
      ...draft,
      carry: { state: "needs_attention", sessionId: target.sessionId },
    },
    draft.anchor,
    target.patch,
  );
}

function moved(
  draft: LocalDraft,
  target: LocalDraftCarryTarget,
  anchor: ReviewAnchorFingerprint,
  state: LocalDraftCarryState,
): LocalDraft {
  return withoutStaleSuggestion(
    {
      ...draft,
      sessionId: target.sessionId,
      anchor,
      carry: { state, sessionId: target.sessionId },
    },
    draft.anchor,
    target.patch,
  );
}

/**
 * Keeps a Finding draft's suggestion only when it can still be serialized and
 * the new patch holds, at the draft's new location, the exact lines the
 * suggestion was verified against; otherwise the draft stays without it.
 */
function withoutStaleSuggestion(
  draft: LocalDraft,
  verifiedAgainst: ReviewAnchorFingerprint,
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
    sameLines(target.originalLines, verifiedAgainst.selectedLines)
  )
    return draft;
  const { suggestion: _dropped, ...rest } = draft;
  return rest;
}

/**
 * The lines between the draft's `before` and `after` context in the new file,
 * when each context block is found there exactly once, in order, around at
 * least one line, and those lines are not the drafted ones.
 */
function changedRegion(
  anchor: ReviewAnchorFingerprint,
  text: string | undefined,
): ReviewAnchorFingerprint | undefined {
  // An empty context block matches everywhere, so it cannot place the draft.
  if (
    text === undefined ||
    anchor.before.length === 0 ||
    anchor.after.length === 0
  )
    return undefined;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const before = occurrences(lines, anchor.before);
  const after = occurrences(lines, anchor.after);
  if (before.length !== 1 || after.length !== 1) return undefined;
  const start = (before[0] ?? 0) + anchor.before.length;
  const end = after[0] ?? 0;
  if (end <= start) return undefined;
  const selectedLines = lines.slice(start, end);
  if (sameLines(selectedLines, anchor.selectedLines)) return undefined;
  return { ...anchor, startLine: start + 1, line: end, selectedLines };
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
