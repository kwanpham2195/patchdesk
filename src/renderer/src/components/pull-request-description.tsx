import { Fragment, useEffect, useId, useRef, useState } from "react";
import { Marked, type Token, type Tokens, type TokensList } from "marked";
import { ChevronDown } from "lucide-react";
import type { Mermaid } from "mermaid";
import * as v from "valibot";

import { useLightbox } from "../use-lightbox";

import type { PullRequestRef } from "../../../domain/pull-request";
import {
  openPullRequestExternalUrl,
  resolvePullRequestExternalUrl,
} from "@/external-links";
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
let mermaidPromise: Promise<Mermaid> | undefined;

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
    if (globalThis.ResizeObserver === undefined) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [markdown]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pull request description</CardTitle>
        <CardDescription>
          Saved Markdown from GitHub. Links open only on this pull request’s
          GitHub host.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {markdown === undefined || markdown.trim().length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No description provided</EmptyTitle>
              <EmptyDescription>
                No description was provided on GitHub.
              </EmptyDescription>
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
                  <AlertDescription>
                    The saved preview ends at Patchdesk’s safe size limit.
                  </AlertDescription>
                </Alert>
              ) : null}
              <ScrollArea className={expanded ? undefined : "max-h-72"}>
                <div
                  ref={content}
                  className="pr-3"
                  aria-label="Pull request description rendered from Markdown"
                >
                  <PullRequestDescriptionPreview
                    markdown={markdown}
                    {...(pullRequest === undefined ? {} : { pullRequest })}
                  />
                </div>
              </ScrollArea>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
      {overflows && open ? (
        <CardFooter>
          <ButtonGroup>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setExpanded((current) => !current)}
            >
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
  return (
    <div className="flex flex-col gap-3 text-sm leading-6">
      {renderBlocks(lexSafely(markdown), pullRequest)}
    </div>
  );
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
  tokens: ReadonlyArray<Token>,
  pullRequest: PullRequestRef | undefined,
): ReadonlyArray<React.ReactNode> {
  return tokens.map((token, index) => {
    const key = tokenKey(token, index);
    switch (token.type) {
      case "space":
        return null;
      case "heading": {
        // SAFETY: `Math.min(Math.max(token.depth, 1), 6)` clamps the depth to
        // the integers 1..6, so this template string is always exactly one
        // of "h1".."h6", each a valid intrinsic element tag.
        const Tag =
          `h${Math.min(Math.max(token.depth, 1), 6)}` as keyof React.JSX.IntrinsicElements;
        return (
          <Tag key={key} className="font-semibold tracking-tight">
            {renderInline(tokensOf(token), pullRequest)}
          </Tag>
        );
      }
      case "paragraph":
        return (
          <p key={key} className="whitespace-pre-wrap break-words">
            {renderInline(tokensOf(token), pullRequest)}
          </p>
        );
      case "text":
        return (
          <Fragment key={key}>
            {renderInline(tokensOf(token), pullRequest)}
          </Fragment>
        );
      case "blockquote":
        return (
          <blockquote
            key={key}
            className="border-l-2 pl-3 text-muted-foreground"
          >
            {renderBlocks(tokensOf(token), pullRequest)}
          </blockquote>
        );
      case "code":
        return token.lang?.toLowerCase() === "mermaid" ? (
          <MermaidDiagram key={key} source={token.text} />
        ) : (
          <pre
            key={key}
            className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3"
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
            {token.items.map((item: Tokens.ListItem, itemIndex: number) => (
              <li key={`${key}-${itemIndex}`} className="pl-1">
                {item.task === true ? (
                  <Checkbox
                    checked={item.checked ?? false}
                    disabled
                    aria-label={
                      item.checked ? "Completed task" : "Incomplete task"
                    }
                  />
                ) : null}
                {renderBlocks(tokensOf(item), pullRequest)}
              </li>
            ))}
          </List>
        );
      }
      case "hr":
        return <Separator key={key} />;
      case "table":
        return (
          <Table key={key}>
            <TableHeader>
              <TableRow>
                {token.header.map(
                  (cell: Tokens.TableCell, cellIndex: number) => (
                    <TableHead key={`${key}-h-${cellIndex}`}>
                      {renderInline(cell.tokens ?? [], pullRequest)}
                    </TableHead>
                  ),
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {token.rows.map((row: Tokens.TableCell[], rowIndex: number) => (
                <TableRow key={`${key}-r-${rowIndex}`}>
                  {row.map((cell: Tokens.TableCell, cellIndex: number) => (
                    <TableCell key={`${key}-${rowIndex}-${cellIndex}`}>
                      {renderInline(cell.tokens ?? [], pullRequest)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        );
      case "html":
        return (
          <HtmlContent key={key} html={token.text} pullRequest={pullRequest} />
        );
      case "image":
        return renderMarkdownImage(token, pullRequest, key);
      default:
        return null;
    }
  });
}

function renderInline(
  tokens: ReadonlyArray<Token>,
  pullRequest: PullRequestRef | undefined,
): ReadonlyArray<React.ReactNode> {
  return tokens.map((token, index) => {
    const key = tokenKey(token, index);
    switch (token.type) {
      case "text":
      case "escape":
        return token.text;
      case "codespan":
        return (
          <code key={key} className="rounded bg-muted px-1 py-0.5 text-xs">
            {token.text}
          </code>
        );
      case "strong":
        return (
          <strong key={key}>
            {renderInline(tokensOf(token), pullRequest)}
          </strong>
        );
      case "em":
        return <em key={key}>{renderInline(tokensOf(token), pullRequest)}</em>;
      case "del":
        return (
          <del key={key}>{renderInline(tokensOf(token), pullRequest)}</del>
        );
      case "br":
        return <br key={key} />;
      case "link": {
        if (
          resolvePullRequestExternalUrl(token.href, pullRequest) === undefined
        )
          return (
            <span key={key}>{renderInline(tokensOf(token), pullRequest)}</span>
          );
        return (
          <Button
            key={key}
            variant="link"
            size="xs"
            onClick={() =>
              void openPullRequestExternalUrl(token.href, pullRequest)
            }
          >
            {renderInline(tokensOf(token), pullRequest)}
          </Button>
        );
      }
      case "image":
        return renderMarkdownImage(token, pullRequest, key);
      case "html":
        return (
          <HtmlContent key={key} html={token.text} pullRequest={pullRequest} />
        );
      default:
        return null;
    }
  });
}

/** Provides React with a stable per-position key for a Markdown token. Keyed
 * by position rather than content so repeated identical nodes (two links,
 * two matching code spans, …) don't collide and cause React to misapply
 * reconciliation across siblings. */
function tokenKey(token: Token, index: number): string {
  return `${index}-${token.type}`;
}

function tokensOf(token: Token): ReadonlyArray<Token> {
  return "tokens" in token && Array.isArray(token.tokens)
    ? token.tokens
    : [token];
}

// `renderMarkdownImage` receives `Tokens.Image | Tokens.Generic`: real
// `marked.lexer()` output always satisfies `Tokens.Image` (href/text typed as
// `string`), but `Tokens.Generic` widens the union to `[index: string]: any`
// for custom extension tokens, so the type system can't guarantee `href`/
// `text` are strings. Parse the token at this boundary instead of narrowing
// its shape by hand.
const markdownImageTokenSchema = v.object({
  href: v.string(),
  text: v.string(),
});

function renderMarkdownImage(
  token: Tokens.Image | Tokens.Generic,
  pullRequest: PullRequestRef | undefined,
  key: string,
): React.ReactNode {
  const parsed = v.safeParse(markdownImageTokenSchema, token);
  if (!parsed.success) return null;
  const { href, text } = parsed.output;
  const src = resolvePullRequestExternalUrl(href, pullRequest);
  if (src === undefined) return <span key={key}>[Image: {text}]</span>;
  return <ClickableImage key={key} src={src} alt={text} />;
}

function HtmlContent({
  html,
  pullRequest,
}: {
  readonly html: string;
  readonly pullRequest: PullRequestRef | undefined;
}): React.JSX.Element {
  if (globalThis.DOMParser === undefined) return <span>{html}</span>;
  const documentFragment = new DOMParser().parseFromString(html, "text/html");
  return (
    <>
      {renderHtmlNodes(
        Array.from(documentFragment.body.childNodes),
        pullRequest,
        "html",
      )}
    </>
  );
}

function renderHtmlNodes(
  nodes: ReadonlyArray<Node>,
  pullRequest: PullRequestRef | undefined,
  keyPrefix: string,
): ReadonlyArray<React.ReactNode> {
  return nodes.map((node, index) =>
    renderHtmlNode(node, pullRequest, `${keyPrefix}-${index}`),
  );
}

function renderHtmlNode(
  node: Node,
  pullRequest: PullRequestRef | undefined,
  key: string,
): React.ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (!(node instanceof Element)) return null;

  const tag = node.tagName.toLowerCase();
  const children = renderHtmlNodes(
    Array.from(node.childNodes),
    pullRequest,
    key,
  );
  switch (tag) {
    case "script":
    case "style":
    case "iframe":
    case "object":
    case "embed":
      return null;
    case "details":
      return (
        <details key={key} open={node.hasAttribute("open")}>
          {children}
        </details>
      );
    case "summary":
      return <summary key={key}>{children}</summary>;
    case "br":
      return <br key={key} />;
    case "p":
      return (
        <p key={key} className="whitespace-pre-wrap break-words">
          {children}
        </p>
      );
    case "div":
    case "section":
      return <div key={key}>{children}</div>;
    case "strong":
    case "b":
      return <strong key={key}>{children}</strong>;
    case "em":
    case "i":
      return <em key={key}>{children}</em>;
    case "del":
    case "s":
      return <del key={key}>{children}</del>;
    case "code":
      return (
        <code key={key} className="rounded bg-muted px-1 py-0.5 text-xs">
          {children}
        </code>
      );
    case "pre":
      return (
        <pre
          key={key}
          className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3"
        >
          {children}
        </pre>
      );
    case "ul":
      return (
        <ul key={key} className="list-disc pl-5">
          {children}
        </ul>
      );
    case "ol":
      return (
        <ol key={key} className="list-decimal pl-5">
          {children}
        </ol>
      );
    case "li":
      return (
        <li key={key} className="pl-1">
          {children}
        </li>
      );
    case "blockquote":
      return (
        <blockquote key={key} className="border-l-2 pl-3 text-muted-foreground">
          {children}
        </blockquote>
      );
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      // SAFETY: this `switch` arm is only reached when `tag` matched one of
      // the literal cases "h1".."h6" above, each a valid intrinsic tag.
      const Heading = tag as keyof React.JSX.IntrinsicElements;
      return (
        <Heading key={key} className="font-semibold tracking-tight">
          {children}
        </Heading>
      );
    }
    case "a": {
      const href = node.getAttribute("href");
      if (
        href === null ||
        resolvePullRequestExternalUrl(href, pullRequest) === undefined
      )
        return <span key={key}>{children}</span>;
      return (
        <Button
          key={key}
          variant="link"
          size="xs"
          onClick={() => void openPullRequestExternalUrl(href, pullRequest)}
        >
          {children}
        </Button>
      );
    }
    case "img": {
      const src = node.getAttribute("src");
      const alt = node.getAttribute("alt") ?? "";
      const resolved =
        src === null
          ? undefined
          : resolvePullRequestExternalUrl(src, pullRequest);
      if (resolved === undefined) return <span key={key}>[Image: {alt}]</span>;
      return <ClickableImage key={key} src={resolved} alt={alt} />;
    }
    case "table":
      return (
        <div key={key} className="overflow-x-auto">
          <table className="w-full caption-bottom text-sm">{children}</table>
        </div>
      );
    case "thead":
      return <thead key={key}>{children}</thead>;
    case "tbody":
      return <tbody key={key}>{children}</tbody>;
    case "tr":
      return (
        <tr key={key} className="border-b">
          {children}
        </tr>
      );
    case "th":
      return (
        <th key={key} className="h-10 px-2 text-left align-middle font-medium">
          {children}
        </th>
      );
    case "td":
      return (
        <td key={key} className="p-2 align-middle">
          {children}
        </td>
      );
    case "sub":
      return <sub key={key}>{children}</sub>;
    case "sup":
      return <sup key={key}>{children}</sup>;
    case "kbd":
      return (
        <kbd key={key} className="rounded border bg-muted px-1 py-0.5 text-xs">
          {children}
        </kbd>
      );
    default:
      return <span key={key}>{children}</span>;
  }
}

function MermaidDiagram({
  source,
}: {
  readonly source: string;
}): React.JSX.Element {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [svg, setSvg] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const renderContainer = document.createElement("div");
    renderContainer.style.position = "fixed";
    renderContainer.style.left = "-10000px";
    renderContainer.style.top = "0";
    renderContainer.style.width = "800px";
    renderContainer.style.height = "600px";
    renderContainer.style.overflow = "hidden";
    renderContainer.style.visibility = "hidden";
    document.body.append(renderContainer);
    setSvg(undefined);
    setFailed(false);
    void loadMermaid()
      .then((mermaid) =>
        mermaid.render(`patchdesk-mermaid-${id}`, source, renderContainer),
      )
      .then((result) => {
        if (active) setSvg(result.svg);
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        renderContainer.remove();
      });
    return () => {
      active = false;
      renderContainer.remove();
    };
  }, [id, source]);

  return (
    <ClickableMermaid
      {...(svg === undefined ? {} : { svg })}
      source={source}
      failed={failed}
    />
  );
}

function ClickableImage({
  src,
  alt,
}: {
  readonly src: string;
  readonly alt: string;
}): React.JSX.Element {
  const { lightbox, open } = useLightbox();
  return (
    <>
      <button
        type="button"
        className="cursor-zoom-in"
        onClick={() =>
          open(
            <img
              src={src}
              alt={alt}
              className="max-h-[85vh] max-w-[85vw] object-contain"
            />,
          )
        }
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className="max-w-full rounded-md"
        />
      </button>
      {lightbox()}
    </>
  );
}

function ClickableMermaid({
  svg,
  source,
  failed,
}: {
  readonly svg?: string;
  readonly source: string;
  readonly failed: boolean;
}): React.JSX.Element {
  const { lightbox, open } = useLightbox();

  if (svg === undefined) {
    return (
      <div className="space-y-2 overflow-x-auto rounded-md border bg-background p-3">
        <div role="img" aria-label="Mermaid diagram">
          <p className="text-xs text-muted-foreground">
            {failed
              ? "Mermaid could not render this diagram."
              : "Rendering Mermaid diagram…"}
          </p>
        </div>
        <details open>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Mermaid source
          </summary>
          <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-xs">
            <code>{source}</code>
          </pre>
        </details>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2 overflow-x-auto rounded-md border bg-background p-3">
        <button
          type="button"
          className="w-full cursor-zoom-in text-left"
          onClick={() =>
            open(
              <div
                aria-hidden="true"
                className="[&>svg]:h-auto [&>svg]:max-h-[85vh] [&>svg]:w-[85vw]"
                dangerouslySetInnerHTML={{ __html: svg }}
              />,
            )
          }
        >
          <div role="img" aria-label="Mermaid diagram">
            <div
              aria-hidden="true"
              className="min-w-[201px] w-full [&>svg]:block [&>svg]:h-auto [&>svg]:min-w-[201px] [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        </button>
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Mermaid source
          </summary>
          <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-xs">
            <code>{source}</code>
          </pre>
        </details>
      </div>
      {lightbox()}
    </>
  );
}

function loadMermaid(): Promise<Mermaid> {
  if (mermaidPromise !== undefined) return mermaidPromise;
  mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "dark",
    });
    return mermaid;
  });
  return mermaidPromise;
}
