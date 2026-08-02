import type { GitSha, IsoTimestamp, LocalReviewItemId, ReviewSessionId } from "./ids";
import type {
  ReviewAnchor,
  ReviewAnchorAttention,
  ReviewAnchorFingerprint,
  ReviewBatch,
  ReviewBatchItem,
} from "./review-batch";

type PatchLine = {
  readonly path: string;
  readonly side: "new" | "old";
  readonly line: number;
  readonly text: string;
  readonly hunk: number;
};

const CONTEXT_LINES = 2;

/** Capture exact diff text used to identify a local comment after a head change. */
export function fingerprintPatchAnchor(
  patch: string,
  anchor: ReviewAnchor,
): ReviewAnchorFingerprint | undefined {
  const lines = patchLines(patch).filter(
    (line) => line.path === anchor.path && line.side === anchor.side,
  );
  const start = lines.findIndex((line) => line.line === anchor.startLine);
  const end = lines.findIndex((line) => line.line === anchor.line);
  if (start < 0 || end < start || lines[start]?.hunk !== lines[end]?.hunk) {
    return undefined;
  }

  const selected = lines.slice(start, end + 1);
  if (selected.length !== anchor.line - anchor.startLine + 1) return undefined;
  const before = lines
    .slice(Math.max(0, start - CONTEXT_LINES), start)
    .filter((line) => line.hunk === selected[0]?.hunk)
    .map((line) => line.text);
  const after = lines
    .slice(end + 1, end + CONTEXT_LINES + 1)
    .filter((line) => line.hunk === selected[0]?.hunk)
    .map((line) => line.text);

  return {
    path: anchor.path,
    side: anchor.side,
    startLine: anchor.startLine,
    line: anchor.line,
    selectedLines: selected.map((line) => line.text),
    before,
    after,
  };
}

/** Find current-head anchors with one exact, unique context match. */
export function matchPatchAnchor(
  patch: string,
  fingerprint: ReviewAnchorFingerprint,
): ReadonlyArray<ReviewAnchor> {
  const lines = patchLines(patch).filter(
    (line) => line.path === fingerprint.path && line.side === fingerprint.side,
  );
  const matches: ReviewAnchor[] = [];
  for (let index = 0; index <= lines.length - fingerprint.selectedLines.length; index += 1) {
    const selected = lines.slice(index, index + fingerprint.selectedLines.length);
    if (
      selected.length === 0 ||
      selected[0]?.hunk !== selected.at(-1)?.hunk ||
      !selected.every((line, selectedIndex) => line.text === fingerprint.selectedLines[selectedIndex])
    ) {
      continue;
    }
    const selectedHunk = selected[0]?.hunk;
    const before = lines
      .slice(Math.max(0, index - fingerprint.before.length), index)
      .filter((line) => line.hunk === selectedHunk)
      .map((line) => line.text);
    const after = lines
      .slice(index + selected.length, index + selected.length + fingerprint.after.length)
      .filter((line) => line.hunk === selectedHunk)
      .map((line) => line.text);
    if (!sameLines(before, fingerprint.before) || !sameLines(after, fingerprint.after)) continue;
    const first = selected[0];
    const last = selected.at(-1);
    if (first === undefined || last === undefined) continue;
    matches.push({
      path: fingerprint.path,
      startLine: first.line,
      line: last.line,
      side: fingerprint.side,
    });
  }
  return matches;
}

/** Carry local actions into a new current-head batch without guessing coordinates. */
export type CarryForwardReviewBatchResult = {
  readonly batch: ReviewBatch;
  readonly attentionItemIds: ReadonlyArray<LocalReviewItemId>;
};

export function carryForwardReviewBatch(input: {
  readonly source: ReviewBatch;
  readonly sourceHeadSha: GitSha;
  readonly targetSessionId: ReviewSessionId;
  readonly currentPatch: string;
  readonly now: IsoTimestamp;
}): CarryForwardReviewBatchResult {
  const items: ReviewBatchItem[] = [];
  const attentionItemIds: LocalReviewItemId[] = [];
  const carriedFrom = {
    sourceSessionId: input.source.sessionId,
    sourceHeadSha: input.sourceHeadSha,
  };
  for (const item of input.source.items) {
    if (item._tag !== "InlineComment") {
      items.push({ ...item, carriedFrom });
      continue;
    }
    const attention = (reason: ReviewAnchorAttention["reason"]): ReviewBatchItem => ({
      ...item,
      postability: "needs_attention",
      attention: {
        reason,
        originalAnchor: item.anchor,
        ...(item.fingerprint === undefined
          ? {}
          : { originalFingerprint: item.fingerprint }),
      },
      carriedFrom,
    });
    if (item.fingerprint === undefined) {
      attentionItemIds.push(item.id);
      items.push(attention("fingerprint_missing"));
      continue;
    }
    const matches = matchPatchAnchor(input.currentPatch, item.fingerprint);
    const match = matches.length === 1 ? matches[0] : undefined;
    if (match === undefined) {
      attentionItemIds.push(item.id);
      items.push(attention(matches.length === 0 ? "missing" : "ambiguous"));
      continue;
    }
    const fingerprint = fingerprintPatchAnchor(input.currentPatch, match);
    if (fingerprint === undefined) {
      attentionItemIds.push(item.id);
      items.push(attention("fingerprint_missing"));
      continue;
    }
    const { attention: _previousAttention, ...itemWithoutAttention } = item;
    void _previousAttention;
    items.push({
      ...itemWithoutAttention,
      anchor: match,
      fingerprint,
      postability: "postable",
      carriedFrom,
    });
  }
  return {
    attentionItemIds,
    batch: {
      sessionId: input.targetSessionId,
      state: input.source.state,
      summaryBody: input.source.summaryBody,
      suggestedEvent: input.source.suggestedEvent,
      items,
      receipts: input.source.receipts,
      createdAt: input.source.createdAt,
      updatedAt: input.now,
    },
  };
}

function sameLines(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function patchLines(patch: string): ReadonlyArray<PatchLine> {
  const lines: PatchLine[] = [];
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  let hunk = 0;

  for (const raw of patch.split("\n")) {
    const fileHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
    if (fileHeader !== null) {
      oldPath = fileHeader[1];
      newPath = fileHeader[2];
      continue;
    }
    if (raw.startsWith("--- ")) {
      oldPath = patchPath(raw.slice(4));
      continue;
    }
    if (raw.startsWith("+++ ")) {
      newPath = patchPath(raw.slice(4));
      continue;
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header !== null) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunk += 1;
      continue;
    }
    if (hunk === 0 || raw.startsWith("\\") || oldPath === undefined || newPath === undefined) continue;
    if (raw.startsWith("-")) {
      if (oldPath !== "/dev/null") lines.push({ path: oldPath, side: "old", line: oldLine, text: raw.slice(1), hunk });
      oldLine += 1;
    } else if (raw.startsWith("+")) {
      if (newPath !== "/dev/null") lines.push({ path: newPath, side: "new", line: newLine, text: raw.slice(1), hunk });
      newLine += 1;
    } else if (raw.startsWith(" ")) {
      if (oldPath !== "/dev/null") lines.push({ path: oldPath, side: "old", line: oldLine, text: raw.slice(1), hunk });
      if (newPath !== "/dev/null") lines.push({ path: newPath, side: "new", line: newLine, text: raw.slice(1), hunk });
      oldLine += 1;
      newLine += 1;
    }
  }
  return lines;
}

function patchPath(value: string): string {
  const path = value.split("\t", 1)[0] ?? value;
  return path === "/dev/null" ? path : path.replace(/^[ab]\//, "");
}
