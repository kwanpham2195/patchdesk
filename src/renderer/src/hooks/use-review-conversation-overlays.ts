import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { UnsentReviewTextContext } from "./use-unsent-review-text";
import {
  useReviewConversationOwner,
  useReviewConversationOverlaySnapshot,
  type CreatedThreadOverlay,
  inlineDraftKey,
} from "./use-review-conversation-owner";
import type { RefObject } from "react";
import type { SelectedLineRange } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";

import {
  isOutcomeUnknownRetry,
  refusedWriteMessage,
} from "#src/renderer/src/api-client";
import { definedProps } from "#src/domain/defined-props";
import { fingerprintPatchAnchor } from "#src/domain/diff-anchor";
import { parseGitHubThreadId, parseRepoRelativePath } from "#src/domain/ids";
import { composerErrorMessage } from "#src/renderer/src/components/review-diff-authoring-errors";
import type { DraftRecovery } from "#src/renderer/src/components/draft-recovery";
import { useLatestCommitted } from "./use-latest-committed";
import {
  diffLineRangeLabel,
  diffLineRangeLocation,
} from "#src/renderer/src/review-diff-line-range";
import type {
  PendingReviewDrafts,
  PendingReviewWrite,
} from "./use-pending-review-drafts";
import type {
  ConversationThreadCardData,
  ReviewConversationActions,
} from "#src/renderer/src/components/conversation-thread-card";
import type {
  LocalCommentAuthoring,
  LocalCommentAuthoringSaveInput,
  LocalCommentLocation,
  PendingReviewComposerActions,
  ReviewInlineAnnotation,
} from "#src/renderer/src/components/review-diff-view";

export type ReviewConversationOverlays = {
  readonly displayedAnnotations: ReadonlyArray<ReviewInlineAnnotation>;
  readonly localComposerAnnotation: ReviewInlineAnnotation | undefined;
  /** A kept draft that waits for a new diff line: Edit draft on lines that are gone, or a failed draft whose lines Refresh removed (#526). */
  readonly draftRecovery: DraftRecovery | undefined;
  readonly beginAccessibleAuthoring: (
    path: string,
    line: number,
    side: "additions" | "deletions",
  ) => void;
  /** Opens the composer for a gutter click or drag; stable, so Pierre's options never change with it. */
  readonly beginRangeAuthoring: (
    path: string,
    range: SelectedLineRange,
  ) => void;
  /** Why the last gutter drag opened no composer, until dismissed or a composer opens. */
  readonly authoringRefusal: DiffAuthoringRefusal | undefined;
  readonly decorateConversationThread: (
    thread: ConversationThreadCardData,
  ) => ConversationThreadCardData;
};

export type DiffAuthoringRefusal = {
  readonly message: string;
  readonly onDismiss: () => void;
};

const NO_WRITES: ReadonlyArray<PendingReviewWrite> = [];

export function useReviewConversationOverlays({
  patch,
  annotations,
  viewer,
  localCommentAuthoring,
  pendingReviewComposer,
  pendingReviewDrafts,
  conversationActions,
}: {
  readonly patch: string;
  readonly annotations: ReadonlyArray<ReviewInlineAnnotation>;
  readonly viewer: RefObject<CodeViewHandle<
    ReviewInlineAnnotation | undefined
  > | null>;
  readonly localCommentAuthoring: LocalCommentAuthoring | undefined;
  readonly pendingReviewComposer: PendingReviewComposerActions | undefined;
  /** Where pending-review writes are kept; without it the composer offers no pending-review action. */
  readonly pendingReviewDrafts: PendingReviewDrafts | undefined;
  readonly conversationActions: ReviewConversationActions | undefined;
}): ReviewConversationOverlays {
  const [authoringSelection, setAuthoringSelection] =
    useState<LocalCommentLocation | null>(null);
  // Kept with the patch it names lines of, so a view switch or Refresh drops it.
  const [refusal, setRefusal] = useState<
    { readonly message: string; readonly patch: string } | undefined
  >();
  const [authoringInitialBody, setAuthoringInitialBody] = useState<
    string | undefined
  >();
  // Standalone previews own an appearance; workbench diffs receive a session owner.
  const reportUnsent = useContext(UnsentReviewTextContext);
  const localOwner = useReviewConversationOwner(
    "appearance",
    "appearance",
    annotations,
    { reportUnsent },
  );
  const owner = pendingReviewDrafts?.conversationOwner ?? localOwner;
  const {
    createdThreads,
    editedBodies,
    deletedCommentIds,
    resolvedThreads,
    replyReceipts,
  } = useReviewConversationOverlaySnapshot(owner);
  const {
    setCreatedThreads,
    setEditedBodies,
    setDeletedCommentIds,
    setResolvedThreads,
  } = owner;
  const pendingWriteOverlays = pendingReviewDrafts?.writes ?? NO_WRITES;
  const setPendingWriteOverlays = pendingReviewDrafts?.updateWrites;
  const orphanedDraftBody = pendingReviewDrafts?.orphanedBody;
  const setOrphanedDraftBody = pendingReviewDrafts?.setOrphanedBody;
  const currentOwner = useLatestCommitted(owner);
  const [authoringOwner, setAuthoringOwner] = useState(owner);

  const draftKey =
    authoringSelection === null
      ? undefined
      : inlineDraftKey(patch, authoringSelection, localCommentAuthoring?.kind);
  const writeDraftBody = useCallback(
    (key: string, body: string | undefined): void =>
      owner.update((current) => {
        const next = new Map(current.draftBodies);
        if (body === undefined) next.delete(key);
        else next.set(key, body);
        return { ...current, draftBodies: next };
      }),
    [owner],
  );

  // A failed draft whose lines Refresh removed from the full diff waits for a new line. A narrowed view (Scope bucket,
  // commit slice, since-review) only hides a card whose lines it does not show; it never strands the draft.
  const fullPatch = pendingReviewDrafts?.fullPatch ?? patch;
  const { strandedWrite, shownPendingWrites } = useMemo(() => {
    const stranded: Array<PendingReviewWrite> = [];
    const shown: Array<PendingReviewWrite> = [];
    for (const overlay of pendingWriteOverlays) {
      const reviewedText = anchoredText(fullPatch, overlay);
      if (reviewedText === undefined) {
        if (overlay._tag === "failed") stranded.push(overlay);
      } else if (anchoredText(patch, overlay) === reviewedText) {
        shown.push(overlay);
      }
    }
    return { strandedWrite: stranded[0], shownPendingWrites: shown };
  }, [fullPatch, patch, pendingWriteOverlays]);
  const recoverableDraftBody = orphanedDraftBody ?? strandedWrite?.body;
  const releaseRecoverableDraft = useCallback((): void => {
    if (orphanedDraftBody !== undefined) {
      setOrphanedDraftBody?.(undefined);
      return;
    }
    if (strandedWrite === undefined) return;
    setPendingWriteOverlays?.((current) =>
      current.filter((overlay) => overlay.localId !== strandedWrite.localId),
    );
  }, [
    orphanedDraftBody,
    setOrphanedDraftBody,
    setPendingWriteOverlays,
    strandedWrite,
  ]);
  // An open note composer's text, kept as a recoverable draft when the diff unmounts under it, as a patch view switch does (#556 D5).
  const unsavedNote = useRef<{
    body: string | undefined;
    saving: boolean;
    unmounted: boolean;
  }>({ body: undefined, saving: false, unmounted: false });
  if (authoringOwner !== owner) {
    setAuthoringOwner(owner);
    setAuthoringSelection(null);
    setAuthoringInitialBody(undefined);
    unsavedNote.current.body = undefined;
  }
  const reportAuthoringBody = useCallback(
    (body: string): void => {
      unsavedNote.current.body = body;
      if (draftKey !== undefined && localCommentAuthoring?.kind !== "note")
        writeDraftBody(draftKey, body);
    },
    [draftKey, localCommentAuthoring?.kind, writeDraftBody],
  );
  const keepUnsavedNote = useLatestCommitted({
    note: localCommentAuthoring?.kind === "note",
    setOrphanedDraftBody,
  });
  useEffect(() => {
    const unsaved = unsavedNote.current;
    const latest = keepUnsavedNote;
    unsaved.unmounted = false;
    return () => {
      unsaved.unmounted = true;
      const { note, setOrphanedDraftBody: keep } = latest.current;
      if (note && !unsaved.saving && unsaved.body?.trim()) keep?.(unsaved.body);
    };
  }, [keepUnsavedNote]);

  const takeRecoverableDraft = useCallback(
    (location: LocalCommentLocation): void => {
      const key = inlineDraftKey(patch, location, localCommentAuthoring?.kind);
      const body =
        localCommentAuthoring?.kind === "note"
          ? recoverableDraftBody
          : (owner.getSnapshot().draftBodies.get(key) ?? recoverableDraftBody);
      unsavedNote.current.body = body;
      setAuthoringInitialBody(body);
      if (body !== undefined && localCommentAuthoring?.kind !== "note")
        writeDraftBody(key, body);
      releaseRecoverableDraft();
    },
    [
      owner,
      localCommentAuthoring?.kind,
      patch,
      recoverableDraftBody,
      releaseRecoverableDraft,
      writeDraftBody,
    ],
  );

  const clearAuthoring = useCallback((): void => {
    if (currentOwner.current !== owner) return;
    if (draftKey !== undefined) writeDraftBody(draftKey, undefined);
    unsavedNote.current.body = undefined;
    setAuthoringSelection(null);
    setAuthoringInitialBody(undefined);
    viewer.current?.clearSelectedLines();
  }, [currentOwner, draftKey, owner, viewer, writeDraftBody]);

  const openComposer = useCallback(
    (location: LocalCommentLocation): void => {
      if (localCommentAuthoring?.enabled !== true) return;
      const refused = localCommentAuthoring.refuseLocation?.(location);
      if (refused !== undefined) {
        setRefusal({ patch, message: refused });
        return;
      }
      setRefusal(undefined);
      if (
        localCommentAuthoring.kind === "note" &&
        isSameLocation(authoringSelection, location)
      )
        return;
      localCommentAuthoring.onSelectionChange?.(location);
      takeRecoverableDraft(location);
      setAuthoringSelection(location);
    },
    [authoringSelection, localCommentAuthoring, patch, takeRecoverableDraft],
  );

  // Reply on an Agent explanation opens the note composer on its lines (#665); stable, so the cards keep their identity.
  const latestOpenComposer = useLatestCommitted(openComposer);
  const replyInNote =
    localCommentAuthoring?.enabled === true &&
    localCommentAuthoring.kind === "note";

  const beginAccessibleAuthoring = useCallback(
    (path: string, line: number, side: "additions" | "deletions"): void =>
      openComposer({
        path,
        startLine: line,
        line,
        side: side === "additions" ? "new" : "old",
      }),
    [openComposer],
  );

  const saveAuthoring = useCallback(
    async (body: string): Promise<void> => {
      if (
        authoringSelection === null ||
        localCommentAuthoring?.enabled !== true
      )
        return;
      const { side } = authoringSelection;
      const parsedPath = parseRepoRelativePath(authoringSelection.path);
      const anchor =
        parsedPath._tag === "ok"
          ? { ...authoringSelection, path: parsedPath.value }
          : undefined;
      if (anchor === undefined) return;
      // A note is saved to the Review record, which then renders it; a refusal keeps the composer open with its text.
      if (localCommentAuthoring.kind === "note") {
        const unsaved = unsavedNote.current;
        unsaved.body = body;
        unsaved.saving = true;
        try {
          await localCommentAuthoring.onSave({ ...anchor, body });
        } catch (cause) {
          if (unsaved.unmounted && unsaved.body?.trim()) {
            const { note, setOrphanedDraftBody: keep } =
              keepUnsavedNote.current;
            if (note) keep?.(unsaved.body);
          }
          throw cause;
        } finally {
          unsaved.saving = false;
        }
        clearAuthoring();
        return;
      }
      const fingerprint = fingerprintPatchAnchor(patch, anchor);
      const localId = owner.nextLocalId("local");
      setCreatedThreads((current) => [
        ...current,
        {
          _tag: "sending",
          selectedText: fingerprint?.selectedLines.join("\n"),
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
          path: authoringSelection.path,
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
          selectedText: fingerprint?.selectedLines.join("\n"),
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
                  commentNodeId: receipt.commentNodeId,
                  threadId: parsedThreadId.value,
                }
              : {
                  ...publishedBase,
                  commentId: receipt.commentId,
                  commentNodeId: receipt.commentNodeId,
                }
            : {
                _tag: "failed" as const,
                selectedText: fingerprint?.selectedLines.join("\n"),
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
      } catch (cause) {
        const refused = refusedWriteMessage(cause, "comment");
        setCreatedThreads((current) =>
          current.map((entry) =>
            entry.localId === localId
              ? {
                  _tag: "failed" as const,
                  selectedText: entry.selectedText,
                  localId: entry.localId,
                  path: entry.path,
                  start: entry.start,
                  end: entry.end,
                  side: entry.side,
                  body: entry.body,
                  ...definedProps({ message: refused }),
                }
              : entry,
          ),
        );
      }
    },
    [
      authoringSelection,
      clearAuthoring,
      keepUnsavedNote,
      localCommentAuthoring,
      patch,
      owner,
      setCreatedThreads,
    ],
  );

  const submitPendingWrite = useCallback(
    async (
      action: "start" | "add",
      anchor: LocalCommentLocation,
      body: string,
      run: (anchor: LocalCommentLocation, body: string) => Promise<void>,
    ): Promise<void> => {
      const localId = owner.nextLocalId("pending-write");
      setPendingWriteOverlays?.((current) => [
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
        setPendingWriteOverlays?.((current) =>
          current.filter((entry) => entry.localId !== localId),
        );
      } catch (cause) {
        if (isOutcomeUnknownRetry(cause)) {
          setPendingWriteOverlays?.((current) =>
            current.filter((entry) => entry.localId !== localId),
          );
          return;
        }
        setPendingWriteOverlays?.((current) =>
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
    [clearAuthoring, owner, setPendingWriteOverlays],
  );

  const localComposerAnnotation = useMemo<
    ReviewInlineAnnotation | undefined
  >(() => {
    if (authoringSelection === null || localCommentAuthoring?.enabled !== true)
      return undefined;
    const wrappedPendingReview: PendingReviewComposerActions | undefined =
      pendingReviewComposer === undefined || pendingReviewDrafts === undefined
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
    const { path, startLine, line, side } = authoringSelection;
    return {
      id: `local-comment:${path}:${startLine}:${line}:${side}`,
      path,
      start: startLine,
      end: line,
      side,
      severity: "info",
      title: "Local comment",
      explanation: "",
      localComposer: {
        path,
        startLine,
        line,
        side,
        ...definedProps({ initialBody: authoringInitialBody }),
        ...definedProps({
          draftControl:
            localCommentAuthoring.kind === "note" || draftKey === undefined
              ? undefined
              : {
                  subscribe: owner.subscribe,
                  getBody: () =>
                    owner.getSnapshot().draftBodies.get(draftKey) ?? "",
                },
        }),
        onCancel: clearAuthoring,
        onSave: saveAuthoring,
        ...definedProps({
          pendingReview: wrappedPendingReview,
          kind: localCommentAuthoring.kind,
          onBodyChange: reportAuthoringBody,
        }),
      },
    };
  }, [
    authoringSelection,
    authoringInitialBody,
    owner,
    draftKey,
    clearAuthoring,
    localCommentAuthoring?.enabled,
    localCommentAuthoring?.kind,
    pendingReviewComposer,
    pendingReviewDrafts,
    reportAuthoringBody,
    saveAuthoring,
    submitPendingWrite,
  ]);

  const editPendingWrite = useCallback(
    (localId: string): void => {
      const candidate = pendingWriteOverlays.find(
        (overlay) => overlay.localId === localId,
      );
      if (candidate?._tag !== "failed") return;
      const location: LocalCommentLocation = {
        path: candidate.path,
        startLine: candidate.start,
        line: candidate.end,
        side: candidate.side,
      };
      setPendingWriteOverlays?.((current) =>
        current.filter((overlay) => overlay.localId !== localId),
      );
      if (
        localCommentAuthoring?.enabled === true &&
        localCommentAuthoring.refuseLocation?.(location) === undefined
      ) {
        localCommentAuthoring.onSelectionChange?.(location);
        unsavedNote.current.body = candidate.body;
        writeDraftBody(
          inlineDraftKey(patch, location, localCommentAuthoring.kind),
          candidate.body,
        );
        setAuthoringInitialBody(candidate.body);
        setOrphanedDraftBody?.(undefined);
        setAuthoringSelection(location);
        return;
      }
      setOrphanedDraftBody?.(candidate.body);
      setAuthoringSelection(null);
      setAuthoringInitialBody(undefined);
      viewer.current?.clearSelectedLines();
    },
    [
      localCommentAuthoring,
      patch,
      writeDraftBody,
      pendingWriteOverlays,
      setOrphanedDraftBody,
      setPendingWriteOverlays,
      viewer,
    ],
  );

  const optimisticAnnotations = useMemo<ReadonlyArray<ReviewInlineAnnotation>>(
    () => [
      ...createdThreads.flatMap<ReviewInlineAnnotation>(
        (entry: CreatedThreadOverlay) => {
          if (anchoredText(patch, entry) !== entry.selectedText) return [];
          if (entry._tag !== "published") {
            return [
              {
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
                  ...definedProps({
                    message:
                      entry._tag === "failed" ? entry.message : undefined,
                  }),
                  onDismiss: (localId: string) =>
                    setCreatedThreads((current) =>
                      current.filter(
                        (candidate) => candidate.localId !== localId,
                      ),
                    ),
                },
              },
            ];
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
                commentNodeId: entry.commentNodeId,
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
          return [
            {
              id: `conversation:${entry.commentId}`,
              path: entry.path,
              start: entry.start,
              end: entry.end,
              side: entry.side,
              severity: "conversation",
              title: "Conversation",
              explanation: "",
              conversationThread,
            },
          ];
        },
      ),
      ...shownPendingWrites.map((entry: PendingReviewWrite) => {
        const pendingReviewWrite: NonNullable<
          ReviewInlineAnnotation["pendingReviewWrite"]
        > = {
          localId: entry.localId,
          status: entry._tag,
          action: entry.action,
          body: entry.body,
          onDismiss: (localId: string) =>
            setPendingWriteOverlays?.((current) =>
              current.filter((candidate) => candidate.localId !== localId),
            ),
          onEdit: editPendingWrite,
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
    [
      conversationActions,
      createdThreads,
      patch,
      editPendingWrite,
      setPendingWriteOverlays,
      setCreatedThreads,
      shownPendingWrites,
    ],
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
    const projectionEntries = new Set<ReviewInlineAnnotation>(annotations);
    const displayed: Array<ReviewInlineAnnotation> = [];
    for (const annotation of renderedAnnotations) {
      const explanation = annotation.agentExplanation;
      if (explanation !== undefined && replyInNote) {
        const { path, start, end, side } = annotation;
        displayed.push({
          ...annotation,
          agentExplanation: {
            ...explanation,
            onReply: () =>
              latestOpenComposer.current({
                path,
                startLine: start,
                line: end,
                side,
              }),
          },
        });
        continue;
      }
      const thread = annotation.conversationThread;
      if (thread === undefined) {
        displayed.push(annotation);
        continue;
      }
      const targetThreadId =
        thread.target._tag === "thread" ? thread.target.id : undefined;
      // Only an overlay is dropped for matching the projection; a projection
      // entry matches its own ids and must always be displayed.
      if (!projectionEntries.has(annotation)) {
        if (
          targetThreadId !== undefined &&
          projectionThreadIds.has(targetThreadId)
        )
          continue;
        if (projectionCommentIds.has(thread.comments[0]?.id ?? "")) continue;
      }
      const state =
        targetThreadId === undefined
          ? thread.state
          : (resolvedThreads.get(targetThreadId) ?? thread.state);
      const replies =
        targetThreadId === undefined
          ? []
          : (replyReceipts.get(targetThreadId) ?? []);
      const comments = [
        ...thread.comments,
        ...replies.filter(
          (reply) =>
            !thread.comments.some((comment) => comment.id === reply.id),
        ),
      ].flatMap((comment) => {
        if (deletedCommentIds.has(comment.id)) return [];
        const body = editedBodies.get(comment.id);
        return [body === undefined ? comment : { ...comment, body }];
      });
      if (comments.length === 0) continue;
      // Keep the annotation's identity when no override touched it, so an
      // unaffected card is not re-rendered by an override on another card.
      if (
        state === thread.state &&
        comments.length === thread.comments.length &&
        comments.every((comment, index) => comment === thread.comments[index])
      ) {
        displayed.push(annotation);
        continue;
      }
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
    latestOpenComposer,
    renderedAnnotations,
    replyInNote,
    resolvedThreads,
    replyReceipts,
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
      const onReply: ConversationThreadCardData["onReply"] =
        reply === undefined
          ? undefined
          : async (threadId, body) => {
              const id = await reply(threadId, body);
              if (id !== undefined)
                owner.retainReply(threadId, {
                  id,
                  body,
                  author: "You",
                  viewerDidAuthor: true,
                  createdAt: owner.now(),
                });
              return id;
            };
      const edit = thread.onEditComment ?? conversationActions?.editComment;
      const remove =
        thread.onDeleteComment ?? conversationActions?.deleteComment;
      const onSetState: ConversationThreadCardData["onSetState"] =
        setState === undefined
          ? undefined
          : async (threadId, state): Promise<false | void> => {
              if ((await setState(threadId, state)) === false) return false;
              setResolvedThreads((current) => {
                const next = new Map(current);
                next.set(threadId, state);
                return next;
              });
            };
      const onEditComment: ConversationThreadCardData["onEditComment"] =
        edit === undefined
          ? undefined
          : async (commentId, body): Promise<false | void> => {
              const ids = commentIdAliases(
                owner.getSnapshot().createdThreads,
                commentId,
              );
              if ((await edit(commentId, body)) === false) return false;
              setEditedBodies((current) => {
                const next = new Map(current);
                for (const id of ids) next.set(id, body.trim());
                return next;
              });
            };
      const onDeleteComment: ConversationThreadCardData["onDeleteComment"] =
        remove === undefined
          ? undefined
          : async (commentId): Promise<false | void> => {
              const ids = commentIdAliases(
                owner.getSnapshot().createdThreads,
                commentId,
              );
              if ((await remove(commentId)) === false) return false;
              setDeletedCommentIds((current) => {
                const next = new Set(current);
                for (const id of ids) next.add(id);
                return next;
              });
              setCreatedThreads((current) => {
                const kept = current.filter(
                  (entry) =>
                    entry._tag !== "published" || !ids.has(entry.commentId),
                );
                return kept.length === current.length ? current : kept;
              });
            };
      return {
        ...thread,
        conversationOwner: owner,
        ...definedProps({
          onSetState,
          onReply,
          onEditComment,
          onDeleteComment,
        }),
      };
    },
    [
      conversationActions,
      owner,
      setCreatedThreads,
      setDeletedCommentIds,
      setEditedBodies,
      setResolvedThreads,
    ],
  );

  const beginRangeAuthoringNow = useCallback(
    (path: string, range: SelectedLineRange): void => {
      if (localCommentAuthoring?.enabled !== true) return;
      const result = diffLineRangeLocation(patch, path, range);
      if (result._tag === "ok") {
        openComposer(result.location);
        return;
      }
      const lines = diffLineRangeLabel(result.startLine, result.line);
      const target = localCommentAuthoring.kind === "note" ? "note" : "comment";
      setRefusal({
        patch,
        message:
          result.reason === "crosses_sides"
            ? `${lines} mix old and new lines. A ${target} covers lines on one side.`
            : `${lines} reach outside one hunk. A ${target} covers lines inside one hunk.`,
      });
    },
    [localCommentAuthoring, openComposer, patch],
  );
  const latestBeginRangeAuthoring = useLatestCommitted(beginRangeAuthoringNow);
  const beginRangeAuthoring = useCallback(
    (path: string, range: SelectedLineRange): void =>
      latestBeginRangeAuthoring.current(path, range),
    [latestBeginRangeAuthoring],
  );
  const dismissRefusal = useCallback((): void => setRefusal(undefined), []);

  return {
    displayedAnnotations,
    localComposerAnnotation,
    draftRecovery:
      recoverableDraftBody === undefined
        ? undefined
        : {
            message: "Select a new diff line to restore the saved draft.",
            onDismiss: releaseRecoverableDraft,
          },
    beginAccessibleAuthoring,
    beginRangeAuthoring,
    authoringRefusal:
      refusal?.patch === patch
        ? { message: refusal.message, onDismiss: dismissRefusal }
        : undefined,
    decorateConversationThread,
  };
}

/** Opening the same lines again keeps the open note's text. */
function isSameLocation(
  current: LocalCommentLocation | null,
  next: LocalCommentLocation,
): boolean {
  return (
    current !== null &&
    current.path === next.path &&
    current.startLine === next.startLine &&
    current.line === next.line &&
    current.side === next.side
  );
}

/** The text of a draft's lines in `patch`, or undefined when `patch` does not show them. */
function anchoredText(
  patch: string,
  write: Pick<PendingReviewWrite, "path" | "start" | "end" | "side">,
): string | undefined {
  const path = parseRepoRelativePath(write.path);
  if (path._tag !== "ok") return undefined;
  return fingerprintPatchAnchor(patch, {
    path: path.value,
    startLine: write.start,
    line: write.end,
    side: write.side,
  })?.selectedLines.join("\n");
}

/**
 * Every id this hook knows for one comment. A card may pass either GitHub id
 * space for a comment created in this session: the overlay card carries the
 * create receipt's REST id, while the projected card carries the node id.
 */
function commentIdAliases(
  overlays: ReadonlyArray<CreatedThreadOverlay>,
  commentId: string,
): ReadonlySet<string> {
  const match = overlays.find(
    (entry) =>
      entry._tag === "published" &&
      (entry.commentId === commentId || entry.commentNodeId === commentId),
  );
  return match === undefined || match._tag !== "published"
    ? new Set([commentId])
    : new Set([match.commentId, match.commentNodeId]);
}
