import type { DiffLineAnnotation } from "@pierre/diffs";

import {
  ConversationThreadCard,
  type ConversationThreadCardData,
} from "./conversation-thread-card";
import {
  InlineCommentComposer,
  LocalCommentThread,
  PendingConversationCard,
  PendingReviewThreadCard,
  PendingReviewWriteCard,
} from "./review-diff-authoring";
import type { ReviewInlineAnnotation } from "./review-diff-view";
import { Button } from "@/components/ui/button";

/** Renders one diff annotation: composer, pending, conversation, local comment, or a finding card. */
export function renderReviewDiffAnnotation(
  annotation: DiffLineAnnotation<ReviewInlineAnnotation | undefined>,
  decorateConversationThread: (
    thread: ConversationThreadCardData,
  ) => ConversationThreadCardData,
  onOpenFindingInAnalysis: ((findingId: string) => void) | undefined,
): React.JSX.Element | null {
  const finding = annotation.metadata;
  if (finding === undefined) return null;
  if (finding.localComposer !== undefined) {
    return <InlineCommentComposer {...finding.localComposer} />;
  }
  if (finding.pendingConversation !== undefined) {
    return <PendingConversationCard {...finding.pendingConversation} />;
  }
  if (finding.pendingReviewWrite !== undefined) {
    return <PendingReviewWriteCard {...finding.pendingReviewWrite} />;
  }
  if (finding.pendingReviewThread !== undefined) {
    return <PendingReviewThreadCard {...finding.pendingReviewThread} />;
  }
  if (finding.conversationThread !== undefined) {
    return (
      <ConversationThreadCard
        thread={decorateConversationThread(finding.conversationThread)}
        navAnchorId={finding.id}
      />
    );
  }
  if (finding.localComment !== undefined) {
    return (
      <LocalCommentThread
        path={finding.path}
        startLine={finding.start}
        line={finding.end}
        body={finding.localComment.body}
      />
    );
  }
  return (
    <article
      className="mx-2 my-2 box-border w-[calc(100%-1rem)] min-w-0 max-w-[min(42rem,calc(100%-1rem))] overflow-hidden whitespace-normal rounded-md border border-primary/30 bg-primary/5 px-3 py-2 font-sans text-sm text-foreground shadow-sm"
      data-review-inline-finding={finding.id}
      aria-label={`${finding.severity} finding: ${finding.title}`}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="text-xs font-semibold text-primary">
          {finding.severity}
        </span>
        {/* Not a document heading: this is a label on a floating
        annotation card, not a section of the page's outline, and the
        enclosing article already carries the same text in its
        aria-label. A real <h3> here skips straight from the page's
        <h1> with no <h2> between them (axe: heading-order). */}
        <span className="min-w-0 break-words font-medium">{finding.title}</span>
        {onOpenFindingInAnalysis === undefined ? null : (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto shrink-0"
            aria-label="Open finding in Analysis"
            onClick={() => onOpenFindingInAnalysis(finding.id)}
          >
            Open in Analysis
          </Button>
        )}
      </div>
      <p className="mt-1 break-words text-muted-foreground">
        {finding.explanation}
      </p>
    </article>
  );
}
