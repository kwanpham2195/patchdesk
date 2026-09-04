import { Fragment, type ReactNode } from "react";
import { Circle, CircleCheck } from "lucide-react";
import { Marked, type Token, type Tokens, type TokensList } from "marked";

import { cn } from "../lib/utils";
import {
  groupMarkdownHtml,
  isMarkdownHtmlElement,
  type MarkdownNode,
} from "../markdown-inline-html";

const marked = new Marked({ gfm: true, breaks: false });

/** A source-specific decision for one Markdown link. */
type MarkdownLinkRenderInput = {
  readonly href: string;
  readonly children: ReadonlyArray<ReactNode>;
  readonly key: string;
};

/** A source-specific decision for one Markdown image. */
type MarkdownImageRenderInput = {
  readonly token: Tokens.Image | Tokens.Generic;
  readonly key: string;
};

/**
 * A source-specific decision for one raw HTML token.
 *
 * `marked` lexes inline HTML one tag at a time, so an element's own content
 * arrives as sibling tokens. When those have been reassembled, `html` is the
 * opening tag alone and the other two fields carry the rest of the element.
 */
type MarkdownHtmlRenderInput = {
  readonly html: string;
  readonly key: string;
  readonly closeHtml?: string;
  readonly children?: ReadonlyArray<ReactNode>;
};

/** A source-specific decision for one Mermaid code fence. */
type MarkdownMermaidRenderInput = {
  readonly source: string;
  readonly key: string;
};

/** Defines the source-specific output for content that can load or render rich content. */
export type MarkdownContentPolicy = {
  readonly renderLink: (input: MarkdownLinkRenderInput) => ReactNode;
  readonly renderImage: (input: MarkdownImageRenderInput) => ReactNode;
  readonly renderHtml: (input: MarkdownHtmlRenderInput) => ReactNode;
  readonly renderMermaid?: (input: MarkdownMermaidRenderInput) => ReactNode;
};

/** Renders Markdown structure with shared visual hierarchy and source-specific rich-content policy. */
export function MarkdownContent({
  markdown,
  policy,
  className,
  generatedMarkdown = false,
}: {
  readonly markdown: string;
  readonly policy: MarkdownContentPolicy;
  readonly className?: string;
  readonly generatedMarkdown?: boolean;
}): React.JSX.Element {
  return (
    <div
      {...(generatedMarkdown ? { "data-generated-markdown": "true" } : {})}
      className={cn(
        "flex min-w-0 flex-col gap-3 text-sm leading-6 break-words",
        className,
      )}
    >
      {renderBlocks(lexSafely(markdown), policy)}
    </div>
  );
}

/**
 * Renders one line of Markdown inline tokens with no block wrapper, so a
 * caller can put model prose inside its own sentence-level element (a `<p>`
 * that also carries citation chips, a list item, a table cell).
 */
export function MarkdownInline({
  markdown,
  policy,
}: {
  readonly markdown: string;
  readonly policy: MarkdownContentPolicy;
}): React.JSX.Element {
  return <>{renderInline(lexInlineSafely(markdown), policy)}</>;
}

function lexInlineSafely(markdown: string): ReadonlyArray<Token> {
  try {
    return marked.Lexer.lexInline(markdown);
  } catch {
    return [{ type: "text", raw: markdown, text: markdown }];
  }
}

function lexSafely(markdown: string): TokensList {
  try {
    return marked.lexer(markdown);
  } catch {
    // SAFETY: `TokensList` is `Token[] & { links: Links }`. The array literal
    // below is a single well-formed paragraph token (all fields `marked`
    // itself would set), and `Object.assign` attaches the required `links`
    // map onto that same array, so the assembled value structurally matches
    // `TokensList` even though `Object.assign`'s overloads can't express it.
    return Object.assign(
      [
        {
          type: "paragraph",
          raw: markdown,
          text: markdown,
          tokens: [{ type: "text", raw: markdown, text: markdown }],
        },
      ],
      { links: {} },
    ) as TokensList;
  }
}

function renderBlocks(
  tokens: ReadonlyArray<MarkdownNode>,
  policy: MarkdownContentPolicy,
): ReadonlyArray<ReactNode> {
  return groupMarkdownHtml(tokens).map((token, index) => {
    const key = tokenKey(token, index);
    if (isMarkdownHtmlElement(token)) {
      return policy.renderHtml({
        html: token.openTag,
        closeHtml: token.closeTag,
        children: renderBlocks(token.tokens, policy),
        key,
      });
    }
    switch (token.type) {
      case "space":
        return null;
      case "heading": {
        // SAFETY: `Math.min(Math.max(token.depth, 1), 6)` clamps the depth to
        // the integers 1..6, so this template string is always exactly one
        // of "h1".."h6", each a valid intrinsic element tag.
        const depth = Math.min(Math.max(token.depth, 1), 6);
        // SAFETY: `depth` is clamped to 1..6 above, so this is one valid intrinsic heading tag.
        const Tag = `h${depth}` as keyof React.JSX.IntrinsicElements;
        return (
          <Tag key={key} className={headingClassName(depth)}>
            {renderInline(tokensOf(token), policy)}
          </Tag>
        );
      }
      case "paragraph":
        return (
          <p key={key} className="whitespace-pre-wrap break-words">
            {renderInline(tokensOf(token), policy)}
          </p>
        );
      case "text":
        return (
          <Fragment key={key}>{renderInline(tokensOf(token), policy)}</Fragment>
        );
      case "blockquote":
        return (
          <blockquote
            key={key}
            className="border-l-2 border-primary/60 pl-3 text-muted-foreground"
          >
            {renderBlocks(tokensOf(token), policy)}
          </blockquote>
        );
      case "code":
        return token.lang?.toLowerCase() === "mermaid" &&
          policy.renderMermaid !== undefined ? (
          policy.renderMermaid({ source: token.text, key })
        ) : (
          <pre
            key={key}
            className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-xs leading-5"
          >
            <code>{token.text}</code>
          </pre>
        );
      case "list": {
        const List = token.ordered ? "ol" : "ul";
        return (
          <List
            key={key}
            className={token.ordered ? "list-decimal pl-5" : "list-disc pl-5"}
          >
            {token.items.map((item: Tokens.ListItem, itemIndex: number) =>
              item.task === true ? (
                <MarkdownTaskListItem
                  key={`${key}-${itemIndex}`}
                  completed={item.checked ?? false}
                  policy={policy}
                  item={item}
                />
              ) : (
                <li
                  key={`${key}-${itemIndex}`}
                  className={
                    token.ordered ? "pl-1" : "pl-1 marker:text-primary"
                  }
                >
                  {renderBlocks(tokensOf(item), policy)}
                </li>
              ),
            )}
          </List>
        );
      }
      case "hr":
        return <div key={key} className="h-px bg-border" />;
      case "table":
        return (
          <div key={key} className="overflow-x-auto rounded-md border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50">
                <tr>
                  {token.header.map(
                    (cell: Tokens.TableCell, cellIndex: number) => (
                      <th
                        key={`${key}-h-${cellIndex}`}
                        className="px-2 py-1.5 font-medium"
                      >
                        {renderInline(cell.tokens ?? [], policy)}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {token.rows.map((row: Tokens.TableCell[], rowIndex: number) => (
                  <tr key={`${key}-r-${rowIndex}`} className="border-t">
                    {row.map((cell: Tokens.TableCell, cellIndex: number) => (
                      <td
                        key={`${key}-${rowIndex}-${cellIndex}`}
                        className="px-2 py-1.5 align-top"
                      >
                        {renderInline(cell.tokens ?? [], policy)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "html":
        return policy.renderHtml({ html: token.text, key });
      case "image":
        return policy.renderImage({ token, key });
      default:
        return null;
    }
  });
}

function renderInline(
  tokens: ReadonlyArray<MarkdownNode>,
  policy: MarkdownContentPolicy,
): ReadonlyArray<ReactNode> {
  return groupMarkdownHtml(tokens).map((token, index) => {
    const key = tokenKey(token, index);
    if (isMarkdownHtmlElement(token)) {
      return policy.renderHtml({
        html: token.openTag,
        closeHtml: token.closeTag,
        children: renderInline(token.tokens, policy),
        key,
      });
    }
    switch (token.type) {
      case "text":
      case "escape":
        return token.text;
      case "codespan":
        return (
          <code
            key={key}
            // A model writes file paths as inline code; without a break the
            // chip cannot wrap and pushes itself onto a line of its own in a
            // narrow column.
            className="rounded bg-muted px-1 py-0.5 font-mono text-xs break-words text-foreground"
          >
            {token.text}
          </code>
        );
      case "strong":
        return (
          <strong key={key}>{renderInline(tokensOf(token), policy)}</strong>
        );
      case "em":
        return <em key={key}>{renderInline(tokensOf(token), policy)}</em>;
      case "del":
        return <del key={key}>{renderInline(tokensOf(token), policy)}</del>;
      case "br":
        return <br key={key} />;
      case "link":
        return policy.renderLink({
          href: token.href,
          children: renderInline(tokensOf(token), policy),
          key,
        });
      case "image":
        return policy.renderImage({ token, key });
      case "html":
        return policy.renderHtml({ html: token.text, key });
      default:
        return null;
    }
  });
}

function MarkdownTaskListItem({
  completed,
  policy,
  item,
}: {
  readonly completed: boolean;
  readonly policy: MarkdownContentPolicy;
  readonly item: Tokens.ListItem;
}): React.JSX.Element {
  const taskTokens = tokensOf(item);
  const content =
    taskTokens.length === 1 && taskTokens[0]?.type === "paragraph"
      ? renderInline(tokensOf(taskTokens[0]), policy)
      : renderInline(taskTokens, policy);
  return (
    <li className="-ml-5 flex list-none items-start gap-2">
      <span
        aria-label={completed ? "Completed task" : "Incomplete task"}
        className={
          completed
            ? "mt-1 shrink-0 text-green-500"
            : "mt-1 shrink-0 text-muted-foreground"
        }
      >
        {completed ? (
          <CircleCheck aria-hidden="true" className="size-4" />
        ) : (
          <Circle aria-hidden="true" className="size-4" />
        )}
      </span>
      <span
        className={
          completed ? "min-w-0 text-muted-foreground line-through" : "min-w-0"
        }
      >
        {content}
      </span>
    </li>
  );
}

function headingClassName(depth: number): string {
  switch (depth) {
    case 1:
      return "mt-2 text-xl font-semibold tracking-tight text-foreground first:mt-0";
    case 2:
      return "mt-2 text-lg font-semibold tracking-tight text-foreground first:mt-0";
    case 3:
      return "mt-2 text-base font-semibold tracking-tight text-foreground first:mt-0";
    case 4:
      return "mt-2 text-sm font-semibold tracking-tight text-foreground first:mt-0";
    case 5:
      return "mt-2 text-sm font-medium text-foreground first:mt-0";
    case 6:
      return "mt-2 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground first:mt-0";
    default:
      return "font-semibold text-foreground";
  }
}

/** Provides React with a stable per-position key for a Markdown token. */
function tokenKey(token: MarkdownNode, index: number): string {
  return `${index}-${token.type}`;
}

function tokensOf(token: MarkdownNode): ReadonlyArray<MarkdownNode> {
  if (isMarkdownHtmlElement(token)) return token.tokens;
  return "tokens" in token && Array.isArray(token.tokens)
    ? token.tokens
    : [token];
}
