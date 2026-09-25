import { useId, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { InlineError } from "@/components/ui/inline-error";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

import type { LocalDraftEntry } from "../local-draft-contracts";
import { LocalDraftStateBadge } from "./local-draft-state-badge";

export type LocalNoteCardProps = {
  readonly noteId: string;
  readonly path: string;
  readonly startLine: number;
  readonly line: number;
  readonly text: string;
  readonly state?: LocalDraftEntry["state"];
  /** Absent once the Review is merged or closed; rejects with the message to show. */
  readonly onEdit?: (text: string) => Promise<void>;
  readonly onRemove?: () => Promise<void>;
};

/** A maintainer note inline at its diff lines (ADR 0051), edited and removed in place. */
export function LocalNoteCard({
  noteId,
  path,
  startLine,
  line,
  text,
  state,
  onEdit,
  onRemove,
}: LocalNoteCardProps): React.JSX.Element {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<"saving" | "removing" | undefined>();
  const [error, setError] = useState<string | undefined>();
  const errorId = `local-note-${useId()}-error`;
  const location =
    startLine === line
      ? `${path}:${String(line)}`
      : `${path}:${String(startLine)}-${String(line)}`;

  const run = async (
    action: "saving" | "removing",
    command: () => Promise<void>,
  ): Promise<boolean> => {
    if (busy !== undefined) return false;
    setBusy(action);
    setError(undefined);
    try {
      await command();
      return true;
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : "The note was not saved.",
      );
      return false;
    } finally {
      setBusy(undefined);
    }
  };
  const save = async (): Promise<void> => {
    if (draft === undefined || onEdit === undefined) return;
    if (draft === text) {
      setDraft(undefined);
      return;
    }
    if (await run("saving", () => onEdit(draft))) setDraft(undefined);
  };
  const cancel = (): void => {
    setDraft(undefined);
    setError(undefined);
  };

  return (
    <article
      className="mx-2 my-2 box-border w-[calc(100%-1rem)] min-w-0 max-w-[min(42rem,calc(100%-1rem))] overflow-hidden rounded-md border bg-card p-3 font-sans text-sm shadow-sm"
      data-review-local-note={noteId}
      aria-label={`Note on ${location}`}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">Note</Badge>
        <LocalDraftStateBadge state={state} />
        <span>For the coding agent</span>
        {draft !== undefined || onEdit === undefined ? null : (
          <div className="ml-auto flex gap-1">
            <Button
              size="xs"
              variant="ghost"
              disabled={busy !== undefined}
              onClick={() => setDraft(text)}
            >
              Edit note
            </Button>
            {onRemove === undefined ? null : (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy !== undefined}
                onClick={() => void run("removing", onRemove)}
              >
                {busy === "removing" ? (
                  <Spinner data-icon="inline-start" />
                ) : null}
                Remove note
              </Button>
            )}
          </div>
        )}
      </div>
      {draft === undefined ? (
        <>
          <p className="mt-2 whitespace-pre-wrap break-words text-foreground">
            {text}
          </p>
          {error === undefined ? null : (
            <InlineError className="mt-2">{error}</InlineError>
          )}
        </>
      ) : (
        <>
          <Field
            className="mt-2"
            data-invalid={error !== undefined || undefined}
            data-disabled={busy !== undefined || undefined}
          >
            <Textarea
              autoFocus
              aria-label="Note"
              aria-invalid={error !== undefined || undefined}
              aria-describedby={error === undefined ? undefined : errorId}
              value={draft}
              disabled={busy !== undefined}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancel();
                }
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void save();
                }
              }}
            />
            <FieldError id={errorId}>{error}</FieldError>
          </Field>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              disabled={draft.trim().length === 0 || busy !== undefined}
              onClick={() => void save()}
            >
              {busy === "saving" ? (
                <>
                  <Spinner data-icon="inline-start" /> Saving…
                </>
              ) : (
                "Save note"
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== undefined}
              onClick={cancel}
            >
              Cancel
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Press ⌘/Ctrl+Enter to save. Escape cancels.
          </p>
        </>
      )}
    </article>
  );
}
