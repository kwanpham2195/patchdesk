import type { LocalDraftReplyEntry } from "../local-draft-contracts";
import { cn } from "../lib/utils";
import { RelativeTime } from "./relative-time";
import { Badge } from "./ui/badge";

const replyStatusLabels = {
  addressed: "Addressed",
  skipped: "Skipped",
  question: "Question",
} as const satisfies Record<LocalDraftReplyEntry["status"], string>;

/**
 * The coding agent's latest reply to one Local draft (#600), under the draft in
 * the Notes list and on its inline note card (#688). Its text is untrusted, so
 * it renders as plain text, never Markdown.
 */
export function LocalDraftAgentReply({
  reply,
  className,
}: {
  readonly reply: LocalDraftReplyEntry;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Agent reply"
      className={cn(
        "flex min-w-0 flex-col gap-1 border-l-2 border-border py-1 pl-2 text-xs",
        className,
      )}
    >
      <span className="flex flex-wrap items-center gap-1 text-muted-foreground">
        <Badge variant="outline">{replyStatusLabels[reply.status]}</Badge>
        <RelativeTime iso={reply.repliedAt} prefix="Agent replied " />
      </span>
      <p className="line-clamp-4 w-full min-w-0 break-words whitespace-pre-wrap">
        {reply.text}
      </p>
    </div>
  );
}
