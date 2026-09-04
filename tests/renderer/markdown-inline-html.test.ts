import { describe, expect, it } from "vitest";
import { Marked, type Token } from "marked";

import {
  groupMarkdownHtml,
  isMarkdownHtmlElement,
  type MarkdownHtmlElement,
  type MarkdownNode,
} from "../../src/renderer/src/markdown-inline-html";

const marked = new Marked({ gfm: true, breaks: false });

function lex(markdown: string): ReadonlyArray<Token> {
  return marked.Lexer.lexInline(markdown);
}

function lexBlock(markdown: string): ReadonlyArray<Token> {
  return marked.Lexer.lex(markdown);
}

/** Flattens a node back to the source text a renderer would show for it. */
function textOf(node: MarkdownNode): string {
  if (isMarkdownHtmlElement(node))
    return `${node.openTag}${node.tokens.map(textOf).join("")}${node.closeTag}`;
  const nested: unknown = "tokens" in node ? node.tokens : undefined;
  if (Array.isArray(nested) && nested.length > 0)
    return (nested as ReadonlyArray<MarkdownNode>).map(textOf).join("");
  return node.raw;
}

/** Asserts a node is a reassembled element and hands it back narrowed. */
function elementAt(
  nodes: ReadonlyArray<MarkdownNode>,
  index: number,
): MarkdownHtmlElement {
  const node = nodes[index];
  if (node === undefined || !isMarkdownHtmlElement(node))
    throw new Error(`node ${index} is not a reassembled element`);
  return node;
}

describe("reassembling inline raw HTML", () => {
  it("puts an anchor's own content back inside the anchor", () => {
    const grouped = groupMarkdownHtml(
      lex(
        '💡 <a href="/o/r/new/master?filename=x" class="Link--inTextBlock">Add a `code-review` agent skill</a> or configure MCP servers.',
      ),
    );

    expect(grouped.map((node) => node.type)).toEqual([
      "text",
      "htmlElement",
      "text",
    ]);
    const anchor = elementAt(grouped, 1);
    expect(anchor.openTag).toBe(
      '<a href="/o/r/new/master?filename=x" class="Link--inTextBlock">',
    );
    expect(anchor.closeTag).toBe("</a>");
    expect(anchor.tokens.map((token) => token.type)).toEqual([
      "text",
      "codespan",
      "text",
    ]);
    expect(anchor.tokens.map(textOf).join("")).toBe(
      "Add a `code-review` agent skill",
    );
    expect(grouped.map(textOf).join("")).toBe(
      '💡 <a href="/o/r/new/master?filename=x" class="Link--inTextBlock">Add a `code-review` agent skill</a> or configure MCP servers.',
    );
  });

  it("keeps the text after an unclosed tag instead of swallowing it", () => {
    const tokens = lex('<a href="x">unclosed and more text');
    const grouped = groupMarkdownHtml(tokens);

    expect(grouped.map((node) => node.type)).toEqual(["html", "text"]);
    expect(grouped.map(textOf).join("")).toBe(
      '<a href="x">unclosed and more text',
    );
  });

  it("passes a closing tag that never opened through untouched", () => {
    const grouped = groupMarkdownHtml(lex("a </em> stray"));

    expect(grouped.map((node) => node.type)).toEqual(["text", "html", "text"]);
    expect(grouped.map(textOf).join("")).toBe("a </em> stray");
  });

  it("nests same-tag elements instead of closing the outer one early", () => {
    const grouped = groupMarkdownHtml(
      lex('<a href="1">outer <a href="2">inner</a> tail</a>'),
    );

    expect(grouped).toHaveLength(1);
    const outer = elementAt(grouped, 0);
    expect(outer.openTag).toBe('<a href="1">');
    expect(outer.tokens.map((node) => node.type)).toEqual([
      "text",
      "htmlElement",
      "text",
    ]);
    const inner = elementAt(outer.tokens, 1);
    expect(inner.openTag).toBe('<a href="2">');
    expect(inner.tokens.map(textOf).join("")).toBe("inner");
    expect(outer.tokens.map(textOf).join("")).toBe(
      'outer <a href="2">inner</a> tail',
    );
  });

  it("leaves a void element alone rather than opening a run at it", () => {
    const grouped = groupMarkdownHtml(
      lex('<img src="x"> then <a href="y">link</a>'),
    );

    expect(grouped.map((node) => node.type)).toEqual([
      "html",
      "text",
      "htmlElement",
    ]);
  });

  it("leaves a block token that already holds its own inner HTML alone", () => {
    const tokens = lexBlock(
      "<details open>\n<summary>Title</summary>\n\ncontent\n\n</details>",
    );
    const grouped = groupMarkdownHtml(tokens);

    // Pairing the run would drop the summary, which lives only in the raw text.
    expect(grouped.map((node) => node.type)).toEqual([
      "html",
      "space",
      "paragraph",
      "space",
      "html",
    ]);
    expect(grouped.map(textOf).join("")).toContain("<summary>Title</summary>");
  });

  it("is idempotent, so a caller may group an already-grouped list", () => {
    const once = groupMarkdownHtml(lex("before <b>bold</b> after"));
    expect(groupMarkdownHtml(once)).toEqual(once);
  });
});
