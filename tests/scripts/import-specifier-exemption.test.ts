import { describe, expect, it } from "vitest";

import {
  countLines,
  isImportSpecifierOnlyGrowth,
} from "../../scripts/file-growth-lib.mjs";

/**
 * A file whose imports sit above a multi-line object literal, then nothing
 * else. This is the shape the exemption was smuggled through: something below
 * the imports that runs for many lines and grows by as many as the author
 * likes.
 */
function withObjectLiteral(importBlock: string, entries: number): string {
  const keys = Array.from(
    { length: entries },
    (_, index) => `  key${index}: ${index},`,
  );
  return `${importBlock}\n\nconst obj = {\n${keys.join("\n")}\n};\n`;
}

describe("isImportSpecifierOnlyGrowth", () => {
  it("forgives an import Oxfmt wraps to fit a new specifier", () => {
    // The wrap costs three lines for one specifier. Reformatting the import
    // is not the author's choice, so the exemption is about where the lines
    // went, not how many of them there are.
    const before = `import { alpha } from "./m";\n\nconst x = 1;\n`;
    const after = `import {\n  alpha,\n  beta,\n} from "./m";\n\nconst x = 1;\n`;

    expect(countLines(before)).toBe(3);
    expect(countLines(after)).toBe(6);
    expect(isImportSpecifierOnlyGrowth(before, after)).toBe(true);
  });

  it("refuses blank lines opened up between specifiers", () => {
    // A blank line inside an import's braces is not import syntax, so it
    // cannot be a free place to add lines.
    const before = `import { alpha } from "./m";\n\nconst x = 1;\n`;
    const after = `import {\n  alpha,\n\n\n\n  beta,\n} from "./m";\n\nconst x = 1;\n`;

    expect(isImportSpecifierOnlyGrowth(before, after)).toBe(false);
  });

  it("forgives a whole new import declaration", () => {
    const before = `import { alpha } from "./m";\n\nconst x = 1;\n`;
    const after = `import { alpha } from "./m";\nimport { beta } from "./n";\n\nconst x = 1;\n`;

    expect(isImportSpecifierOnlyGrowth(before, after)).toBe(true);
  });

  it("forgives an import that grows while the body shrinks", () => {
    // The E3 shape exactly: the inline annotations the import replaces go
    // away, so the body does not grow even though the file does.
    const before = `import { alpha } from "./m";\n\nconst x = 1;\nconst y = 2;\n`;
    const after = `import {\n  alpha,\n  beta,\n} from "./m";\n\nconst x = 1;\n`;

    expect(isImportSpecifierOnlyGrowth(before, after)).toBe(true);
  });

  it("refuses a body line added beside the added specifier", () => {
    const before = `import { alpha } from "./m";\n\nconst x = 1;\n`;
    const after = `import { alpha, beta } from "./m";\n\nconst x = 1;\nconst y = 2;\n`;

    expect(isImportSpecifierOnlyGrowth(before, after)).toBe(false);
  });

  it("refuses a comment block added above the imports", () => {
    // A comment is a line like any other. Putting it where the imports live
    // must not make it free.
    const before = `import { alpha } from "./m";\n\nconst x = 1;\n`;
    const after = `// one\n// two\n// three\nimport { alpha, beta } from "./m";\n\nconst x = 1;\n`;

    expect(isImportSpecifierOnlyGrowth(before, after)).toBe(false);
  });

  it("refuses a multi-line comment added inside the import's braces", () => {
    // Three lines added, one specifier added. The specifier pays for one
    // line; nothing pays for the other two.
    const before = `import { alpha } from "./m";\n\nconst x = 1;\n`;
    const after = `import {\n  /*\n   * why beta\n   */\n  alpha,\n  beta,\n} from "./m";\n\nconst x = 1;\n`;

    expect(isImportSpecifierOnlyGrowth(before, after)).toBe(false);
  });

  it("refuses growth with no added specifier at all", () => {
    const before = `import { alpha } from "./m";\n\nconst x = 1;\n`;
    const after = `import { alpha } from "./m";\n\nconst x = 1;\nconst y = 2;\n`;

    expect(isImportSpecifierOnlyGrowth(before, after)).toBe(false);
  });

  it("refuses lines that only look like imports further down the file", () => {
    // A code fixture in a template literal. The import region is the file's
    // leading run of declarations and stops at the first statement, so these
    // lines are body, and body may not grow.
    const before = `import { alpha } from "./m";\n\nconst fixture = \`\n\`;\n`;
    const after =
      `import { alpha, beta } from "./m";\n\nconst fixture = \`\n` +
      `import { one } from "./a";\nimport { two } from "./b";\n\`;\n`;

    expect(isImportSpecifierOnlyGrowth(before, after)).toBe(false);
  });

  it("refuses growth in a file that shrank or stayed the same", () => {
    const before = `import { alpha, beta } from "./m";\n\nconst x = 1;\n`;

    expect(isImportSpecifierOnlyGrowth(before, before)).toBe(false);
    expect(
      isImportSpecifierOnlyGrowth(before, `import { alpha } from "./m";\n`),
    ).toBe(false);
  });

  it("counts a side-effect import as binding nothing", () => {
    // `import "./m";` adds a line and no specifier, so it cannot pay for
    // itself.
    const before = `import { alpha } from "./m";\n\nconst x = 1;\n`;
    const after = `import "./side-effect";\nimport { alpha } from "./m";\n\nconst x = 1;\n`;

    expect(isImportSpecifierOnlyGrowth(before, after)).toBe(false);
  });

  it("reads default, namespace, and type specifiers", () => {
    const before = `import alpha from "./m";\n\nconst x = 1;\n`;
    const withNamespace = `import alpha, { beta } from "./m";\nimport * as gamma from "./n";\n\nconst x = 1;\n`;
    const withType = `import alpha from "./m";\nimport type { Delta } from "./n";\n\nconst x = 1;\n`;

    expect(isImportSpecifierOnlyGrowth(before, withNamespace)).toBe(true);
    expect(isImportSpecifierOnlyGrowth(before, withType)).toBe(true);
  });

  it("refuses lines swallowed by a trailing comment on an import", () => {
    // The declaration used to end at the first line whose trimmed text ended
    // in `;`. A trailing comment moves that line down past everything
    // between, so the block below was read as import syntax and grew for
    // free. A declaration now ends where it parses as one.
    const before = withObjectLiteral(`import { alpha } from "./m";`, 20);
    const after = withObjectLiteral(
      `import { alpha } from "./m";\nimport { gamma } from "./o";\nimport { beta } from "./n"; // why`,
      200,
    );

    expect(isImportSpecifierOnlyGrowth(before, after)).toBe(false);
  });

  it("refuses lines bought by deleting a directive prologue", () => {
    // A file that opens with `"use client";` used to have an import region
    // of nothing at all -- the directive stopped the scan at line one. Every
    // import below it was an ordinary line, so deleting the directive turned
    // them all into import lines at once and paid for one body line each.
    // Three files under src/renderer/src/components/ui/ open this way.
    const before = `"use client";\n\nimport { alpha } from "./m";\nimport { beta } from "./n";\nimport { delta } from "./p";\n\nconst x = 1;\n`;
    const after = `import { alpha, gamma } from "./m";\nimport { beta } from "./n";\nimport { delta } from "./p";\n\nconst x = 1;\nconst y = 2;\nconst z = 3;\nconst w = 4;\n`;

    expect(isImportSpecifierOnlyGrowth(before, after)).toBe(false);
  });

  it("forgives the E3 change in a file that opens with a directive", () => {
    // The other half of the same fix. Skipping the directive is what makes
    // the region reach the imports below it, so a file with `"use client";`
    // gets the exemption the E3 change needs rather than being refused for
    // where its first line is.
    const before = `"use client";\n\nimport { alpha } from "./m";\n\nconst x = 1;\n`;
    const after = `"use client";\n\nimport {\n  alpha,\n  beta,\n} from "./m";\n\nconst x = 1;\n`;

    expect(isImportSpecifierOnlyGrowth(before, after)).toBe(true);
  });

  it("refuses lines bought by deleting a comment beside the first import", () => {
    // A block comment opened on the import's own line used to abandon the
    // region, because the scan looked for a line *ending* in `*/`. Same
    // trade as the directive: delete it later and the imports below become
    // import lines.
    const before = `/* header */ import { alpha } from "./m";\nimport { beta } from "./n";\n\nconst x = 1;\n`;
    const after = `import { alpha, gamma } from "./m";\nimport { beta } from "./n";\n\nconst x = 1;\nconst y = 2;\n`;

    expect(isImportSpecifierOnlyGrowth(before, after)).toBe(false);
  });

  it("refuses a clause that is not import syntax", () => {
    // Braces that never close into a declaration are not a declaration. The
    // lines between them are body, and body may not grow.
    const before = `import {\n  alpha,\n} from "./m";\n\nconst x = 1;\n`;
    const after =
      `import {\n  alpha,\n  beta,\nconst obj = {\n  key0: 0,\n  key1: 1,\n  key2: 2,\n` +
      `} from "./m";\n\nconst x = 1;\n`;

    expect(isImportSpecifierOnlyGrowth(before, after)).toBe(false);
  });

  it("forgives a body line rewritten in place, and refuses one added", () => {
    // The E3 change as it really reads: the named type the new specifier
    // brings in replaces an inline annotation, so a body line changes
    // without the body growing. Rewriting is allowed; a net extra line is
    // not, whatever the rewriting looks like.
    const before = `import { alpha } from "./m";\n\nconst one: { a: string } = alpha.one;\n`;
    const rewritten = `import {\n  alpha,\n  type Named,\n} from "./m";\n\nconst one: Named = alpha.one;\n`;
    const andOneMore = `import {\n  alpha,\n  type Named,\n} from "./m";\n\nconst one: Named = alpha.one;\nconst two = 2;\n`;

    expect(isImportSpecifierOnlyGrowth(before, rewritten)).toBe(true);
    expect(isImportSpecifierOnlyGrowth(before, andOneMore)).toBe(false);
  });

  it("refuses a second copy of a line the file already had", () => {
    // The comparison is by text and by count, so repeating an existing line
    // is an added line like any other.
    const before = `import { alpha } from "./m";\n\nconst x = 1;\nconst x = 1;\n`;
    const after = `import { alpha, beta } from "./m";\n\nconst x = 1;\nconst x = 1;\nconst x = 1;\n`;

    expect(isImportSpecifierOnlyGrowth(before, after)).toBe(false);
  });

  it("reads a module specifier that holds a comment marker", () => {
    // `//` inside a string is not a comment, so a URL specifier does not
    // knock the line out of the import region.
    const before = `import { alpha } from "https://example.test/m";\n\nconst x = 1;\n`;
    const after = `import {\n  alpha,\n  beta,\n} from "https://example.test/m";\n\nconst x = 1;\n`;

    expect(isImportSpecifierOnlyGrowth(before, after)).toBe(true);
  });

  it("keeps a shebang and a leading comment out of the import region", () => {
    // check-changed-source.mjs starts with a shebang. The region has to
    // reach the imports below it, but the shebang and comment lines are
    // still body: they can shrink or hold, never grow for free.
    const before = `#!/usr/bin/env node\n\n// note\nimport { alpha } from "./m";\n\nconst x = 1;\n`;
    const after = `#!/usr/bin/env node\n\n// note\nimport {\n  alpha,\n  beta,\n} from "./m";\n\nconst x = 1;\n`;
    const withExtraNote = `#!/usr/bin/env node\n\n// note\n// more\nimport { alpha, beta } from "./m";\n\nconst x = 1;\n`;

    expect(isImportSpecifierOnlyGrowth(before, after)).toBe(true);
    expect(isImportSpecifierOnlyGrowth(before, withExtraNote)).toBe(false);
  });
});

describe("countLines", () => {
  it("treats a trailing newline as a terminator, not a line", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\n\n")).toBe(2);
  });
});
