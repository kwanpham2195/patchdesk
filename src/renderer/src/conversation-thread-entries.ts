import type { ReviewInlineAnnotation } from "./components/review-diff-view";

/**
 * Merges published Conversation thread annotations with pending-review reply
 * annotations into the entry list the diff (and, eventually, a Threads
 * navigator section) consumes. A published thread that also has a pending
 * reply is deduped to its pending entry — the pending card is the
 * authoritative view for the review owner — so each Conversation thread
 * renders exactly once.
 */
export function deriveConversationThreadEntries(
  published: ReadonlyArray<ReviewInlineAnnotation>,
  pending: ReadonlyArray<ReviewInlineAnnotation>,
): ReadonlyArray<ReviewInlineAnnotation> {
  const pendingThreadIds = new Set(
    pending.flatMap((annotation) =>
      annotation.pendingReviewThread === undefined
        ? []
        : [annotation.pendingReviewThread.threadId],
    ),
  );
  const publishedEntries = published.flatMap(
    (annotation): ReadonlyArray<ReviewInlineAnnotation> =>
      annotation.conversationThread?.target._tag === "thread" &&
      pendingThreadIds.has(annotation.conversationThread.target.id)
        ? []
        : [annotation],
  );
  return [...publishedEntries, ...pending];
}

/**
 * A Threads navigator row's display state: the four published thread states
 * plus `"pending"` for a viewer-authored reply not yet submitted. This type
 * mirrors `ConversationThreadCardData["state"]` (`conversation-thread-card.tsx`)
 * rather than being derived from it, because that type is also used by the
 * Conversation screen's general (unanchored) threads, which genuinely can be
 * `"outdated"` or `"unknown"`. The threads reaching *this* navigator never
 * are: `mapConversationThread` and `projectReadOnlyConversationAnnotations`
 * (`inline-conversation-mapping.ts`) exclude outdated threads and anything
 * whose state isn't `"open"` or `"resolved"` before an entry is ever built.
 * `"outdated"` and `"unknown"` stay in this union — and in
 * `threadRowStateBadge`'s switch (`review-navigator.tsx`), which renders it —
 * only so the type keeps matching its wider source rather than requiring a
 * cast at the boundary.
 */
export type ConversationThreadRowState =
  | "open"
  | "resolved"
  | "outdated"
  | "unknown"
  | "pending";

/** One row the Threads navigator section renders. */
export type ConversationThreadRow = {
  readonly id: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly side: "new" | "old";
  readonly author: string;
  /** Short, whitespace-collapsed excerpt of the opening comment body. */
  readonly preview: string;
  readonly state: ConversationThreadRowState;
};

const PREVIEW_MAX_LENGTH = 80;

function previewOf(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > PREVIEW_MAX_LENGTH
    ? `${collapsed.slice(0, PREVIEW_MAX_LENGTH - 1)}…`
    : collapsed;
}

/**
 * Projects a `deriveConversationThreadEntries` entry to a Threads row.
 * Published and pending entries are mutually exclusive by construction
 * (disjoint construction sites in `review-workbench.tsx`), so this
 * discriminates on field presence rather than a tag. An entry with neither
 * field (findings, or a future annotation kind) contributes no row.
 */
function projectConversationThreadRow(
  entry: ReviewInlineAnnotation,
): ReadonlyArray<ConversationThreadRow> {
  if (entry.conversationThread !== undefined) {
    const opening = entry.conversationThread.comments[0];
    return [
      {
        id: entry.id,
        path: entry.path,
        start: entry.start,
        end: entry.end,
        side: entry.side,
        author: opening?.author ?? "Unknown",
        preview: previewOf(opening?.body ?? ""),
        state: entry.conversationThread.state,
      },
    ];
  }
  if (entry.pendingReviewThread !== undefined) {
    return [
      {
        id: entry.id,
        path: entry.path,
        start: entry.start,
        end: entry.end,
        side: entry.side,
        author: "You",
        preview: previewOf(entry.pendingReviewThread.body),
        state: "pending",
      },
    ];
  }
  return [];
}

/**
 * Projects Conversation thread entries into Threads navigator rows, ordered
 * by the entry's file position in `fileOrder` (the parsed patch's file
 * order, as already computed for the file tree) then by `start` ascending —
 * diff order, not alphabetical and not the published-then-pending concat
 * order `deriveConversationThreadEntries` returns. An entry whose path is
 * absent from `fileOrder` (should not happen for a well-formed patch) sorts
 * after every entry whose file the patch does place.
 */
export function projectConversationThreadRows(
  entries: ReadonlyArray<ReviewInlineAnnotation>,
  fileOrder: ReadonlyArray<string>,
): ReadonlyArray<ConversationThreadRow> {
  const orderByPath = new Map(
    fileOrder.map((path, index) => [path, index] as const),
  );
  const rows = entries.flatMap(projectConversationThreadRow);
  return rows.sort((a, b) => {
    const orderA = orderByPath.get(a.path) ?? fileOrder.length;
    const orderB = orderByPath.get(b.path) ?? fileOrder.length;
    return orderA !== orderB ? orderA - orderB : a.start - b.start;
  });
}
