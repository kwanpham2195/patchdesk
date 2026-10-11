import { useEffect, useId, useState, useSyncExternalStore } from "react";
import type { ConversationThreadCardData } from "#src/renderer/src/components/conversation-thread-card";
import { parseRepoRelativePath, type GitHubThreadId } from "#src/domain/ids";
import { fingerprintPatchAnchor } from "#src/domain/diff-anchor";
import type {
  LocalCommentLocation,
  ReviewInlineAnnotation,
} from "#src/renderer/src/components/review-diff-view";

/** A direct comment write retained until the canonical conversation represents it. */
export type CreatedThreadOverlay =
  | {
      readonly _tag: "sending" | "failed";
      readonly localId: string;
      readonly path: string;
      readonly start: number;
      readonly end: number;
      readonly side: "new" | "old";
      readonly body: string;
      readonly selectedText: string | undefined;
      readonly message?: string;
    }
  | {
      readonly _tag: "published";
      readonly localId: string;
      readonly path: string;
      readonly start: number;
      readonly end: number;
      readonly side: "new" | "old";
      readonly body: string;
      readonly selectedText: string | undefined;
      /** REST id from the write receipt. */
      readonly commentId: string;
      /** GraphQL node id used by the canonical conversation projection. */
      readonly commentNodeId: string;
      readonly threadId?: GitHubThreadId;
    };

/** View changes can retain an anchor only while its selected source text still matches. */
export function inlineDraftKey(
  patch: string,
  location: LocalCommentLocation,
  kind: "note" | undefined,
): string {
  const path = parseRepoRelativePath(location.path);
  const lines =
    path._tag === "ok"
      ? fingerprintPatchAnchor(patch, { ...location, path: path.value })
          ?.selectedLines
      : undefined;
  return JSON.stringify([
    kind ?? "comment",
    location.path,
    location.side,
    location.startLine,
    location.line,
    lines,
  ]);
}

type ConversationSnapshot = {
  readonly createdThreads: ReadonlyArray<CreatedThreadOverlay>;
  readonly editedBodies: ReadonlyMap<string, string>;
  readonly deletedCommentIds: ReadonlySet<string>;
  readonly resolvedThreads: ReadonlyMap<string, "open" | "resolved">;
  readonly draftBodies: ReadonlyMap<string, string>;
  readonly replyReceipts: ReadonlyMap<
    string,
    ConversationThreadCardData["comments"]
  >;
};

type ConversationOverlaySnapshot = Pick<
  ConversationSnapshot,
  | "createdThreads"
  | "editedBodies"
  | "deletedCommentIds"
  | "resolvedThreads"
  | "replyReceipts"
>;

/** Renderer state of one Review session, shared by independently mounted diff appearances. */
export type ReviewConversationOwner = {
  /** Supplies renderer receipt metadata without reading time inside mutation wrappers. */
  readonly now: () => string;
  readonly retainReply: (
    threadId: string,
    comment: ConversationThreadCardData["comments"][number],
  ) => void;
  readonly setCreatedThreads: (
    change: (
      current: ReadonlyArray<CreatedThreadOverlay>,
    ) => ReadonlyArray<CreatedThreadOverlay>,
  ) => void;
  readonly setEditedBodies: (
    change: (
      current: ReadonlyMap<string, string>,
    ) => ReadonlyMap<string, string>,
  ) => void;
  readonly setDeletedCommentIds: (
    change: (current: ReadonlySet<string>) => ReadonlySet<string>,
  ) => void;
  readonly setResolvedThreads: (
    change: (
      current: ReadonlyMap<string, "open" | "resolved">,
    ) => ReadonlyMap<string, "open" | "resolved">,
  ) => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ConversationSnapshot;
  readonly getOverlaySnapshot: () => ConversationOverlaySnapshot;
  readonly update: (
    change: (current: ConversationSnapshot) => ConversationSnapshot,
  ) => void;
  readonly reconcile: (
    annotations: ReadonlyArray<ReviewInlineAnnotation>,
  ) => void;
  readonly nextLocalId: (prefix: string) => string;
  readonly activate: (
    report: ((fieldId: string, text: string) => void) | undefined,
  ) => void;
  readonly dispose: () => void;
};

function createConversationOwner(
  fieldId: string,
  now: () => string,
): ReviewConversationOwner {
  let active = true;
  let localId = 0;
  let snapshot: ConversationSnapshot = {
    createdThreads: [],
    editedBodies: new Map(),
    deletedCommentIds: new Set(),
    resolvedThreads: new Map(),
    draftBodies: new Map(),
    replyReceipts: new Map(),
  };
  let overlaySnapshot = conversationOverlaySnapshot(snapshot);
  let canonical: ReadonlyArray<ReviewInlineAnnotation> | undefined;
  let canonicalCommentIds: ReadonlySet<string> = new Set();
  let canonicalThreadIds: ReadonlySet<string> = new Set();
  let canonicalCommentBodies: ReadonlyMap<string, string> = new Map();
  let canonicalThreadStates: ReadonlyMap<string, string> = new Map();
  let unsentReporter: ((fieldId: string, text: string) => void) | undefined;
  const listeners = new Set<() => void>();
  const reportDrafts = (): void => {
    const drafts = [...snapshot.draftBodies]
      .filter(([, body]) => body.trim() !== "")
      .sort(([a], [b]) => a.localeCompare(b));
    unsentReporter?.(
      fieldId,
      active && drafts.length > 0 ? JSON.stringify(drafts) : "",
    );
  };
  const update: ReviewConversationOwner["update"] = (change) => {
    if (!active) return;
    const next = change(snapshot);
    if (next === snapshot) return;
    snapshot = next;
    if (
      next.createdThreads !== overlaySnapshot.createdThreads ||
      next.editedBodies !== overlaySnapshot.editedBodies ||
      next.deletedCommentIds !== overlaySnapshot.deletedCommentIds ||
      next.resolvedThreads !== overlaySnapshot.resolvedThreads ||
      next.replyReceipts !== overlaySnapshot.replyReceipts
    )
      overlaySnapshot = conversationOverlaySnapshot(next);
    reportDrafts();
    for (const listener of listeners) listener();
  };
  return {
    now,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    getOverlaySnapshot: () => overlaySnapshot,
    retainReply: (threadId, comment) => {
      if (canonicalCommentIds.has(comment.id)) return;
      update((current) => {
        const replyReceipts = new Map(current.replyReceipts);
        replyReceipts.set(threadId, [
          ...(replyReceipts.get(threadId) ?? []),
          comment,
        ]);
        return { ...current, replyReceipts };
      });
    },
    setCreatedThreads: (change) =>
      update((current) => ({
        ...current,
        createdThreads: reconciledCreatedThreads(
          change(current.createdThreads),
          canonicalCommentIds,
          canonicalThreadIds,
        ),
      })),
    setEditedBodies: (change) =>
      update((current) => ({
        ...current,
        editedBodies: new Map(
          [...change(current.editedBodies)].filter(
            ([id, body]) => canonicalCommentBodies.get(id) !== body,
          ),
        ),
      })),
    setDeletedCommentIds: (change) =>
      update((current) => {
        const deletedCommentIds = change(current.deletedCommentIds);
        const replyReceipts = new Map(
          [...current.replyReceipts].map(([id, replies]) => [
            id,
            replies.filter((reply) => !deletedCommentIds.has(reply.id)),
          ]),
        );
        return { ...current, deletedCommentIds, replyReceipts };
      }),
    setResolvedThreads: (change) =>
      update((current) => ({
        ...current,
        resolvedThreads: new Map(
          [...change(current.resolvedThreads)].filter(
            ([id, state]) => canonicalThreadStates.get(id) !== state,
          ),
        ),
      })),
    update,
    nextLocalId: (prefix) => `${prefix}-${fieldId}-${localId++}`,
    activate: (report) => {
      if (unsentReporter !== report) unsentReporter?.(fieldId, "");
      unsentReporter = report;
      active = true;
      reportDrafts();
    },
    dispose: () => {
      active = false;
      reportDrafts();
    },
    reconcile: (annotations) => {
      if (canonical === annotations) return;
      canonical = annotations;
      const commentIds = new Set<string>();
      const commentBodies = new Map<string, string>();
      const threadStates = new Map<string, string>();
      for (const annotation of annotations) {
        const thread = annotation.conversationThread;
        if (thread === undefined) continue;
        if (thread.target._tag === "thread")
          threadStates.set(thread.target.id, thread.state);
        for (const comment of thread.comments) {
          commentIds.add(comment.id);
          commentBodies.set(comment.id, comment.body);
        }
      }
      canonicalCommentBodies = commentBodies;
      canonicalThreadStates = threadStates;
      canonicalCommentIds = commentIds;
      canonicalThreadIds = new Set(threadStates.keys());
      update((current) => {
        const createdThreads = reconciledCreatedThreads(
          current.createdThreads,
          commentIds,
          canonicalThreadIds,
        );
        const replyReceipts = new Map(current.replyReceipts);
        let retiredReplies = false;
        for (const [id, replies] of replyReceipts) {
          const kept = replies.filter((reply) => !commentIds.has(reply.id));
          if (kept.length === replies.length) continue;
          retiredReplies = true;
          if (kept.length === 0) replyReceipts.delete(id);
          else replyReceipts.set(id, kept);
        }
        const editedBodies = new Map(current.editedBodies);
        for (const [id, body] of editedBodies)
          if (commentBodies.get(id) === body) editedBodies.delete(id);
        const deletedCommentIds = new Set(current.deletedCommentIds);
        for (const id of deletedCommentIds)
          if (!commentIds.has(id)) deletedCommentIds.delete(id);
        const resolvedThreads = new Map(current.resolvedThreads);
        for (const [id, state] of resolvedThreads)
          if (threadStates.get(id) === state) resolvedThreads.delete(id);
        if (
          createdThreads.length === current.createdThreads.length &&
          editedBodies.size === current.editedBodies.size &&
          deletedCommentIds.size === current.deletedCommentIds.size &&
          resolvedThreads.size === current.resolvedThreads.size &&
          !retiredReplies
        )
          return current;
        return {
          ...current,
          createdThreads,
          editedBodies,
          deletedCommentIds,
          resolvedThreads,
          replyReceipts,
        };
      });
    },
  };
}

// Observation may arrive before a create response, so receipt arrival also reconciles against the canonical ids.
function reconciledCreatedThreads(
  entries: ReadonlyArray<CreatedThreadOverlay>,
  commentIds: ReadonlySet<string>,
  threadIds: ReadonlySet<string>,
): ReadonlyArray<CreatedThreadOverlay> {
  return entries.filter(
    (entry) =>
      entry._tag !== "published" ||
      !(
        (entry.threadId !== undefined && threadIds.has(entry.threadId)) ||
        commentIds.has(entry.commentId) ||
        commentIds.has(entry.commentNodeId)
      ),
  );
}

/** Owns the session's unsent guard and reconciles complete canonical annotations, never appearance-filtered ones. */
export function useReviewConversationOwner(
  reviewId: string,
  sessionId: string,
  annotations: ReadonlyArray<ReviewInlineAnnotation>,
  {
    now = () => new Date().toISOString(),
    reportUnsent,
  }: {
    readonly now?: () => string;
    readonly reportUnsent?:
      | ((fieldId: string, text: string) => void)
      | undefined;
  } = {},
): ReviewConversationOwner {
  const fieldId = useId();
  const [scope, setScope] = useState(() => ({
    reviewId,
    sessionId,
    generation: 0,
    owner: createConversationOwner(`${fieldId}-0`, now),
  }));
  let owner = scope.owner;
  if (scope.reviewId !== reviewId || scope.sessionId !== sessionId) {
    const generation = scope.generation + 1;
    // Pending writes outlive a session, so its replacement must not reuse receipt identities.
    owner = createConversationOwner(`${fieldId}-${generation}`, now);
    setScope({ reviewId, sessionId, generation, owner });
  }
  useEffect(() => {
    owner.activate(reportUnsent);
    return () => owner.dispose();
  }, [owner, reportUnsent]);
  useEffect(() => owner.reconcile(annotations), [annotations, owner]);
  return owner;
}

function conversationOverlaySnapshot(
  snapshot: ConversationSnapshot,
): ConversationOverlaySnapshot {
  return {
    createdThreads: snapshot.createdThreads,
    editedBodies: snapshot.editedBodies,
    deletedCommentIds: snapshot.deletedCommentIds,
    resolvedThreads: snapshot.resolvedThreads,
    replyReceipts: snapshot.replyReceipts,
  };
}

const subscribeToNoDraft = (): (() => void) => () => undefined;

type ReviewConversationDraft = {
  readonly body: string | undefined;
  readonly setBody: (body: string | undefined) => void;
  readonly clearSubmitted: (body: string) => void;
};

/** Published card text shares the session lifetime; cards outside a diff retain appearance scope. */
export function useReviewConversationDraft(
  owner: ReviewConversationOwner | undefined,
  key: string,
): ReviewConversationDraft {
  const [localBody, setLocalBody] = useState<string>();
  const body = useSyncExternalStore(
    owner?.subscribe ?? subscribeToNoDraft,
    () =>
      owner === undefined
        ? localBody
        : owner.getSnapshot().draftBodies.get(key),
  );
  const setBody = (next: string | undefined): void => {
    if (owner === undefined) {
      setLocalBody(next);
      return;
    }
    owner.update((current) => {
      const draftBodies = new Map(current.draftBodies);
      if (next === undefined) draftBodies.delete(key);
      else draftBodies.set(key, next);
      return { ...current, draftBodies };
    });
  };
  return {
    body,
    setBody,
    // A late receipt must not erase newer text typed in another appearance.
    clearSubmitted: (submitted) => {
      if (owner === undefined) {
        setLocalBody((current) =>
          current === submitted ? undefined : current,
        );
      } else if (owner.getSnapshot().draftBodies.get(key) === submitted) {
        setBody(undefined);
      }
    },
  };
}

/** Draft keystrokes notify their composer, not Pierre's full annotation list. */
export function useReviewConversationOverlaySnapshot(
  owner: ReviewConversationOwner,
): ConversationOverlaySnapshot {
  return useSyncExternalStore(owner.subscribe, owner.getOverlaySnapshot);
}
