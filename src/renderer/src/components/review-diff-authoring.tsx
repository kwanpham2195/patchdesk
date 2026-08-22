import { useState } from "react";

import { PatchdeskApiError } from "../api-client";
import type {
  PendingReviewComposerActions,
  ReviewInlineAnnotation,
} from "./review-diff-view";
import { composerErrorMessage } from "./review-diff-authoring-errors";
import { PullRequestDescriptionPreview } from "./pull-request-description";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function PendingConversationCard({
  localId,
  status,
  body,
  onDismiss,
}: NonNullable<
  ReviewInlineAnnotation["pendingConversation"]
>): React.JSX.Element {
  return (
    <article
      className="mx-2 my-2 box-border w-[calc(100%-1rem)] min-w-0 max-w-[min(42rem,calc(100%-1rem))] overflow-hidden rounded-md border bg-card p-3 font-sans text-sm shadow-sm"
      data-review-pending-conversation={localId}
      aria-label={`${status === "sending" ? "Publishing" : "Comment failed"} conversation`}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {status === "sending" ? "Publishing…" : "Not published"}
        </span>
        {status === "sending" ? <span>Waiting for GitHub</span> : null}
      </div>
      <div className="mt-2">
        <p className="font-semibold">You</p>
        <PullRequestDescriptionPreview markdown={body} />
      </div>
      {status === "failed" ? (
        <div className="mt-2">
          <p role="alert" className="text-sm text-destructive">
            Patchdesk could not publish this comment. Refresh GitHub state
            before composing it again.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => onDismiss(localId)}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/**
 * Renderer-only card for a pending-review Start/Add write while the remote
 * command is in flight or confirmed failed. It has no GitHub identity, offers
 * no retry (a timeout may have created the thread), and never becomes an
 * editable Review draft: Refresh or Check GitHub again reconcile it.
 */
export function PendingReviewWriteCard({
  localId,
  status,
  action,
  body,
  message,
  onDismiss,
}: NonNullable<
  ReviewInlineAnnotation["pendingReviewWrite"]
>): React.JSX.Element {
  const label =
    action === "start" ? "Starting review…" : "Adding to pending review…";
  return (
    <article
      className="mx-2 my-2 box-border w-[calc(100%-1rem)] min-w-0 max-w-[min(42rem,calc(100%-1rem))] overflow-hidden rounded-md border bg-card p-3 font-sans text-sm shadow-sm"
      data-review-pending-write={localId}
      aria-label={`${status === "sending" ? label : "Pending review write failed"}`}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {status === "sending" ? label : "Pending review write failed"}
        </span>
        {status === "sending" ? <span>Waiting for GitHub</span> : null}
      </div>
      <div className="mt-2">
        <p className="font-semibold">You</p>
        <PullRequestDescriptionPreview markdown={body} />
      </div>
      {status === "failed" ? (
        <div className="mt-2">
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => onDismiss(localId)}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/**
 * Authoritative inline card for one comment of the viewer's pending review,
 * derived only from the confirmed pending projection. Explicitly not
 * published: no Reply/Resolve/Unresolve/edit/delete controls, and no
 * assumption that other reviewers can see it.
 */
export function PendingReviewThreadCard({
  threadId,
  body,
}: NonNullable<
  ReviewInlineAnnotation["pendingReviewThread"]
>): React.JSX.Element {
  return (
    <article
      className="mx-2 my-2 box-border w-[calc(100%-1rem)] min-w-0 max-w-[min(42rem,calc(100%-1rem))] overflow-hidden rounded-md border bg-card p-3 font-sans text-sm shadow-sm"
      data-review-pending-thread={threadId}
      aria-label="Pending review comment"
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="rounded-full border border-amber-300/30 bg-amber-400/10 px-2 py-0.5 font-medium text-amber-200">
          Pending review
        </span>
        <span className="text-muted-foreground">Not yet submitted</span>
      </div>
      <div className="mt-2">
        <p className="font-semibold">You</p>
        <PullRequestDescriptionPreview markdown={body} />
      </div>
    </article>
  );
}

export function LocalCommentThread({
  path,
  startLine,
  line,
  body,
}: {
  readonly path: string;
  readonly startLine: number;
  readonly line: number;
  readonly body: string;
}): React.JSX.Element {
  const mockActionTitle = "Conversation actions are a UI preview only";
  return (
    <article
      className="mx-2 my-2 box-border w-[calc(100%-1rem)] min-w-0 max-w-[min(42rem,calc(100%-1rem))] overflow-hidden rounded-md border bg-card p-3 font-sans text-sm shadow-sm"
      data-review-local-comment={`${path}:${startLine}:${line}`}
      aria-label={`Saved local comment on ${path}:${startLine}`}
    >
      <div className="flex min-w-0 gap-3">
        <MockCommentAvatar initials="Y" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-semibold">You</span>
            <span className="text-muted-foreground">Just now</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              Local draft
            </span>
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-foreground">
            {body}
          </p>

          <div className="mt-4 border-l-2 border-border/70 pl-4">
            <div className="flex min-w-0 gap-3">
              <MockCommentAvatar initials="R" tone="reply" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="font-semibold">Mock reviewer</span>
                  <span className="text-muted-foreground">Preview</span>
                </div>
                <p className="mt-2 break-words text-foreground">
                  Thanks — threaded replies are UI-only for now.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
            <button
              type="button"
              disabled
              title={mockActionTitle}
              data-review-mock-action="reply"
              className="font-medium text-sky-400 transition-colors disabled:cursor-default disabled:opacity-100"
            >
              Add reply…
            </button>
            <button
              type="button"
              disabled
              title={mockActionTitle}
              data-review-mock-action="resolve"
              className="font-medium text-sky-400 transition-colors disabled:cursor-default disabled:opacity-100"
            >
              Resolve
            </button>
            <button
              type="button"
              disabled
              title={mockActionTitle}
              data-review-mock-action="delete"
              className="font-medium text-destructive transition-colors disabled:cursor-default disabled:opacity-100"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

function MockCommentAvatar({
  initials,
  tone = "author",
}: {
  readonly initials: string;
  readonly tone?: "author" | "reply";
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex size-9 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${tone === "reply" ? "border-amber-300/30 bg-amber-400/20 text-amber-200" : "border-sky-300/30 bg-sky-400/20 text-sky-200"}`}
    >
      {initials}
    </span>
  );
}

export function InlineCommentComposer({
  path,
  startLine,
  line,
  side,
  onCancel,
  onSave,
  pendingReview,
}: {
  readonly path: string;
  readonly startLine: number;
  readonly line: number;
  readonly side: "new" | "old";
  readonly onCancel: () => void;
  readonly onSave: (body: string) => Promise<void>;
  readonly pendingReview?: PendingReviewComposerActions;
}): React.JSX.Element {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const pendingState = pendingReview?.state.state;
  const writeDisabled =
    pendingState === "unavailable" || pendingState === "recovery_required";
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (body.trim().length === 0 || saving || pendingReview?.busy === true)
      return;
    setSaving(true);
    setError(undefined);
    try {
      await action();
    } catch (cause: unknown) {
      if (cause instanceof PatchdeskApiError) {
        console.error("Inline review comment failed", {
          kind: cause.kind,
          status: cause.status,
          correlationId: cause.correlationId,
        });
      }
      setError(composerErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };
  const anchor = { path, startLine, line, side };
  const startOrAdd = (): Promise<void> => {
    if (pendingReview === undefined) return onSave(body);
    const state = pendingReview.state;
    if (state.state === "pending")
      return pendingReview.onAddReviewComment(state.nodeId, anchor, body);
    return pendingReview.onStartReview(anchor, body);
  };
  const cancel = (): void => {
    if (
      body.trim().length > 0 &&
      !window.confirm("Discard this unsent comment?")
    )
      return;
    onCancel();
  };
  const busy = saving || pendingReview?.busy === true;
  return (
    <section
      className="mx-2 my-2 box-border w-[calc(100%-1rem)] min-w-0 max-w-[min(42rem,calc(100%-1rem))] overflow-hidden rounded-md border bg-card p-3 shadow-sm"
      aria-label="Inline comment composer"
    >
      <p className="text-xs text-muted-foreground">
        {path}:{startLine}
        {line === startLine ? "" : `–${line}`} ·{" "}
        {pendingState === "pending"
          ? "joins your pending review on GitHub"
          : pendingState === "none"
            ? "publishes to GitHub"
            : "GitHub write is paused"}
      </p>
      <Textarea
        className="mt-2"
        autoFocus
        aria-label="Inline comment"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key === "Enter" &&
            !writeDisabled
          ) {
            event.preventDefault();
            void run(startOrAdd);
          }
        }}
        placeholder="Write an inline comment"
        disabled={writeDisabled}
      />
      <div className="mt-2 flex gap-2">
        {pendingReview === undefined ? (
          <Button
            size="sm"
            onClick={() => void run(() => onSave(body))}
            disabled={body.trim().length === 0 || busy}
          >
            Comment
          </Button>
        ) : writeDisabled ? (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            Pending review state is unavailable. Check GitHub again or refresh
            before commenting.
          </p>
        ) : pendingState === "pending" ? (
          <Button
            size="sm"
            onClick={() => void run(startOrAdd)}
            disabled={body.trim().length === 0 || busy}
          >
            Add review comment
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              onClick={() => void run(startOrAdd)}
              disabled={body.trim().length === 0 || busy}
            >
              Start a review
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void run(() => onSave(body))}
              disabled={body.trim().length === 0 || busy}
            >
              Comment now
            </Button>
          </>
        )}
        <Button size="sm" variant="outline" onClick={cancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      {error === undefined ? null : (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Press ⌘/Ctrl+Enter to comment. Escape cancels.
      </p>
    </section>
  );
}
