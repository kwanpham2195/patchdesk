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

  it("round-trips an adversarial path combining a quote, a backslash, and a newline through the CSS string-escape grammar unchanged", () => {
    const adversarial = 'src/"; } * { color: red; } /*\\\n.ts';
    const escaped = escapeCssAttributeValue(adversarial);
    // Decoding the escaped text with the same escape grammar a conformant
    // CSS parser uses must reconstruct the exact original path. If the
    // escaping were missing or wrong, either this would fail to round-trip,
    // or (for a no-op "escaper") the raw quote/backslash/newline bytes would
    // let a CSS parser read past the intended string boundary -- which is
    // exactly the injection this function exists to prevent.
    expect(decodeCssStringEscapes(escaped)).toBe(adversarial);
  });
});

/**
 * A minimal decoder for the CSS string-token escape grammar
 * (https://www.w3.org/TR/css-syntax-3/#consume-escaped-code-point), used
 * only by these tests to verify that `escapeCssAttributeValue`'s output
 * round-trips back to the original text the way a real CSS parser would
 * read it.
 */
function decodeCssStringEscapes(value: string): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (char !== "\\") {
      result += char;
      index += 1;
      continue;
    }
    index += 1;
    const hexMatch = /^[0-9a-fA-F]{1,6}/.exec(value.slice(index));
    if (hexMatch === null) {
      result += value[index] ?? "";
      index += 1;
      continue;
    }
    result += String.fromCodePoint(parseInt(hexMatch[0], 16));
    index += hexMatch[0].length;
    // A single trailing whitespace character after a hex escape terminates
    // the escape rather than being literal content.
    if (/\s/.test(value[index] ?? "")) index += 1;
  }
  return result;
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
