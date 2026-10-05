/**
 * Escapes an untrusted PR filename for a double-quoted CSS attribute selector.
 * Quotes and backslashes are escaped; C0 and DEL controls use CSS hex escapes
 * so they cannot end the string or inject CSS into the shadow root. The space
 * after each hex escape is mandatory: it terminates the escape before a
 * following hex digit or literal space.
 *
 * A NUL hex-escapes to `\0`, which CSS decodes to U+FFFD rather than U+0000.
 * Its selector would not match, but remains a single string token; filesystems
 * reject NUL paths, so do not weaken escaping to special-case it.
 * https://www.w3.org/TR/css-syntax-3/#consume-escaped-code-point
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

/**
 * In a PR diff every folder contains a change, so the library's folder dot
 * carries nothing; dropping its lane gives the folder name that width (#448).
 */
export const FOLDER_GIT_DOT_TREE_STYLE = `[data-item-type="folder"]:not([data-item-git-status]) > [data-item-section="git"] { display: none; }`;

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
 * Truncates the filename stem from the start: `sidebar-variant-a-tree.tsx`
 * reads `…variant-a-tree.tsx`, unlike the library's middle split at the
 * extension, which makes sibling names look alike. The trailing LRM keeps the
 * stem's final `.` on the right of the RTL box; the hidden measured copy also
 * gets it so kerning yields the same width.
 *
 * #448 requires an edge-aligned ellipsis with no cut or faded letter.
 * Chromium's `text-overflow` cuts whole glyphs but places its ellipsis beside
 * the text. The box's native ellipsis is transparent while the name's inline
 * element retains its color; the library's overflow-only marker draws "…" at
 * the left edge. A gap smaller than one letter may remain.
 */
export const FILE_NAME_TREE_STYLE = [
  `[data-truncate-segment-priority="2"] { --truncate-marker-fade-width: 0px; --truncate-middle-marker-opacity: 100%; }`,
  `[data-truncate-segment-priority="2"] [data-truncate-grid] > :has(> [data-truncate-content="visible"]) { direction: rtl; overflow: hidden; text-overflow: ellipsis; -webkit-text-fill-color: transparent; }`,
  `[data-truncate-segment-priority="2"] [data-truncate-content="visible"] { display: inline; -webkit-text-fill-color: currentColor; }`,
  `[data-truncate-segment-priority="2"] [data-truncate-content]::after { content: "\\200E"; }`,
  // The rtl box that cuts from the start would otherwise reorder a name that begins with digits (535-alpha.md read as alpha.-535md).
  `[data-truncate-segment-priority="2"] [data-truncate-content] { unicode-bidi: isolate; direction: ltr; }`,
  `[data-truncate-segment-priority="2"] [data-truncate-marker] { left: 0; right: auto; }`,
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
