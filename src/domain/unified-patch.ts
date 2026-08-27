/**
 * The unified-diff grammar the Patchdesk *projections converted so far* read —
 * finding locations, walkthrough hunks, anchor fingerprints, byte slices, the
 * accessible renderer list, and the changed-file list handed to a review
 * context — so one definition decides what a `diff --git` header, a rename, a
 * binary marker, an `@@` hunk header, and a body line are.
 *
 * This is a boundary being moved, not one already reached. Six readers of the
 * same grammar still sit outside it. Only the first is outside on purpose; the
 * rest are unconverted. The list is what a sweep for the grammar's own shapes
 * found — hunk-header patterns, `@@` byte codes, `--- `/`+++ ` prefixes, and
 * the rename, binary, and no-newline markers — not a proof that no other
 * reader remains.
 *
 * - `matchesPatch` in `src/services/review-diff-source-service.ts` walks `@@`
 *   headers and body lines by hand to *verify* that a patch describes the two
 *   file contents it was hydrated from. It carries a fourth, unreconciled rule
 *   — an unmarked body line advances neither side, where every projection here
 *   advances both — and its own doc comment records that a mismatch is a
 *   virtualizer crash, so reconciling it needs evidence this file cannot
 *   supply. It checks a patch; it does not project one.
 * - `ReviewDiffSourceService.load`, in that same file, tests
 *   `/^--- \/dev\/null$/m` and `/^\+\+\+ \/dev\/null$/m` to decide whether a
 *   whole side of the file exists, and so whether the old blob is fetched at
 *   all. The `m` flag reaches hunk bodies, so on unedited `git diff` output,
 *   deleting a line whose own text is `-- /dev/null` already reads as an
 *   absent old side.
 * - `countUnifiedDiffHunks` in `src/services/walkthrough-timeout.ts` re-encodes
 *   "a line beginning `@@ `" as raw byte codes so it can count hunks while
 *   streaming, without holding the patch in memory.
 * - `src/services/walkthrough-operation.ts` counts `/^@@ /gm` beside a
 *   `narrativeHunkManifest` that already holds that count.
 * - `src/services/review-commit-service.ts` decides "binary only" from
 *   unanchored `includes` tests that disagree with the `binary` rule here.
 * - `countChangedFiles` in `src/services/github-revision-identity-reader.ts`
 *   filters lines by a `diff --git ` prefix instead of `isUnifiedFileHeader`.
 */

/** The line ranges one `@@` hunk header declares. */
export type UnifiedHunkRange = {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
};

/** How one hunk-body line is prefixed. `other` covers a body line with no marker. */
type UnifiedBodyMarker =
  | "context"
  | "added"
  | "removed"
  | "no_newline"
  | "other";

type TokenSite = {
  /** Index of this line in the tokenized line array. */
  readonly index: number;
  readonly raw: string;
};

/** One classified line of a unified patch. */
export type UnifiedPatchToken =
  | (TokenSite & {
      readonly kind: "file_header";
      /** Absent when the `diff --git` line carries no readable path pair. */
      readonly oldPath?: string;
      readonly newPath?: string;
    })
  | (TokenSite & { readonly kind: "old_file_path"; readonly path: string })
  | (TokenSite & { readonly kind: "new_file_path"; readonly path: string })
  | (TokenSite & { readonly kind: "rename_from"; readonly path: string })
  | (TokenSite & { readonly kind: "rename_to"; readonly path: string })
  | (TokenSite & { readonly kind: "binary" })
  | (TokenSite & { readonly kind: "omitted" })
  | (TokenSite & { readonly kind: "submodule" })
  | (TokenSite & {
      readonly kind: "hunk_header";
      readonly range: UnifiedHunkRange;
    })
  | (TokenSite & {
      readonly kind: "body";
      readonly marker: UnifiedBodyMarker;
      /** The line content with its marker removed. */
      readonly text: string;
      /** Old-side line number this body line occupies, absent for added lines. */
      readonly oldLine?: number;
      /** New-side line number this body line occupies, absent for removed lines. */
      readonly newLine?: number;
    })
  | (TokenSite & { readonly kind: "other" });

const fileHeaderPrefix = "diff --git ";
const submodulePattern =
  /^Submodule [^\s]+ [0-9a-f]+\.{2,3}[0-9a-f]+(?: \([^)]*\))?$/;
const hunkHeaderPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const barePathPairPattern = /^a\/(.+) b\/(.+)$/;
const quotedPathPairPattern = /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/;

/** True for any line git would emit as the start of a new file section. */
export function isUnifiedFileHeader(line: string): boolean {
  return line.startsWith(fileHeaderPrefix);
}

/**
 * The old and new path a `diff --git` header names, for both the bare
 * `a/x b/x` form and the C-quoted `"a/x" "b/x"` form git uses for paths that
 * need escaping.
 */
export function matchUnifiedFileHeader(
  line: string,
): { readonly oldPath: string; readonly newPath: string } | undefined {
  if (!isUnifiedFileHeader(line)) return undefined;
  const rest = line.slice(fileHeaderPrefix.length);
  const quoted = quotedPathPairPattern.exec(rest);
  if (quoted !== null) {
    const oldPath = stripSidePrefix(unquotePatchPath(quoted[1] ?? ""), "a/");
    const newPath = stripSidePrefix(unquotePatchPath(quoted[2] ?? ""), "b/");
    return { oldPath, newPath };
  }
  // Both sides name the same path unless the header describes a rename, so an
  // even split beats the greedy match whenever a path itself contains " b/".
  if (rest.length % 2 === 1) {
    const half = (rest.length - 1) / 2;
    const left = rest.slice(0, half);
    const right = rest.slice(half + 1);
    if (
      left.startsWith("a/") &&
      right.startsWith("b/") &&
      left.slice(2) === right.slice(2)
    )
      return { oldPath: left.slice(2), newPath: right.slice(2) };
  }
  const bare = barePathPairPattern.exec(rest);
  if (bare === null) return undefined;
  return { oldPath: bare[1] ?? "", newPath: bare[2] ?? "" };
}

/** The line range a `@@` header declares, with git's omitted counts defaulted to 1. */
function matchUnifiedHunkHeader(line: string): UnifiedHunkRange | undefined {
  const match = hunkHeaderPattern.exec(line);
  if (match === null) return undefined;
  return {
    oldStart: Number(match[1]),
    oldLines: Number(match[2] ?? "1"),
    newStart: Number(match[3]),
    newLines: Number(match[4] ?? "1"),
  };
}

/** The path a `--- ` or `+++ ` line names, with its side prefix and trailing timestamp removed. */
function parseUnifiedSidePath(value: string): string {
  const withoutStamp = value.split("\t", 1)[0] ?? value;
  const path = unquotePatchPath(stripSurroundingQuotes(withoutStamp));
  return path === "/dev/null" ? path : path.replace(/^[ab]\//, "");
}

/** Tokenize a whole patch string. */
export function tokenizeUnifiedPatch(
  patch: string,
): ReadonlyArray<UnifiedPatchToken> {
  return tokenizeUnifiedPatchLines(patch.split("\n"));
}

/**
 * Tokenize lines already split by the caller, so callers that slice the patch by
 * line index (walkthrough hunks) read token indices into their own array.
 */
export function tokenizeUnifiedPatchLines(
  lines: ReadonlyArray<string>,
): ReadonlyArray<UnifiedPatchToken> {
  const tokens: Array<UnifiedPatchToken> = [];
  let inHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;
  let oldLine = 0;
  let newLine = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    if (isUnifiedFileHeader(raw)) {
      inHunk = false;
      oldRemaining = 0;
      newRemaining = 0;
      const paths = matchUnifiedFileHeader(raw);
      tokens.push(
        paths === undefined
          ? { kind: "file_header", index, raw }
          : {
              kind: "file_header",
              index,
              raw,
              oldPath: paths.oldPath,
              newPath: paths.newPath,
            },
      );
      continue;
    }
    const range = matchUnifiedHunkHeader(raw);
    if (range !== undefined) {
      inHunk = true;
      oldRemaining = range.oldLines;
      newRemaining = range.newLines;
      oldLine = range.oldStart;
      newLine = range.newStart;
      tokens.push({ kind: "hunk_header", index, raw, range });
      continue;
    }
    // A hunk body only runs for the line count its header declared. Past that
    // count the file-prefix markers below become readable again, so a deleted
    // line whose own text begins with `--- ` is never mistaken for a path line.
    const inBody = inHunk && (oldRemaining > 0 || newRemaining > 0);
    if (!inBody) {
      const prefix = prefixToken(raw, index);
      if (prefix !== undefined) {
        tokens.push(prefix);
        continue;
      }
    }
    if (!inHunk) {
      tokens.push({ kind: "other", index, raw });
      continue;
    }
    if (raw.startsWith("\\")) {
      tokens.push({
        kind: "body",
        index,
        raw,
        marker: "no_newline",
        text: raw,
      });
      continue;
    }
    if (raw.startsWith("-")) {
      tokens.push({
        kind: "body",
        index,
        raw,
        marker: "removed",
        text: raw.slice(1),
        oldLine,
      });
      oldLine += 1;
      oldRemaining -= 1;
      continue;
    }
    if (raw.startsWith("+")) {
      tokens.push({
        kind: "body",
        index,
        raw,
        marker: "added",
        text: raw.slice(1),
        newLine,
      });
      newLine += 1;
      newRemaining -= 1;
      continue;
    }
    // An unmarked body line is a context line whose leading space was stripped;
    // it advances both sides so every projection agrees on later line numbers.
    tokens.push({
      kind: "body",
      index,
      raw,
      marker: raw.startsWith(" ") ? "context" : "other",
      text: raw.startsWith(" ") ? raw.slice(1) : raw,
      oldLine,
      newLine,
    });
    oldLine += 1;
    newLine += 1;
    oldRemaining -= 1;
    newRemaining -= 1;
  }
  return tokens;
}

function prefixToken(
  raw: string,
  index: number,
): UnifiedPatchToken | undefined {
  if (raw.startsWith("--- "))
    return {
      kind: "old_file_path",
      index,
      raw,
      path: parseUnifiedSidePath(raw.slice(4)),
    };
  if (raw.startsWith("+++ "))
    return {
      kind: "new_file_path",
      index,
      raw,
      path: parseUnifiedSidePath(raw.slice(4)),
    };
  if (raw.startsWith("rename from "))
    return {
      kind: "rename_from",
      index,
      raw,
      path: raw.slice("rename from ".length),
    };
  if (raw.startsWith("rename to "))
    return {
      kind: "rename_to",
      index,
      raw,
      path: raw.slice("rename to ".length),
    };
  if (raw.startsWith("Binary files ")) return { kind: "binary", index, raw };
  if (raw === "GIT binary patch" || raw.includes("diff too large"))
    return { kind: "omitted", index, raw };
  if (submodulePattern.test(raw)) return { kind: "submodule", index, raw };
  return undefined;
}

function stripSurroundingQuotes(value: string): string {
  return value.length > 1 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function stripSidePrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

const escapeCharacters = new Map<string, string>([
  ["a", "\u0007"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ["\\", "\\"],
  ['"', '"'],
]);

/** Decode the C-style quoting git applies to paths that need escaping. */
function unquotePatchPath(value: string): string {
  if (!value.includes("\\")) return value;
  const bytes: Array<number> = [];
  const encoder = new TextEncoder();
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character !== "\\") {
      for (const byte of encoder.encode(character)) bytes.push(byte);
      continue;
    }
    const next = value[index + 1] ?? "";
    const escaped = escapeCharacters.get(next);
    if (escaped !== undefined) {
      for (const byte of encoder.encode(escaped)) bytes.push(byte);
      index += 1;
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(value.slice(index + 1, index + 4))?.[0];
    if (octal === undefined) {
      bytes.push(0x5c);
      continue;
    }
    bytes.push(Number.parseInt(octal, 8) & 0xff);
    index += octal.length;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
