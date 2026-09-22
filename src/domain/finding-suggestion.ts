import type { FindingLocationInput } from "./patch";
import { tokenizeUnifiedPatch, type UnifiedPatchToken } from "./unified-patch";

/**
 * The largest replacement code a Finding may carry, in UTF-8 bytes. A
 * suggestion stands in for the few lines the Finding cites, and the whole
 * Analysis result travels through the provider contract and the retained
 * result, so an unbounded replacement is a size risk rather than a feature.
 */
export const SUGGESTED_REPLACEMENT_MAX_BYTES = 4096;

const CODE_FENCE = "```";

/** The new-side lines a verified suggestion replaces, read from the patch itself. */
type SuggestionTarget = {
  readonly path: string;
  readonly startLine: number;
  readonly line: number;
  /** The patch's own text for each replaced line, in order. */
  readonly originalLines: ReadonlyArray<string>;
};

/**
 * The contiguous new-side range a Finding's suggestion would replace, taken
 * from the represented patch rather than from anything the model or the
 * renderer supplied. Undefined unless the Finding cites the new side, its file
 * appears in the patch, and every cited line sits in one hunk of that file: a
 * range that spans two hunks has no single anchor GitHub can accept.
 */
export function resolveSuggestionTarget(
  patch: string,
  finding: FindingLocationInput,
): SuggestionTarget | undefined {
  if (finding.file === undefined || finding.lineStart === undefined)
    return undefined;
  if ((finding.diffSide ?? "new") !== "new") return undefined;
  const startLine = finding.lineStart;
  const line = finding.lineEnd ?? startLine;
  if (startLine < 1 || line < startLine) return undefined;
  const tokens = tokenizeUnifiedPatch(patch);
  let file: Extract<UnifiedPatchToken, { kind: "file_header" }> | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) break;
    if (token.kind === "file_header") {
      file = token;
      continue;
    }
    if (file === undefined) continue;
    if (token.kind === "binary" || token.kind === "omitted") {
      file = undefined;
      continue;
    }
    if (token.kind !== "hunk_header") continue;
    if (file.newPath === undefined) continue;
    if (file.newPath !== finding.file && file.oldPath !== finding.file)
      continue;
    const originalLines = hunkNewSideLines(tokens, index, startLine, line);
    if (originalLines === undefined) continue;
    return { path: file.newPath, startLine, line, originalLines };
  }
  return undefined;
}

/** One hunk's new-side text for `startLine..line`, or undefined when that hunk does not hold the whole range. */
function hunkNewSideLines(
  tokens: ReadonlyArray<UnifiedPatchToken>,
  hunkHeaderIndex: number,
  startLine: number,
  line: number,
): ReadonlyArray<string> | undefined {
  const texts = new Map<number, string>();
  for (let index = hunkHeaderIndex + 1; index < tokens.length; index += 1) {
    const body = tokens[index];
    if (body === undefined) break;
    if (body.kind === "file_header" || body.kind === "hunk_header") break;
    if (body.kind !== "body" || body.marker === "no_newline") continue;
    if (body.newLine === undefined) continue;
    if (body.newLine < startLine || body.newLine > line) continue;
    texts.set(body.newLine, body.text);
  }
  const lines: Array<string> = [];
  for (let number = startLine; number <= line; number += 1) {
    const text = texts.get(number);
    if (text === undefined) return undefined;
    lines.push(text);
  }
  return lines;
}

/**
 * Whether replacement code can be serialized into a GitHub `suggestion` block
 * at all. A line that opens a fence would close the block early, so fenced
 * code is refused rather than escaped.
 */
export function isAcceptableSuggestionCode(code: string): boolean {
  if (code.length === 0) return false;
  if (new TextEncoder().encode(code).length > SUGGESTED_REPLACEMENT_MAX_BYTES)
    return false;
  return !code.split("\n").some((line) => line.startsWith(CODE_FENCE));
}

/**
 * The one GitHub comment body a verified suggestion is published as: the
 * reviewer's comment, then a single fenced `suggestion` block holding the
 * exact replacement. Every caller serializes the fence here, so no other code
 * decides what a suggestion block looks like.
 */
export function renderSuggestionCommentBody(
  comment: string,
  code: string,
): string {
  const body = code.endsWith("\n") ? code : `${code}\n`;
  return `${comment.trim()}\n\n${CODE_FENCE}suggestion\n${body}${CODE_FENCE}`;
}
