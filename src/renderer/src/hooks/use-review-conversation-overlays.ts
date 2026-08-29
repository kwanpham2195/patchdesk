import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { CodeViewLineSelection } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";

import { PatchdeskApiError } from "../api-client";
import { definedProps } from "../../../domain/defined-props";
import { fingerprintPatchAnchor } from "../../../domain/diff-anchor";
import {
  parseGitHubThreadId,
  parseRepoRelativePath,
  type GitHubThreadId,
} from "../../../domain/ids";
import { composerErrorMessage } from "../components/review-diff-authoring-errors";
import type {
  ConversationThreadCardData,
  ReviewConversationActions,
} from "../components/conversation-thread-card";
import type {
  LocalCommentAuthoring,
  LocalCommentAuthoringSaveInput,
  LocalCommentLocation,
  PendingReviewComposerActions,
  ReviewInlineAnnotation,
} from "../components/review-diff-view";

type CreatedThreadOverlay =
  | {
      readonly _tag: "sending";
      readonly localId: string;
      readonly path: string;
      readonly start: number;
      readonly end: number;
      readonly side: "new" | "old";
      readonly body: string;
    }
  | {
      readonly _tag: "failed";
      readonly localId: string;
      readonly path: string;
      readonly start: number;
      readonly end: number;
      readonly side: "new" | "old";
      readonly body: string;
    }
  | {
      readonly _tag: "published";
      readonly localId: string;
      readonly path: string;
      readonly start: number;
      readonly end: number;
      readonly side: "new" | "old";
      readonly body: string;
      readonly commentId: string;
      readonly threadId?: GitHubThreadId;
    };

type PendingReviewWriteOverlay =
  | {
      readonly _tag: "sending";
      readonly localId: string;
      readonly action: "start" | "add";
      readonly path: string;
      readonly start: number;
      readonly end: number;
      readonly side: "new" | "old";
      readonly body: string;
    }
  | {
      readonly _tag: "failed";
      readonly localId: string;
      readonly action: "start" | "add";
      readonly path: string;
      readonly start: number;
      readonly end: number;
      readonly side: "new" | "old";
      readonly body: string;
      readonly message: string;
    };

export type ReviewConversationOverlays = {
  readonly displayedAnnotations: ReadonlyArray<ReviewInlineAnnotation>;
  readonly localComposerAnnotation: ReviewInlineAnnotation | undefined;
  readonly beginAccessibleAuthoring: (
    path: string,
    line: number,
    side: "additions" | "deletions",
  ) => void;
  readonly beginAuthoring: (selection: CodeViewLineSelection | null) => void;
  readonly decorateConversationThread: (
    thread: ConversationThreadCardData,
  ) => ConversationThreadCardData;
};

export function useReviewConversationOverlays({
  patch,
  annotations,
  viewer,
  localCommentAuthoring,
  pendingReviewComposer,
  conversationActions,
}: {
  readonly patch: string;
  readonly annotations: ReadonlyArray<ReviewInlineAnnotation>;
  readonly viewer: RefObject<CodeViewHandle<
    ReviewInlineAnnotation | undefined
  > | null>;
  readonly localCommentAuthoring: LocalCommentAuthoring | undefined;
  readonly pendingReviewComposer: PendingReviewComposerActions | undefined;
  readonly conversationActions: ReviewConversationActions | undefined;
}): ReviewConversationOverlays {
  const [authoringSelection, setAuthoringSelection] =
    useState<CodeViewLineSelection | null>(null);
  const [createdThreads, setCreatedThreads] = useState<
    ReadonlyArray<CreatedThreadOverlay>
  >([]);
  const [pendingWriteOverlays, setPendingWriteOverlays] = useState<
    ReadonlyArray<PendingReviewWriteOverlay>
  >([]);
  const localIdCounter = useRef(0);
  const [editedBodies, setEditedBodies] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [deletedCommentIds, setDeletedCommentIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [resolvedThreads, setResolvedThreads] = useState<
    ReadonlyMap<string, "open" | "resolved">
  >(() => new Map());

  // Published writes are authoritative (the receipt is GitHub's 200) and the
  // projection only changes on an explicit refresh or reload. Local mutation
  // overrides keep cards truthful until the projection catches up.
  useEffect(() => {
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
    setCreatedThreads((current) => {
      const reconciled = current.filter(
        (entry) =>
          entry._tag !== "published" || !commentIds.has(entry.commentId),
      );
      return reconciled.length === current.length ? current : reconciled;
    });
    setEditedBodies((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [commentId, body] of next) {
        if (commentBodies.get(commentId) === body) {
          next.delete(commentId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setDeletedCommentIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const commentId of next) {
        if (!commentIds.has(commentId)) {
          next.delete(commentId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setResolvedThreads((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [threadId, state] of next) {
        if (threadStates.get(threadId) === state) {
          next.delete(threadId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [annotations]);

  const clearAuthoring = useCallback((): void => {
    setAuthoringSelection(null);
    viewer.current?.clearSelectedLines();
  }, [viewer]);

  const beginAccessibleAuthoring = useCallback(
    (path: string, line: number, side: "additions" | "deletions"): void => {
      if (localCommentAuthoring?.enabled !== true) return;
      const location: LocalCommentLocation = {
        path,
        startLine: line,
        line,
        side: side === "additions" ? "new" : "old",
      };
      if (localCommentAuthoring.canAuthor?.(location) === false) return;
      localCommentAuthoring.onSelectionChange?.(location);
      setAuthoringSelection({
        id: path,
        range: { start: line, end: line, side },
      });
    },
    [localCommentAuthoring],
  );

  const saveAuthoring = useCallback(
    async (body: string): Promise<void> => {
      if (
        authoringSelection === null ||
        localCommentAuthoring?.enabled !== true
      )
        return;
      const side: "new" | "old" =
        authoringSelection.range.side === "additions" ? "new" : "old";
      const parsedPath = parseRepoRelativePath(authoringSelection.id);
      const anchor =
        parsedPath._tag === "ok"
          ? {
              path: parsedPath.value,
              startLine: authoringSelection.range.start,
              line: authoringSelection.range.end,
              side,
            }
          : undefined;
      if (anchor === undefined) return;
      const fingerprint = fingerprintPatchAnchor(patch, anchor);
      const localId = `local-${Date.now().toString(36)}-${localIdCounter.current}`;
      localIdCounter.current += 1;
      setCreatedThreads((current) => [
        ...current,
        {
          _tag: "sending",
          localId,
          path: anchor.path,
          start: anchor.startLine,
          end: anchor.line,
          side: anchor.side,
          body,
        },
      ]);
      clearAuthoring();
      try {
        const saveInput: LocalCommentAuthoringSaveInput = {
          path: authoringSelection.id,
          startLine: anchor.startLine,
          line: anchor.line,
          side,
          body,
          ...definedProps({ fingerprint }),
        };
        const receipt = await localCommentAuthoring.onSave(saveInput);
        const parsedThreadId =
          receipt?.threadId === undefined
            ? undefined
            : parseGitHubThreadId(receipt.threadId);
        const publishedBase = {
          _tag: "published" as const,
          localId,
          path: anchor.path,
          start: anchor.startLine,
          end: anchor.line,
          side: anchor.side,
          body,
        };
        const nextEntry: CreatedThreadOverlay =
          receipt !== undefined && receipt.commentId !== undefined
            ? parsedThreadId?._tag === "ok"
              ? {
                  ...publishedBase,
                  commentId: receipt.commentId,
                  threadId: parsedThreadId.value,
                }
              : { ...publishedBase, commentId: receipt.commentId }
            : {
                _tag: "failed" as const,
                localId,
                path: anchor.path,
                start: anchor.startLine,
                end: anchor.line,
                side: anchor.side,
                body,
              };
        setCreatedThreads((current) =>
          current.map((entry) =>
            entry.localId === localId ? nextEntry : entry,
          ),
        );
      } catch {
        setCreatedThreads((current) =>
          current.map((entry) =>
            entry.localId === localId
              ? {
                  _tag: "failed" as const,
                  localId: entry.localId,
                  path: entry.path,
                  start: entry.start,
                  end: entry.end,
                  side: entry.side,
                  body: entry.body,
                }
              : entry,
          ),
        );
      }
    },
    [authoringSelection, clearAuthoring, localCommentAuthoring, patch],
  );

  const submitPendingWrite = useCallback(
    async (
      action: "start" | "add",
      anchor: LocalCommentLocation,
      body: string,
      run: (anchor: LocalCommentLocation, body: string) => Promise<void>,
    ): Promise<void> => {
      const localId = `pending-write-${Date.now().toString(36)}-${localIdCounter.current}`;
      localIdCounter.current += 1;
      setPendingWriteOverlays((current) => [
        ...current,
        {
          _tag: "sending",
          localId,
          action,
          path: anchor.path,
          start: anchor.startLine,
          end: anchor.line,
          side: anchor.side,
          body,
        },
      ]);
      clearAuthoring();
      try {
        await run(anchor, body);
        setPendingWriteOverlays((current) =>
          current.filter((entry) => entry.localId !== localId),
        );
      } catch (cause) {
        if (
          cause instanceof PatchdeskApiError &&
          cause.kind === "outcome_unknown"
        ) {
          setPendingWriteOverlays((current) =>
            current.filter((entry) => entry.localId !== localId),
          );
          return;
        }
        setPendingWriteOverlays((current) =>
          current.map((entry) =>
            entry.localId === localId
              ? {
                  ...entry,
                  _tag: "failed" as const,
                  message: composerErrorMessage(cause),
                }
              : entry,
          ),
        );
      }
    },
    [clearAuthoring],
  );

  const localComposerAnnotation = useMemo<
    ReviewInlineAnnotation | undefined
  >(() => {
    if (authoringSelection === null || localCommentAuthoring?.enabled !== true)
      return undefined;
    const wrappedPendingReview: PendingReviewComposerActions | undefined =
      pendingReviewComposer === undefined
        ? undefined
        : {
            ...pendingReviewComposer,
            onStartReview: (anchor, body) =>
              submitPendingWrite(
                "start",
                anchor,
                body,
                pendingReviewComposer.onStartReview,
              ),
            onAddReviewComment: (nodeId, anchor, body) =>
              submitPendingWrite("add", anchor, body, (a, b) =>
                pendingReviewComposer.onAddReviewComment(nodeId, a, b),
              ),
          };
    return {
      id: `local-comment:${authoringSelection.id}:${authoringSelection.range.start}:${authoringSelection.range.end}:${authoringSelection.range.side}`,
      path: authoringSelection.id,
      start: authoringSelection.range.start,
      end: authoringSelection.range.end,
      side: authoringSelection.range.side === "additions" ? "new" : "old",
      severity: "info",
      title: "Local comment",
      explanation: "",
      localComposer: {
        path: authoringSelection.id,
        startLine: authoringSelection.range.start,
        line: authoringSelection.range.end,
        side: authoringSelection.range.side === "additions" ? "new" : "old",
        onCancel: clearAuthoring,
        onSave: saveAuthoring,
        ...definedProps({ pendingReview: wrappedPendingReview }),
      },
    };
  }, [
    authoringSelection,
    clearAuthoring,
    localCommentAuthoring?.enabled,
    pendingReviewComposer,
    saveAuthoring,
    submitPendingWrite,
  ]);

  const optimisticAnnotations = useMemo<ReadonlyArray<ReviewInlineAnnotation>>(
    () => [
      ...createdThreads.map((entry: CreatedThreadOverlay) => {
        if (entry._tag !== "published") {
          return {
            id: `conversation:pending:${entry.localId}`,
            path: entry.path,
            start: entry.start,
            end: entry.end,
            side: entry.side,
            severity: "conversation",
            title: "Conversation",
            explanation: "",
            pendingConversation: {
              localId: entry.localId,
              status: entry._tag,
              body: entry.body,
              onDismiss: (localId: string) =>
                setCreatedThreads((current) =>
                  current.filter((candidate) => candidate.localId !== localId),
                ),
            },
          };
        }
        const conversationThread: ConversationThreadCardData = {
          target:
            entry.threadId === undefined
              ? { _tag: "comment_only" as const, commentId: entry.commentId }
              : { _tag: "thread" as const, id: entry.threadId },
          state: "open" as const,
          complete: true,
          comments: [
            {
              id: entry.commentId,
              author: "You",
              body: entry.body,
              createdAt: new Date().toISOString(),
              viewerDidAuthor: true,
            },
          ],
          ...definedProps({
            onEditComment: conversationActions?.editComment,
            onDeleteComment: conversationActions?.deleteComment,
          }),
        };
        return {
          id: `conversation:${entry.commentId}`,
          path: entry.path,
          start: entry.start,
          end: entry.end,
          side: entry.side,
          severity: "conversation",
          title: "Conversation",
          explanation: "",
          conversationThread,
        };
      }),
      ...pendingWriteOverlays.map((entry: PendingReviewWriteOverlay) => {
        const pendingReviewWrite: NonNullable<
          ReviewInlineAnnotation["pendingReviewWrite"]
        > = {
          localId: entry.localId,
          status: entry._tag,
          action: entry.action,
          body: entry.body,
          onDismiss: (localId: string) =>
            setPendingWriteOverlays((current) =>
              current.filter((candidate) => candidate.localId !== localId),
            ),
          ...definedProps({
            message: entry._tag === "failed" ? entry.message : undefined,
          }),
        };
        return {
          id: `pending-write:${entry.localId}`,
          path: entry.path,
          start: entry.start,
          end: entry.end,
          side: entry.side,
          severity: "conversation",
          title: "Pending review write",
          explanation: "",
          pendingReviewWrite,
        };
      }),
    ],
    [conversationActions, createdThreads, pendingWriteOverlays],
  );

  const renderedAnnotations = useMemo(
    () =>
      localComposerAnnotation === undefined
        ? [...annotations, ...optimisticAnnotations]
        : [...annotations, ...optimisticAnnotations, localComposerAnnotation],
    [annotations, localComposerAnnotation, optimisticAnnotations],
  );
  const displayedAnnotations = useMemo(() => {
    const projectionThreadIds = new Set<string>();
    const projectionCommentIds = new Set<string>();
    for (const annotation of annotations) {
      const thread = annotation.conversationThread;
      if (thread === undefined) continue;
      if (thread.target._tag === "thread")
        projectionThreadIds.add(thread.target.id);
      for (const comment of thread.comments)
        projectionCommentIds.add(comment.id);
    }
    const displayed: Array<ReviewInlineAnnotation> = [];
    for (const annotation of renderedAnnotations) {
      const thread = annotation.conversationThread;
      if (thread === undefined) {
        displayed.push(annotation);
        continue;
      }
      if (annotations.some((projection) => projection === annotation)) {
        displayed.push(annotation);
        continue;
      }
      const projectionTargetThreadId =
        thread.target._tag === "thread" ? thread.target.id : undefined;
      if (
        projectionTargetThreadId !== undefined &&
        projectionThreadIds.has(projectionTargetThreadId)
      )
        continue;
      if (projectionCommentIds.has(thread.comments[0]?.id ?? "")) continue;
      const targetThreadId =
        thread.target._tag === "thread" ? thread.target.id : undefined;
      const state =
        targetThreadId === undefined
          ? thread.state
          : (resolvedThreads.get(targetThreadId) ?? thread.state);
      const comments = thread.comments.flatMap((comment) => {
        if (deletedCommentIds.has(comment.id)) return [];
        const body = editedBodies.get(comment.id);
        return [body === undefined ? comment : { ...comment, body }];
      });
      if (comments.length === 0) continue;
      displayed.push({
        ...annotation,
        conversationThread: { ...thread, state, comments },
      });
    }
    return displayed;
  }, [
    annotations,
    deletedCommentIds,
    editedBodies,
    renderedAnnotations,
    resolvedThreads,
  ]);

  const decorateConversationThread = useCallback(
    (thread: ConversationThreadCardData): ConversationThreadCardData => {
      const hasThreadTarget = thread.target._tag === "thread";
      const setState = hasThreadTarget
        ? (thread.onSetState ?? conversationActions?.setThreadState)
        : undefined;
      const reply = hasThreadTarget
        ? (thread.onReply ?? conversationActions?.replyToThread)
        : undefined;
      const edit = thread.onEditComment ?? conversationActions?.editComment;
      const remove =
        thread.onDeleteComment ?? conversationActions?.deleteComment;
      const onSetState: ConversationThreadCardData["onSetState"] =
        setState === undefined
          ? undefined
          : async (threadId, state) => {
              await setState(threadId, state);
              setResolvedThreads((current) => {
                const next = new Map(current);
                next.set(threadId, state);
                return next;
              });
            };
      const onEditComment: ConversationThreadCardData["onEditComment"] =
        edit === undefined
          ? undefined
          : async (commentId, body) => {
              await edit(commentId, body);
              setEditedBodies((current) => {
                const next = new Map(current);
                next.set(commentId, body);
                return next;
              });
            };
      const onDeleteComment: ConversationThreadCardData["onDeleteComment"] =
        remove === undefined
          ? undefined
          : async (commentId) => {
              await remove(commentId);
              setDeletedCommentIds((current) => {
                const next = new Set(current);
                next.add(commentId);
                return next;
              });
              setCreatedThreads((current) =>
                current.some(
                  (entry) =>
                    entry._tag === "published" && entry.commentId === commentId,
                )
                  ? current.filter(
                      (entry) =>
                        entry._tag !== "published" ||
                        entry.commentId !== commentId,
                    )
                  : current,
              );
            };
      // Each override only replaces the incoming field when it is wired;
      // `definedProps` drops the undefined ones so `...thread`'s own value
      // survives, exactly as the conditional assignments did.
      return {
        ...thread,
        ...definedProps({
          onSetState,
          onReply: reply,
          onEditComment,
          onDeleteComment,
        }),
      };
    },
    [conversationActions],
  );

  const beginAuthoring = useCallback(
    (selection: CodeViewLineSelection | null): void => {
      if (localCommentAuthoring?.enabled !== true || selection === null) return;
      const range = selection.range;
      if (
        (range.side !== "additions" && range.side !== "deletions") ||
        (range.endSide !== undefined && range.endSide !== range.side)
      )
        return;
      const location: LocalCommentLocation = {
        path: selection.id,
        startLine: range.start,
        line: range.end,
        side: range.side === "additions" ? "new" : "old",
      };
      if (localCommentAuthoring.canAuthor?.(location) === false) return;
      localCommentAuthoring.onSelectionChange?.(location);
      setAuthoringSelection(selection);
    },
    [localCommentAuthoring],
  );

  return {
    displayedAnnotations,
    localComposerAnnotation,
    beginAccessibleAuthoring,
    beginAuthoring,
    decorateConversationThread,
  };
}
