/**
 * Escapes a file path for interpolation into a double-quoted CSS
 * attribute-selector string, e.g. `[data-item-path="<escaped>"]`.
 *
 * File paths are attacker-controllable content (a PR author picks its own
 * filenames), so without escaping, a path containing `"`, `\`, or a newline
 * could break out of the selector string and inject arbitrary CSS into the
 * shadow root. Backslash and the quote character are backslash-escaped;
 * every other C0 control character (newline included) is emitted as a CSS
 * hex escape, which keeps the result a single valid CSS string token
 * regardless of what the path contains. The trailing space after each hex
 * escape is mandatory, not cosmetic: it is the escape's terminator, so a
 * control character immediately followed by a literal hex digit (or by a
 * literal space) can never be misread as part of the hex sequence.
 *
 * A NUL byte (0x00) hex-escapes to `\0`, which a CSS parser decodes back to
 * U+FFFD (the replacement character), not U+0000
 * (https://www.w3.org/TR/css-syntax-3/#consume-escaped-code-point) -- so a
 * NUL-containing path would not match its own generated selector. This is
 * not exploitable (the mismatch stays inside the string; nothing escapes
 * the selector), and filesystems reject NUL in paths anyway, so it is left
 * as-is rather than special-cased. Noted here only so a future "fix" to
 * this function does not reintroduce something worse trying to "correct" it.
 */
export function escapeCssAttributeValue(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\" || char === '"') result += `\\${char}`;
    else if (code <= 0x1f || code === 0x7f) result += `\\${code.toString(16)} `;
    else result += char;
  }
  return result;
}

/**
 * Resets the filename back to the tree's normal foreground.
 *
 * @pierre/trees' own `[data-item-git-status] > [data-item-section="content"]`
 * rule paints the git-status hue onto the filename as well as onto the status
 * marker, so in a PR diff -- where nearly every file is Modified -- the whole
 * tree collapses into one saturated colour and loses its reading contrast for
 * information the marker lane already carries. Only the `content` section is
 * reset; the `git` section keeps its hue.
 */
export const GIT_STATUS_LABEL_TREE_STYLE = `[data-item-git-status] > [data-item-section="content"] { color: var(--trees-fg); }`;

/** In a PR diff every folder contains a change, so the library's folder dot carries nothing. */
export const FOLDER_GIT_DOT_TREE_STYLE = `[data-item-contains-git-change="true"]:not([data-item-git-status]) > [data-item-section="git"] > * { display: none; }`;

/**
 * Clips a flattened folder row from the left as one path, so
 * `src / renderer / src / components` reads `…derer / src / components`.
 *
 * The library truncates every segment separately, which leaves
 * `…/ren…/s…/components`. An RTL line with left alignment overflows at its
 * start and takes `text-overflow` there; the trailing LRM keeps the separators
 * in path order, and inline, non-isolating segments keep them one bidi run.
 */
export const FLATTENED_PATH_TREE_STYLE = [
  `[data-item-flattened-subitems] { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; direction: rtl; text-align: left; }`,
  `[data-item-flattened-subitems]::after { content: "\\200E"; }`,
  `[data-item-flattened-subitem], [data-item-flattened-subitem] * { display: inline; min-width: 0; unicode-bidi: normal; }`,
  `[data-item-flattened-subitem] [data-truncate-content="overflow"], [data-item-flattened-subitem] [data-truncate-marker-cell] { display: none; }`,
].join(" ");

/**
 * Truncates a file name's stem from the start instead of the end, so
 * `sidebar-variant-a-tree.tsx` reads `…variant-a-tree.tsx`.
 *
 * The library hard-codes a middle truncation split at the extension, which
 * shows the stem's shared prefix and turns sibling files into identical
 * `sidebar-variant…tsx` rows. The trailing LRM keeps the stem's final `.` on
 * the right inside the RTL box.
 */
export const FILE_NAME_TREE_STYLE = [
  `[data-truncate-segment-priority="2"] [data-truncate-content="visible"] { direction: rtl; }`,
  `[data-truncate-segment-priority="2"] [data-truncate-content="visible"]::after { content: "\\200E"; }`,
  `[data-truncate-segment-priority="2"] [data-truncate-marker] { left: 0; right: auto; }`,
  `[data-truncate-segment-priority="2"] [data-truncate-container] { --truncate-marker-gap: 1px; }`,
].join(" ");

/**
 * Builds the shadow-root CSS rule that highlights the active file's row the
 * same way @pierre/trees highlights a selected row (same `--trees-selected-*`
 * custom properties), without going through its selection state -- and
 * neutralizes any other row still carrying the library's own stale
 * `data-item-selected="true"` state.
 *
 * @pierre/trees sets that attribute itself on a real click, and never
 * updates it again on its own: clicking a row and then scrolling elsewhere
 * (passive active-file follow) would otherwise leave the clicked row's
 * selected styling in place forever, alongside the active row's highlight
 * below -- two "selected-looking" rows at once. Resetting every such stale
 * row back to the library's own non-selected/non-hover row look keeps this
 * stylesheet the sole source of truth for which row looks highlighted.
 */
export function buildActivePathTreeStyle(path: string): string {
  const escapedPath = escapeCssAttributeValue(path);
  const activeRowSelector = `[data-type="item"][data-item-path="${escapedPath}"]`;
  const staleSelectedRowSelector = `[data-type="item"][data-item-selected="true"]:not([data-item-path="${escapedPath}"])`;
  return (
    `${staleSelectedRowSelector} { ` +
    `color: var(--trees-fg); ` +
    // @pierre/trees' own base row style sets `background-color:
    // var(--trees-bg)` unconditionally (for virtualized-scroll overdraw),
    // not `transparent` -- matching that, rather than `transparent`, is
    // what makes a neutralized row indistinguishable from a row that was
    // never selected at all.
    `background-color: var(--trees-bg); ` +
    `--truncate-marker-background-overlay-color: transparent; ` +
    `} ` +
    `${staleSelectedRowSelector} [data-item-section="icon"] { ` +
    `color: var(--trees-fg-muted); ` +
    `} ` +
    `${activeRowSelector} { ` +
    `color: var(--trees-selected-fg); ` +
    `background-color: var(--trees-selected-bg); ` +
    `--truncate-marker-background-overlay-color: var(--trees-selected-bg); ` +
    `} ` +
    `${activeRowSelector} [data-item-section="icon"] { ` +
    `color: var(--trees-selected-fg); ` +
    `}`
  );
}
