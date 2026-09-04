import type { Token } from "marked";
import * as v from "valibot";

/**
 * One raw-HTML element rebuilt from the separate tokens `marked` emits for it.
 *
 * `marked` lexes inline HTML one tag at a time: the opening tag, the element's
 * own content, and the closing tag arrive as siblings, so a consumer that
 * renders each `html` token on its own produces an empty element followed by
 * loose text. This node puts the content back inside the element.
 */
export type MarkdownHtmlElement = {
  readonly type: "htmlElement";
  readonly openTag: string;
  readonly closeTag: string;
  readonly tokens: ReadonlyArray<MarkdownNode>;
};

/** A `marked` token, or a raw-HTML element reassembled from several of them. */
export type MarkdownNode = Token | MarkdownHtmlElement;

/**
 * Narrows a node to a reassembled element. `Tokens.Generic` declares `type` as
 * plain `string`, so comparing `type` alone never narrows the union.
 */
export function isMarkdownHtmlElement(
  node: MarkdownNode,
): node is MarkdownHtmlElement {
  return node.type === "htmlElement" && "openTag" in node;
}

/** Elements HTML never closes, so their tag is not an opener to match against. */
const voidTags = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const openTagPattern = /^<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^]*?)?>$/;
const closeTagPattern = /^<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>$/;

/**
 * Reassembles each opening-tag/content/closing-tag run into one element node.
 *
 * Idempotent, so a caller may run it over an already-grouped list. Tokens it
 * cannot pair -- a stray closing tag, an element left unclosed at the end of
 * the run -- are passed through unchanged, which is what an ungrouped consumer
 * would have rendered anyway, so malformed HTML never swallows the tokens
 * after it.
 */
export function groupMarkdownHtml(
  nodes: ReadonlyArray<MarkdownNode>,
): ReadonlyArray<MarkdownNode> {
  return scan(nodes, 0, new Set()).nodes;
}

/** Where a scan stopped, so the level that opened a tag can consume its close. */
type ScanResult = {
  readonly nodes: ReadonlyArray<MarkdownNode>;
  /** Index of the closing tag named by `stoppedAt`, else one past the last node. */
  readonly nextIndex: number;
  /** Tag name of an unconsumed closing tag an enclosing level must handle. */
  readonly stoppedAt: string | undefined;
};

function scan(
  nodes: ReadonlyArray<MarkdownNode>,
  start: number,
  openTags: ReadonlySet<string>,
): ScanResult {
  const collected: MarkdownNode[] = [];
  let index = start;

  while (index < nodes.length) {
    const node = nodes[index];
    const html = rawHtmlOf(node);
    if (html === undefined) {
      if (node !== undefined) collected.push(node);
      index += 1;
      continue;
    }

    const closeName = closeTagPattern.exec(html)?.[1]?.toLowerCase();
    if (closeName !== undefined) {
      // An enclosing level opened this tag, so hand the closing token back to it.
      if (openTags.has(closeName))
        return { nodes: collected, nextIndex: index, stoppedAt: closeName };
      if (node !== undefined) collected.push(node);
      index += 1;
      continue;
    }

    const openName = openTagPattern.exec(html)?.[1]?.toLowerCase();
    if (openName === undefined || voidTags.has(openName)) {
      if (node !== undefined) collected.push(node);
      index += 1;
      continue;
    }

    const inner = scan(nodes, index + 1, new Set(openTags).add(openName));
    if (inner.stoppedAt === openName) {
      const closeTag = rawHtmlOf(nodes[inner.nextIndex]) ?? `</${openName}>`;
      collected.push({
        type: "htmlElement",
        openTag: html,
        closeTag,
        tokens: inner.nodes,
      });
      index = inner.nextIndex + 1;
      continue;
    }

    if (node !== undefined) collected.push(node);
    collected.push(...inner.nodes);
    index = inner.nextIndex;
    if (inner.stoppedAt !== undefined)
      return { nodes: collected, nextIndex: index, stoppedAt: inner.stoppedAt };
  }

  return { nodes: collected, nextIndex: index, stoppedAt: undefined };
}

const htmlTokenSchema = v.object({
  type: v.literal("html"),
  text: v.string(),
});

/** The tag text of a raw-HTML token, or `undefined` for anything else. */
function rawHtmlOf(node: MarkdownNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  const parsed = v.safeParse(htmlTokenSchema, node);
  return parsed.success ? parsed.output.text.trim() : undefined;
}
