import {
  MarkdownContent,
  type MarkdownContentPolicy,
} from "./markdown-content";

const markdownFilePreviewPolicy: MarkdownContentPolicy = {
  renderLink: ({ children, key }) => <span key={key}>{children}</span>,
  renderImage: ({ key }) => <span key={key}>[Image omitted]</span>,
  renderHtml: ({ children, key }) => <span key={key}>{children}</span>,
};

/** Renders verified repository Markdown without activating embedded links or remote content. */
export function MarkdownFilePreview({
  markdown,
  path,
}: {
  readonly markdown: string;
  readonly path: string;
}): React.JSX.Element {
  return (
    <article
      aria-label={`Preview of ${path}`}
      className="border-t bg-background px-6 py-5 text-foreground"
    >
      <MarkdownContent markdown={markdown} policy={markdownFilePreviewPolicy} />
    </article>
  );
}
