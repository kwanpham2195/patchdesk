import { withTrailingNewline } from "./finding-suggestion";
import { isMaintainerNote, type LocalDraft } from "./local-draft";

const TASK_INSTRUCTION =
  "Address each review comment below: read the cited lines, make the smallest correct change, and do not change unrelated code.";

/**
 * A local Review's Local drafts as one Markdown prompt for the coding agent
 * whose work is under review, in file then line order. Each comment names its
 * lines; a Finding draft carries its verified suggestion as a fenced block,
 * and verification already refused any suggestion holding a fence line (ADR
 * 0048). A maintainer note is its text alone. Follows the Analysis "Copy as
 * markdown prompt" layout.
 */
export function renderLocalDraftsAsAgentPrompt(
  drafts: ReadonlyArray<LocalDraft>,
): string {
  const comments =
    drafts.length === 0
      ? "No review comments."
      : [...drafts]
          .sort(byFileThenLine)
          .map((draft, index) => renderDraft(draft, index + 1))
          .join("\n\n");
  return [
    "# Address review comments",
    TASK_INSTRUCTION,
    `## Comments\n\n${comments}`,
  ].join("\n\n");
}

function byFileThenLine(left: LocalDraft, right: LocalDraft): number {
  if (left.anchor.path !== right.anchor.path)
    return left.anchor.path < right.anchor.path ? -1 : 1;
  return (
    left.anchor.startLine - right.anchor.startLine ||
    left.anchor.line - right.anchor.line
  );
}

function renderDraft(draft: LocalDraft, position: number): string {
  const { anchor } = draft;
  const lines =
    anchor.startLine === anchor.line
      ? `${anchor.path}:${String(anchor.line)}`
      : `${anchor.path}:${String(anchor.startLine)}-${String(anchor.line)}`;
  // Old-side lines number the file before the change, which the agent would otherwise open as it is now.
  const side = anchor.side === "old" ? " (line numbers before the change)" : "";
  const title = isMaintainerNote(draft)
    ? "Note from the maintainer"
    : draft.title.trim();
  const blocks = [
    `### ${String(position)}. ${title}`,
    `- File: \`${lines}\`${side}`,
    isMaintainerNote(draft) ? draft.text.trim() : draft.comment.trim(),
  ];
  if (!isMaintainerNote(draft) && draft.suggestion !== undefined)
    blocks.push(
      `Suggested replacement for ${lines}:\n\n\`\`\`\n${withTrailingNewline(draft.suggestion.code)}\`\`\``,
    );
  return blocks.join("\n\n");
}
