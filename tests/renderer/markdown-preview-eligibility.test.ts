import { describe, expect, it } from "vitest";

import { canPreviewMarkdownFile } from "../../src/renderer/src/markdown-preview-eligibility";

describe("Markdown preview eligibility", () => {
  it.each([
    ["README.md", "change", "# Head\n", true],
    ["docs/GUIDE.MARKDOWN", "new", "Guide\n", true],
    ["docs/removed.md", "deleted", "Old\n", false],
    ["docs/guide.md", "change", undefined, false],
    ["docs/guide.mdx", "change", "# Component\n", false],
    ["src/readme.txt", "change", "# Text\n", false],
  ] as const)(
    "%s with %s content has eligibility %s",
    (name, type, verifiedHeadText, expected) => {
      expect(canPreviewMarkdownFile({ name, type }, verifiedHeadText)).toBe(
        expected,
      );
    },
  );
});
