import { withTrailingNewline } from "./finding-suggestion";
import { err, ok, type Result } from "./result";

/** Unchanged lines around each replaced range, as `git diff` writes by default. */
const HUNK_CONTEXT_LINES = 3;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/** One verified suggestion: the new-side range it replaces and the code that replaces it. */
export type LocalApplyEdit = {
  readonly startLine: number;
  readonly line: number;
  /** The range's text as the session patch shows it; the file must still hold exactly this. */
  readonly originalLines: ReadonlyArray<string>;
  readonly code: string;
};

/** A file's expected post-image and the patch `git apply` turns its current text into it with. */
export type LocalApplyFileChange = {
  readonly postImage: string;
  readonly patch: string;
};

export type LocalApplyCompositionFailure =
  /** Two edits of the file share a line. */
  | "overlapping"
  /** The file no longer holds the lines a suggestion was verified against. */
  | "target_mismatch";

type IndexedEdit = {
  /** Zero-based index of the first replaced line in the current file. */
  readonly start: number;
  /** Zero-based index one past the last replaced line. */
  readonly end: number;
  readonly replacement: ReadonlyArray<string>;
};

/**
 * Builds one file's post-image and a unified patch from its current text.
 * The patch is composed from the file itself rather than from the stored
 * session patch, which is decoded and size-capped (#451); context lines make
 * `git apply` refuse a file that changed after this was composed.
 */
export function composeLocalApplyFileChange(
  path: string,
  content: string,
  edits: ReadonlyArray<LocalApplyEdit>,
): Result<LocalApplyFileChange, LocalApplyCompositionFailure> {
  const sorted = [...edits].sort(
    (left, right) => left.startLine - right.startLine,
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const next = sorted[index];
    if (
      previous !== undefined &&
      next !== undefined &&
      next.startLine <= previous.line
    )
      return err("overlapping");
  }
  const lines = content.split("\n");
  const endsWithNewline = lines.at(-1) === "";
  if (endsWithNewline) lines.pop();
  const indexed: IndexedEdit[] = [];
  for (const edit of sorted) {
    const start = edit.startLine - 1;
    if (
      edit.line > lines.length ||
      edit.originalLines.length !== edit.line - start ||
      edit.originalLines.some((text, offset) => lines[start + offset] !== text)
    )
      return err("target_mismatch");
    const replacement = withTrailingNewline(edit.code).split("\n");
    replacement.pop();
    indexed.push({ start, end: edit.line, replacement });
  }
  const postLines: string[] = [];
  let cursor = 0;
  for (const edit of indexed) {
    postLines.push(...lines.slice(cursor, edit.start), ...edit.replacement);
    cursor = edit.end;
  }
  postLines.push(...lines.slice(cursor));
  const hunks = groupIntoHunks(indexed, lines.length).map((group) =>
    renderHunk(group, lines, endsWithNewline),
  );
  return ok({
    postImage: `${postLines.join("\n")}${endsWithNewline ? "\n" : ""}`,
    patch: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      ...hunks,
      "",
    ].join("\n"),
  });
}

type HunkGroup = {
  readonly oldStart: number;
  readonly oldEnd: number;
  /** Lines the edits before this hunk add or remove, which shift its new-side start. */
  readonly shift: number;
  readonly edits: ReadonlyArray<IndexedEdit>;
};

/** Edits whose context would touch share one hunk, as `git diff` merges them. */
function groupIntoHunks(
  edits: ReadonlyArray<IndexedEdit>,
  lineCount: number,
): ReadonlyArray<HunkGroup> {
  const groups: HunkGroup[] = [];
  let shift = 0;
  for (const edit of edits) {
    const oldStart = Math.max(0, edit.start - HUNK_CONTEXT_LINES);
    const oldEnd = Math.min(lineCount, edit.end + HUNK_CONTEXT_LINES);
    const last = groups.at(-1);
    if (last !== undefined && oldStart <= last.oldEnd)
      groups[groups.length - 1] = {
        ...last,
        oldEnd,
        edits: [...last.edits, edit],
      };
    else groups.push({ oldStart, oldEnd, shift, edits: [edit] });
    shift += edit.replacement.length - (edit.end - edit.start);
  }
  return groups;
}

function renderHunk(
  group: HunkGroup,
  lines: ReadonlyArray<string>,
  endsWithNewline: boolean,
): string {
  const body: string[] = [];
  const endsFile = (index: number) =>
    !endsWithNewline && index === lines.length - 1;
  const context = (index: number) => {
    body.push(` ${lines[index] ?? ""}`);
    if (endsFile(index)) body.push(NO_NEWLINE_MARKER);
  };
  let oldCount = 0;
  let newCount = 0;
  let index = group.oldStart;
  for (const edit of group.edits) {
    for (; index < edit.start; index += 1) context(index);
    for (; index < edit.end; index += 1) body.push(`-${lines[index] ?? ""}`);
    if (endsFile(edit.end - 1)) body.push(NO_NEWLINE_MARKER);
    body.push(...edit.replacement.map((text) => `+${text}`));
    if (endsFile(edit.end - 1)) body.push(NO_NEWLINE_MARKER);
    oldCount += edit.end - edit.start;
    newCount += edit.replacement.length;
  }
  for (; index < group.oldEnd; index += 1) context(index);
  const contextCount =
    group.oldEnd -
    group.oldStart -
    group.edits.reduce((sum, edit) => sum + edit.end - edit.start, 0);
  oldCount += contextCount;
  newCount += contextCount;
  return [
    `@@ -${group.oldStart + 1},${oldCount} +${group.oldStart + group.shift + 1},${newCount} @@`,
    ...body,
  ].join("\n");
}
