import { describe, expect, it } from "vitest";

import {
  buildActivePathTreeStyle,
  escapeCssAttributeValue,
} from "../../src/renderer/src/components/pierre-file-tree-active-style";

describe("escapeCssAttributeValue", () => {
  it("leaves an ordinary path untouched", () => {
    expect(escapeCssAttributeValue("src/components/pierre-file-tree.tsx")).toBe(
      "src/components/pierre-file-tree.tsx",
    );
  });

  it("backslash-escapes a double quote so it cannot close the attribute string early", () => {
    expect(escapeCssAttributeValue('src/weird"file.ts')).toBe(
      'src/weird\\"file.ts',
    );
  });

  it("backslash-escapes a literal backslash so it cannot start a bogus escape", () => {
    expect(escapeCssAttributeValue("src\\weird\\file.ts")).toBe(
      "src\\\\weird\\\\file.ts",
    );
  });

  it("hex-escapes a newline so it cannot terminate the CSS string token", () => {
    expect(escapeCssAttributeValue("src/weird\nfile.ts")).toBe(
      "src/weird\\a file.ts",
    );
  });

  it("hex-escapes every C0 control character it finds, in the order given", () => {
    expect(escapeCssAttributeValue("a\tb\rc")).toBe("a\\9 b\\d c");
  });

  it("hex-escapes a form feed the same way as other C0 controls", () => {
    // Form feed (0x0c) takes the same `code <= 0x1f` branch as tab/CR/LF but
    // had no case of its own -- assert it explicitly rather than trusting
    // the range check by inference from its neighbors.
    expect(escapeCssAttributeValue("a\fb")).toBe("a\\c b");
  });

  it("terminates a hex escape with a space even when the next real character is itself a hex digit", () => {
    // Without the mandatory trailing space, "\x1f" (escaped) followed by a
    // literal "f" would read back as the 3-hex-digit escape "1ff" -- silently
    // swallowing the literal character into the control character's escape.
    const escaped = escapeCssAttributeValue("\x1ff");
    expect(escaped).toBe("\\1f f");
    expect(decodeCssStringToken(escaped)).toEqual({
      text: "\x1ff",
      endedEarly: false,
    });
  });

  it("terminates a hex escape with a space even when the next real character is itself a literal space", () => {
    // The escape's own terminator space and the path's own literal space
    // must both survive round-tripping as two distinct space characters,
    // not collapse into one.
    const escaped = escapeCssAttributeValue("\x1f ");
    expect(escaped).toBe("\\1f  ");
    expect(decodeCssStringToken(escaped)).toEqual({
      text: "\x1f ",
      endedEarly: false,
    });
  });

  it("never lets an unescaped quote terminate the generated CSS string token early", () => {
    const adversarial = 'src/"; } * { color: red; } /*\\\n.ts';
    const escaped = escapeCssAttributeValue(adversarial);
    // `decodeCssStringToken` models where a real CSS parser would stop
    // reading this string token: at the first unescaped `"`. Round-tripping
    // alone is not enough to prove no injection is possible -- a decoder
    // that (like a bug once present here) only understands backslash
    // escapes and copies an unescaped `"` straight through would still
    // round-trip correctly, because it never treats the quote as
    // significant. Asserting `endedEarly: false` is what actually proves no
    // unescaped `"` reached the output: if `escapeCssAttributeValue`
    // regressed to no longer escaping `"`, this decoder would stop at that
    // quote, `endedEarly` would flip to `true`, and `text` would come back
    // truncated instead of matching `adversarial`.
    const decoded = decodeCssStringToken(escaped);
    expect(decoded.endedEarly).toBe(false);
    expect(decoded.text).toBe(adversarial);
  });
});

/**
 * A minimal decoder that models CSS string-token consumption
 * (https://www.w3.org/TR/css-syntax-3/#consume-a-string-token and
 * https://www.w3.org/TR/css-syntax-3/#consume-escaped-code-point), used only
 * by these tests to verify both that `escapeCssAttributeValue`'s output
 * decodes back to the original text, and -- separately -- that no unescaped
 * `"` in it would terminate the string token before the end of the input.
 *
 * `endedEarly: true` means an unescaped `"` was found before `value` was
 * fully consumed, i.e. a real CSS parser would stop reading the string
 * there and parse whatever follows as further CSS, not string content.
 */
function decodeCssStringToken(value: string) {
  let result = "";
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (char === '"') return { text: result, endedEarly: true };
    if (char !== "\\") {
      result += char;
      index += 1;
      continue;
    }
    index += 1;
    const hexMatch = /^[0-9a-fA-F]{1,6}/.exec(value.slice(index));
    if (hexMatch === null) {
      // `\<char>` (including `\"` and `\\`) is a literal-character escape.
      result += value[index] ?? "";
      index += 1;
      continue;
    }
    const codePoint = parseInt(hexMatch[0], 16);
    // A hex escape of 0, a surrogate, or an out-of-range code point decodes
    // to U+FFFD, not to that literal code point.
    result +=
      codePoint === 0 ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint > 0x10ffff
        ? "�"
        : String.fromCodePoint(codePoint);
    index += hexMatch[0].length;
    // A single trailing whitespace character after a hex escape terminates
    // the escape rather than being literal content.
    if (/\s/.test(value[index] ?? "")) index += 1;
  }
  return { text: result, endedEarly: false };
}

describe("buildActivePathTreeStyle", () => {
  it("targets the active row by its escaped data-item-path and reuses the selected-row custom properties", () => {
    const style = buildActivePathTreeStyle("src/a.ts");
    expect(style).toContain('[data-type="item"][data-item-path="src/a.ts"]');
    expect(style).toContain("color: var(--trees-selected-fg)");
    expect(style).toContain("background-color: var(--trees-selected-bg)");
    expect(style).toContain(
      '[data-item-path="src/a.ts"] [data-item-section="icon"]',
    );
  });

  it("neutralizes any other row still carrying @pierre/trees' own stale selected state", () => {
    const style = buildActivePathTreeStyle("src/a.ts");
    expect(style).toContain(
      '[data-type="item"][data-item-selected="true"]:not([data-item-path="src/a.ts"])',
    );
    expect(style).toContain("color: var(--trees-fg)");
    expect(style).toContain("background-color: var(--trees-bg)");
    expect(style).toContain("color: var(--trees-fg-muted)");
  });

  it("escapes an adversarial path before it reaches the generated rule", () => {
    const style = buildActivePathTreeStyle('src/"weird\\file.ts');
    expect(style).toContain('src/\\"weird\\\\file.ts');
    expect(style).not.toContain('src/"weird\\file.ts');
  });
});
