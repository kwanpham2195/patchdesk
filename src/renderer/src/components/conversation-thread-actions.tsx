import type { ConversationThreadCardData } from "./conversation-thread-card";
import type { ConversationThreadActionControls } from "#src/renderer/src/hooks/use-conversation-thread-actions";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { InlineError } from "@/components/ui/inline-error";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

/** Renders the card's reply and resolve controls without owning their lifetime. */
export function ConversationThreadActions({
  thread,
  controls,
}: {
  readonly thread: ConversationThreadCardData;
  readonly controls: ConversationThreadActionControls;
}): React.JSX.Element {
  const {
    pending,
    replying,
    busy: threadWriteBusy,
    error,
    replyError,
    replyEditorId,
    replyBody,
  } = controls;
  const replyErrorId = `${replyEditorId}-error`;
  return (
    <>
      {thread.target._tag === "comment_only" ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Reply and Resolve aren&apos;t available for this comment yet. Refresh
          to pick up its GitHub thread.
        </p>
      ) : null}
      {thread.onSetState === undefined ? null : (
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          disabled={threadWriteBusy}
          onClick={controls.setThreadState}
        >
          {pending ? (
            <>
              <Spinner data-icon="inline-start" />
              {thread.state === "resolved" ? "Unresolving…" : "Resolving…"}
            </>
          ) : thread.state === "resolved" ? (
            "Unresolve"
          ) : (
            "Resolve"
          )}
        </Button>
      )}
      {error === undefined ? null : (
        <InlineError className="mt-2" aria-label={error.ariaLabel}>
          {error.message}
        </InlineError>
      )}
      {thread.onReply === undefined ? null : (
        <div className="mt-4 border-t pt-3">
          <Field
            data-invalid={replyError !== undefined || undefined}
            data-disabled={threadWriteBusy || undefined}
          >
            <Textarea
              id={replyEditorId}
              aria-label="Reply"
              aria-invalid={replyError !== undefined || undefined}
              aria-describedby={
                replyError === undefined ? undefined : replyErrorId
              }
              value={replyBody}
              onChange={(event) => controls.setReplyBody(event.target.value)}
              placeholder="Write a reply…"
              disabled={threadWriteBusy}
            />
            <FieldError id={replyErrorId}>{replyError}</FieldError>
          </Field>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              onClick={controls.reply}
              disabled={replyBody.trim().length === 0 || threadWriteBusy}
            >
              {replying ? (
                <>
                  <Spinner data-icon="inline-start" /> Replying…
                </>
              ) : (
                "Reply"
              )}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
