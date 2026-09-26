import type { LocalDraft } from "../domain/local-draft";
import { compareLocalDraftsByFileThenLine } from "../domain/local-draft-agent-prompt";
import { err, ok, type Result } from "../domain/result";
import { hashReviewArtifactContent } from "./review-artifact-hash";

/** ADR 0052 "Feedback size": a page of 25 notes with suggestions stays under Claude Code's 25,000-token cut. */
export const LOCAL_FEEDBACK_PAGE_SIZE = 25;

export type LocalFeedbackPageFailure = {
  /** `stale_cursor`: the drafts changed since the cursor was issued; `invalid_input`: it is not a cursor Patchdesk issued. */
  readonly reason: "stale_cursor" | "invalid_input";
};

/**
 * One page of Local drafts in file then line order. The cursor names the
 * next offset and a digest of the whole ordered list, so a note added,
 * edited, or carried between two pages refuses the cursor instead of
 * silently shifting entries past the agent.
 */
export function pageLocalDrafts(
  drafts: ReadonlyArray<LocalDraft>,
  cursor: string | undefined,
): Result<
  {
    readonly drafts: ReadonlyArray<LocalDraft>;
    readonly nextCursor?: string;
  },
  LocalFeedbackPageFailure
> {
  const ordered = [...drafts].sort(compareLocalDraftsByFileThenLine);
  const digest = hashReviewArtifactContent(JSON.stringify(ordered)).slice(
    0,
    16,
  );
  let offset = 0;
  if (cursor !== undefined) {
    const match = /^(\d{1,6})\.([0-9a-f]{16})$/.exec(cursor);
    if (match === null) return err({ reason: "invalid_input" });
    if (match[2] !== digest) return err({ reason: "stale_cursor" });
    offset = Number(match[1]);
  }
  const end = offset + LOCAL_FEEDBACK_PAGE_SIZE;
  const page = ordered.slice(offset, end);
  return ok(
    end < ordered.length
      ? { drafts: page, nextCursor: `${String(end)}.${digest}` }
      : { drafts: page },
  );
}
