import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { Spinner } from "@/components/ui/spinner";

import { diffLineRangeLabel } from "../review-diff-line-range";

export type AgentExplanationCardProps = {
  readonly explanationId: string;
  readonly path: string;
  readonly startLine: number;
  readonly line: number;
  readonly text: string;
  /** A move found its lines changed since the agent explained them. */
  readonly outdated: boolean;
  /** Opens the note composer on these lines; absent where no note can be written. */
  readonly onReply?: () => void;
  /** Absent once the Review is merged or closed; rejects with the message to show. */
  readonly onDismiss?: () => Promise<void>;
};

/**
 * The coding agent's explanation inline at its diff lines (#665). It is
 * styled apart from the maintainer's notes, and its text is the agent's, so
 * it is shown as plain text.
 */
export function AgentExplanationCard({
  explanationId,
  path,
  startLine,
  line,
  text,
  outdated,
  onReply,
  onDismiss,
}: AgentExplanationCardProps): React.JSX.Element {
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const location =
    startLine === line
      ? `${path}:${String(line)}`
      : `${path}:${String(startLine)}-${String(line)}`;
  const dismiss = async (): Promise<void> => {
    if (onDismiss === undefined || dismissing) return;
    setDismissing(true);
    setError(undefined);
    try {
      await onDismiss();
    } catch (cause: unknown) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The explanation was not dismissed.",
      );
    } finally {
      setDismissing(false);
    }
  };

  return (
    <article
      className="mx-2 my-2 box-border w-[calc(100%-1rem)] min-w-0 max-w-[min(42rem,calc(100%-1rem))] overflow-hidden rounded-md border border-dashed bg-muted/60 p-3 font-sans text-sm"
      data-review-agent-explanation={explanationId}
      aria-label={`Agent explanation on ${location}`}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="secondary">Agent</Badge>
        {outdated ? <Badge variant="warning">Outdated</Badge> : null}
        <span>{diffLineRangeLabel(startLine, line)}</span>
        <span>From the coding agent</span>
        {onReply === undefined && onDismiss === undefined ? null : (
          <div className="ml-auto flex gap-1">
            {onReply === undefined ? null : (
              <Button
                size="xs"
                variant="ghost"
                disabled={dismissing}
                onClick={onReply}
              >
                Reply
              </Button>
            )}
            {onDismiss === undefined ? null : (
              <Button
                size="xs"
                variant="ghost"
                disabled={dismissing}
                onClick={() => void dismiss()}
              >
                {dismissing ? <Spinner data-icon="inline-start" /> : null}
                Dismiss
              </Button>
            )}
          </div>
        )}
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-foreground">
        {text}
      </p>
      {error === undefined ? null : (
        <InlineError className="mt-2">{error}</InlineError>
      )}
    </article>
  );
}
