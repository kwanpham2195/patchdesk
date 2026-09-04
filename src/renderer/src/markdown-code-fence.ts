/** How one line of a ```diff fence should be tinted. */
export type DiffFenceLineKind = "added" | "removed" | "meta" | "context";

/**
 * Normalises a fence's info string to a language name.
 *
 * GitHub lets an info string carry more than the language (`ts copy`), and
 * authors write the language in any case. Anything unrecognised is left for
 * the highlighter to reject, which falls back to plain text.
 */
export function fencedCodeLanguage(
  info: string | undefined,
): string | undefined {
  const first = info?.trim().split(/\s+/)[0]?.toLowerCase();
  return first === undefined || first.length === 0 ? undefined : first;
}

/**
 * Classifies one line of a ```diff fence.
 *
 * A fence written by hand in a comment carries no `diff --git` and no `@@`,
 * so this reads the leading character rather than parsing a patch. The file
 * header markers `+++` and `---` are checked before the single-character `+`
 * and `-` cases, or a header would tint as a changed line.
 */
export function classifyDiffLine(line: string): DiffFenceLineKind {
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("@@") ||
    line.startsWith("diff ") ||
    line.startsWith("index ")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

/** Splits fence content into classified lines, keeping every line's own text. */
export function classifyDiffFence(
  code: string,
): ReadonlyArray<{ readonly text: string; readonly kind: DiffFenceLineKind }> {
  return code
    .split("\n")
    .map((text) => ({ text, kind: classifyDiffLine(text) }));
}
