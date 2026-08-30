import {
  MarkdownContent,
  MarkdownInline,
  type MarkdownContentPolicy,
} from "./markdown-content";

import { cn } from "../lib/utils";

const generatedMarkdownPolicy: MarkdownContentPolicy = {
  renderLink: ({ children, key }) => <span key={key}>{children}</span>,
  renderImage: ({ key }) => <span key={key}>[Image omitted]</span>,
  renderHtml: ({ html, key }) => <span key={key}>{html}</span>,
};

/** Renders model prose with shared Markdown presentation and inert rich content. */
export function GeneratedMarkdown({
  markdown,
  className,
}: {
  readonly markdown: string;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <MarkdownContent
      generatedMarkdown
      markdown={markdown}
      policy={generatedMarkdownPolicy}
      className={cn("text-foreground", className)}
    />
  );
}

/**
 * Model prose that must stay inside its caller's own element: one sentence of
 * a Brief carries its citation chips in the same paragraph, so the block
 * renderer's wrapper would break the line.
 */
export function GeneratedMarkdownInline({
  markdown,
}: {
  readonly markdown: string;
}): React.JSX.Element {
  return (
    <MarkdownInline markdown={markdown} policy={generatedMarkdownPolicy} />
  );
}
