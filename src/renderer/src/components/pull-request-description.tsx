import { marked, type Token, type Tokens, type TokensList } from "marked";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function PullRequestDescription({ markdown }: { readonly markdown?: string }): React.JSX.Element {
  if (markdown === undefined || markdown.trim().length === 0) {
    return <Card><CardHeader><CardTitle>Pull request description</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">No description was provided on GitHub.</CardContent></Card>;
  }
  const tokens = lexSafely(markdown);
  return (
    <Card>
      <CardHeader><CardTitle>Pull request description</CardTitle></CardHeader>
      <CardContent className="min-w-0 text-sm leading-6 text-foreground">
        <div className="grid gap-3" aria-label="Pull request description rendered from Markdown">{renderBlocks(tokens)}</div>
      </CardContent>
    </Card>
  );
}

function lexSafely(markdown: string): TokensList {
  try {
    return marked.lexer(markdown, { gfm: true, breaks: true });
  } catch {
    return Object.assign([
      { type: "paragraph", raw: markdown, text: markdown, tokens: [{ type: "text", raw: markdown, text: markdown }] },
    ], { links: {} }) as TokensList;
  }
}

function renderBlocks(tokens: ReadonlyArray<Token>): ReadonlyArray<React.ReactNode> {
  return tokens.map((token, index) => {
    const key = `${token.type}-${index}`;
    switch (token.type) {
      case "space": return null;
      case "heading": {
        const Tag = `h${Math.min(Math.max(token.depth, 1), 6)}` as keyof React.JSX.IntrinsicElements;
        return <Tag key={key} className="font-semibold tracking-tight">{renderInline(tokensOf(token))}</Tag>;
      }
      case "paragraph": return <p key={key} className="whitespace-pre-wrap break-words">{renderInline(tokensOf(token))}</p>;
      case "blockquote": return <blockquote key={key} className="border-l-2 pl-3 text-muted-foreground">{renderBlocks(tokensOf(token))}</blockquote>;
      case "code": return <pre key={key} className="overflow-x-auto rounded-md border bg-muted p-3 text-xs leading-5"><code>{token.text}</code></pre>;
      case "list": {
        const List = token.ordered ? "ol" : "ul";
        return <List key={key} className={token.ordered ? "list-decimal space-y-1 pl-5" : "list-disc space-y-1 pl-5"}>{token.items.map((item: Tokens.ListItem, itemIndex: number) => <li key={`${key}-${itemIndex}`}>{renderBlocks(tokensOf(item))}</li>)}</List>;
      }
      case "hr": return <hr key={key} className="border-border" />;
      case "table": return <div key={key} className="overflow-x-auto"><table className="w-full border-collapse text-left"><thead><tr>{token.header.map((cell: Tokens.TableCell, cellIndex: number) => <th key={`${key}-h-${cellIndex}`} className="border p-2 font-medium">{renderInline(cell.tokens ?? [])}</th>)}</tr></thead><tbody>{token.rows.map((row: Tokens.TableCell[], rowIndex: number) => <tr key={`${key}-r-${rowIndex}`}>{row.map((cell: Tokens.TableCell, cellIndex: number) => <td key={`${key}-${rowIndex}-${cellIndex}`} className="border p-2 align-top">{renderInline(cell.tokens ?? [])}</td>)}</tr>)}</tbody></table></div>;
      case "html": return <pre key={key} className="overflow-x-auto rounded-md border bg-muted p-3 text-xs leading-5"><code>{token.text}</code></pre>;
      default: return <p key={key} className="whitespace-pre-wrap break-words">{renderInline(tokensOf(token))}</p>;
    }
  });
}

function renderInline(tokens: ReadonlyArray<Token>): ReadonlyArray<React.ReactNode> {
  return tokens.map((token, index) => {
    const key = `${token.type}-${index}`;
    switch (token.type) {
      case "text":
      case "escape": return token.text;
      case "codespan": return <code key={key} className="rounded bg-muted px-1 py-0.5 text-xs">{token.text}</code>;
      case "strong": return <strong key={key}>{renderInline(tokensOf(token))}</strong>;
      case "em": return <em key={key}>{renderInline(tokensOf(token))}</em>;
      case "del": return <del key={key}>{renderInline(tokensOf(token))}</del>;
      case "br": return <br key={key} />;
      case "link": {
        const href = safeLink(token.href);
        return href === undefined ? <span key={key}>{renderInline(tokensOf(token))}</span> : <a key={key} href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-4">{renderInline(tokensOf(token))}</a>;
      }
      case "image": return <span key={key}>[image: {token.text}]</span>;
      case "html": return <code key={key}>{token.text}</code>;
      default: return "text" in token ? token.text : token.raw;
    }
  });
}

function tokensOf(token: Token): ReadonlyArray<Token> {
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [token];
}

function safeLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
