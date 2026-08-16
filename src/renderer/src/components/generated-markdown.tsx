import { Fragment } from "react";
import { Marked, type Token, type Tokens, type TokensList } from "marked";

import { cn } from "../lib/utils";

const marked = new Marked({ gfm: true, breaks: false });

/** Renders model prose without enabling HTML, links, images, or remote content. */
export function GeneratedMarkdown({
  markdown,
  className,
}: {
  readonly markdown: string;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <div
      data-generated-markdown
      className={cn(
        "flex min-w-0 flex-col gap-2 text-sm leading-relaxed break-words",
        className,
      )}
    >
      {renderBlocks(lexSafely(markdown))}
    </div>
  );
}

function lexSafely(markdown: string): TokensList {
  try {
    return marked.lexer(markdown);
  } catch {
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
  tokens: ReadonlyArray<Token>,
): ReadonlyArray<React.ReactNode> {
  return tokens.map((token, index) => {
    const key = tokenKey(token, index);
    switch (token.type) {
      case "space":
        return null;
      case "heading":
        return (
          <p key={key} className="font-semibold text-foreground">
            {renderInline(tokensOf(token))}
          </p>
        );
      case "paragraph":
        return <p key={key}>{renderInline(tokensOf(token))}</p>;
      case "text":
        return <Fragment key={key}>{renderInline(tokensOf(token))}</Fragment>;
      case "blockquote":
        return (
          <blockquote
            key={key}
            className="border-l-2 pl-3 text-muted-foreground"
          >
            {renderBlocks(tokensOf(token))}
          </blockquote>
        );
      case "code":
        return (
          <pre
            key={key}
            className="max-w-full overflow-x-auto rounded-md bg-muted/50 p-3 font-mono text-xs leading-5 whitespace-pre"
          >
            <code>{token.text}</code>
          </pre>
        );
      case "list": {
        const List = token.ordered ? "ol" : "ul";
        return (
          <List
            key={key}
            className={
              token.ordered
                ? "flex list-decimal flex-col gap-1 pl-5"
                : "flex list-disc flex-col gap-1 pl-5"
            }
          >
            {token.items.map((item: Tokens.ListItem, itemIndex: number) => (
              <li key={`${key}-${itemIndex}`} className="pl-1">
                {renderBlocks(tokensOf(item))}
              </li>
            ))}
          </List>
        );
      }
      case "table":
        return (
          <div key={key} className="overflow-x-auto rounded-md border">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/50">
                <tr>
                  {token.header.map(
                    (cell: Tokens.TableCell, cellIndex: number) => (
                      <th
                        key={`${key}-h-${cellIndex}`}
                        className="px-2 py-1.5 font-medium"
                      >
                        {renderInline(cell.tokens ?? [])}
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
                        {renderInline(cell.tokens ?? [])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "hr":
        return <div key={key} className="h-px bg-border" />;
      case "html":
        return <p key={key}>{token.text}</p>;
      case "image":
        return <span key={key}>[Image omitted]</span>;
      default:
        return null;
    }
  });
}

function renderInline(
  tokens: ReadonlyArray<Token>,
): ReadonlyArray<React.ReactNode> {
  return tokens.map((token, index) => {
    const key = tokenKey(token, index);
    switch (token.type) {
      case "text":
      case "escape":
        return token.text;
      case "codespan":
        return (
          <code
            key={key}
            className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground"
          >
            {token.text}
          </code>
        );
      case "strong":
        return <strong key={key}>{renderInline(tokensOf(token))}</strong>;
      case "em":
        return <em key={key}>{renderInline(tokensOf(token))}</em>;
      case "del":
        return <del key={key}>{renderInline(tokensOf(token))}</del>;
      case "br":
        return <br key={key} />;
      case "link":
        return <span key={key}>{renderInline(tokensOf(token))}</span>;
      case "image":
        return <span key={key}>[Image omitted]</span>;
      case "html":
        return token.text;
      default:
        return null;
    }
  });
}

// Keys must be unique among siblings; repeated token text (e.g. two identical
// codespans) would otherwise collide, so the position in the stream is part
// of the key.
function tokenKey(token: Token, index: number): string {
  return `${token.type}-${index}`;
}

function tokensOf(token: Token): ReadonlyArray<Token> {
  return "tokens" in token && Array.isArray(token.tokens)
    ? token.tokens
    : [token];
}
