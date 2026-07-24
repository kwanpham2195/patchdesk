import { useEffect, useRef, useState } from "react";
import { Marked, type Token, type Tokens, type TokensList } from "marked";
import { ChevronDown } from "lucide-react";

import type { PullRequestRef } from "../../../domain/pull-request";
import { openPullRequestExternalUrl, resolvePullRequestExternalUrl } from "@/external-links";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const marked = new Marked({ gfm: true, breaks: false });
const collapsedDescriptionHeight = 288;

export function PullRequestDescription({
  markdown,
  pullRequest,
  truncated = false,
}: {
  readonly markdown?: string;
  readonly pullRequest?: PullRequestRef;
  readonly truncated?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = content.current;
    if (element === null || markdown === undefined) return;
    const measure = (): void =>
      setOverflows(element.scrollHeight > collapsedDescriptionHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [markdown]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pull request description</CardTitle>
        <CardDescription>
          Saved Markdown from GitHub. Links open only on this pull request’s GitHub host.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {markdown === undefined || markdown.trim().length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No description provided</EmptyTitle>
              <EmptyDescription>No description was provided on GitHub.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>
              Description
              <ChevronDown data-icon="inline-end" aria-hidden="true" />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 flex flex-col gap-3">
              {truncated ? (
                <Alert>
                  <AlertTitle>Description truncated</AlertTitle>
                  <AlertDescription>The saved preview ends at Patchdesk’s safe size limit.</AlertDescription>
                </Alert>
              ) : null}
              <ScrollArea className={expanded ? "max-h-[36rem]" : "max-h-72"}>
                <div ref={content} className="pr-3" aria-label="Pull request description rendered from Markdown">
                  <PullRequestDescriptionPreview markdown={markdown} {...(pullRequest === undefined ? {} : { pullRequest })} />
                </div>
              </ScrollArea>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
      {overflows && open ? (
        <CardFooter>
          <ButtonGroup>
            <Button variant="outline" size="sm" onClick={() => setExpanded((current) => !current)}>
              {expanded ? "Show less" : "Show more"}
            </Button>
          </ButtonGroup>
        </CardFooter>
      ) : null}
    </Card>
  );
}

export function PullRequestDescriptionPreview({
  markdown,
  pullRequest,
}: {
  readonly markdown: string;
  readonly pullRequest?: PullRequestRef;
}): React.JSX.Element {
  return <div className="flex flex-col gap-3 text-sm leading-6">{renderBlocks(lexSafely(markdown), pullRequest)}</div>;
}

function lexSafely(markdown: string): TokensList {
  try {
    return marked.lexer(markdown);
  } catch {
    return Object.assign([
      { type: "paragraph", raw: markdown, text: markdown, tokens: [{ type: "text", raw: markdown, text: markdown }] },
    ], { links: {} }) as TokensList;
  }
}

function renderBlocks(tokens: ReadonlyArray<Token>, pullRequest: PullRequestRef | undefined): ReadonlyArray<React.ReactNode> {
  return tokens.map((token, index) => {
    const key = `${token.type}-${index}`;
    switch (token.type) {
      case "space": return null;
      case "heading": {
        const Tag = `h${Math.min(Math.max(token.depth, 1), 6)}` as keyof React.JSX.IntrinsicElements;
        return <Tag key={key} className="font-semibold tracking-tight">{renderInline(tokensOf(token), pullRequest)}</Tag>;
      }
      case "paragraph": return <p key={key} className="whitespace-pre-wrap break-words">{renderInline(tokensOf(token), pullRequest)}</p>;
      case "blockquote": return <blockquote key={key} className="border-l-2 pl-3 text-muted-foreground">{renderBlocks(tokensOf(token), pullRequest)}</blockquote>;
      case "code": return <ScrollArea key={key} className="max-h-48"><pre className="p-3"><code>{token.text}</code></pre></ScrollArea>;
      case "list": {
        const List = token.ordered ? "ol" : "ul";
        return <List key={key} className={token.ordered ? "list-decimal pl-5" : "list-disc pl-5"}>{token.items.map((item: Tokens.ListItem, itemIndex: number) => <li key={`${key}-${itemIndex}`} className="pl-1">{item.task === true ? <Checkbox checked={item.checked ?? false} disabled aria-label={item.checked ? "Completed task" : "Incomplete task"} /> : null}{renderBlocks(tokensOf(item), pullRequest)}</li>)}</List>;
      }
      case "hr": return <Separator key={key} />;
      case "table": return <Table key={key}><TableHeader><TableRow>{token.header.map((cell: Tokens.TableCell, cellIndex: number) => <TableHead key={`${key}-h-${cellIndex}`}>{renderInline(cell.tokens ?? [], pullRequest)}</TableHead>)}</TableRow></TableHeader><TableBody>{token.rows.map((row: Tokens.TableCell[], rowIndex: number) => <TableRow key={`${key}-r-${rowIndex}`}>{row.map((cell: Tokens.TableCell, cellIndex: number) => <TableCell key={`${key}-${rowIndex}-${cellIndex}`}>{renderInline(cell.tokens ?? [], pullRequest)}</TableCell>)}</TableRow>)}</TableBody></Table>;
      case "html":
      case "image": return null;
      default: return null;
    }
  });
}

function renderInline(tokens: ReadonlyArray<Token>, pullRequest: PullRequestRef | undefined): ReadonlyArray<React.ReactNode> {
  return tokens.map((token, index) => {
    const key = `${token.type}-${index}`;
    switch (token.type) {
      case "text":
      case "escape": return token.text;
      case "codespan": return <code key={key} className="rounded bg-muted px-1 py-0.5 text-xs">{token.text}</code>;
      case "strong": return <strong key={key}>{renderInline(tokensOf(token), pullRequest)}</strong>;
      case "em": return <em key={key}>{renderInline(tokensOf(token), pullRequest)}</em>;
      case "del": return <del key={key}>{renderInline(tokensOf(token), pullRequest)}</del>;
      case "br": return <br key={key} />;
      case "link": {
        if (resolvePullRequestExternalUrl(token.href, pullRequest) === undefined) return <span key={key}>{renderInline(tokensOf(token), pullRequest)}</span>;
        return <Button key={key} variant="link" size="xs" onClick={() => void openPullRequestExternalUrl(token.href, pullRequest)}>{renderInline(tokensOf(token), pullRequest)}</Button>;
      }
      case "image":
      case "html": return null;
      default: return null;
    }
  });
}

function tokensOf(token: Token): ReadonlyArray<Token> {
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [token];
}
