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
