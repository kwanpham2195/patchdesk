import {
  MarkdownContent,
  type MarkdownContentPolicy,
} from "./markdown-content";

const markdownFilePreviewPolicy: MarkdownContentPolicy = {
  renderLink: ({ children, key }) => <span key={key}>{children}</span>,
  renderImage: ({ key }) => <span key={key}>[Image omitted]</span>,
  renderHtml: ({ children, key }) => <span key={key}>{children}</span>,
};

/**
 * Renders verified repository Markdown without activating embedded links or
 * remote content. This is the file pane's own scroll region, not a row inside
 * the virtualized CodeView, so its height is the Markdown's real height.
 */
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
      data-review-diff-markdown-pane={path}
      // Focusable so the keyboard can scroll it, matching what
      // `setViewerContainer` applies to the CodeView container.
      tabIndex={0}
      className="min-h-0 flex-1 overflow-y-auto bg-background px-6 py-5 text-foreground"
    >
      <MarkdownContent markdown={markdown} policy={markdownFilePreviewPolicy} />
    </article>
  );
}
