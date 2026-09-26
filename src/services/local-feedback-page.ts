import { isMaintainerNote, type LocalDraft } from "../domain/local-draft";
import { compareLocalDraftsByFileThenLine } from "../domain/local-draft-agent-prompt";
import { err, ok, type Result } from "../domain/result";
import { hashReviewArtifactContent } from "./review-artifact-hash";

/** ADR 0052 "Feedback size": at most 25 entries a page, however short. */
const LOCAL_FEEDBACK_PAGE_SIZE = 25;

/** Claude Code cuts a tool result at 25,000 tokens by default; 60 KiB of JSON stays under it unless the text averages below 2.5 bytes a token, and prose and code average about 4. */
const LOCAL_FEEDBACK_PAGE_BYTES = 60 * 1024;

export type LocalFeedbackPageFailure = {
  /** `stale_cursor`: the drafts changed since the cursor was issued; `invalid_input`: it is not a cursor Patchdesk issued. */
  readonly reason: "stale_cursor" | "invalid_input";
};

/**
 * Renders one page: `listed` become the structured entries and `prompted` the
 * Markdown prompt. They differ only for a lone draft too large to repeat.
 */
type LocalFeedbackPageRender<Page> = (
  listed: ReadonlyArray<LocalDraft>,
  prompted: ReadonlyArray<LocalDraft>,
) => Page;

/**
 * One page of Local drafts in file then line order, at most 25 and at most
 * 60 KiB serialized. The cursor names the next offset and a digest of the
 * whole ordered list, so a note added, edited, or carried between two pages
 * refuses the cursor instead of silently shifting entries past the agent.
 */
export function pageLocalDrafts<Page>(
  drafts: ReadonlyArray<LocalDraft>,
  cursor: string | undefined,
  render: LocalFeedbackPageRender<Page>,
): Result<
  { readonly page: Page; readonly nextCursor?: string },
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
  const candidates = ordered.slice(offset, offset + LOCAL_FEEDBACK_PAGE_SIZE);
  // The first draft always goes out, even over the bound, so every page moves the cursor forward.
  let count = Math.min(1, candidates.length);
  let page = render(candidates.slice(0, count), candidates.slice(0, count));
  while (count < candidates.length) {
    const listed = candidates.slice(0, count + 1);
    const next = render(listed, listed);
    if (serializedBytes(next) > LOCAL_FEEDBACK_PAGE_BYTES) break;
    page = next;
    count += 1;
  }
  const [first] = candidates;
  if (
    count === 1 &&
    first !== undefined &&
    serializedBytes(page) > LOCAL_FEEDBACK_PAGE_BYTES
  )
    page = render([first], [withTextInEntryOnly(first)]);
  const end = offset + count;
  return ok(
    end < ordered.length
      ? { page, nextCursor: `${String(end)}.${digest}` }
      : { page },
  );
}

function serializedBytes<Page>(page: Page): number {
  return Buffer.byteLength(JSON.stringify(page));
}

/** The prompt copy of a draft too large to send twice: its structured entry still carries the full text. */
function withTextInEntryOnly(draft: LocalDraft): LocalDraft {
  if (isMaintainerNote(draft))
    return {
      ...draft,
      text: "This note is too long to repeat here; its full text is the `text` of the entry in `localDrafts`.",
    };
  const { suggestion: _suggestion, ...rest } = draft;
  return {
    ...rest,
    comment:
      "This comment is too long to repeat here; its full text and any suggestion are the `comment` and `suggestion` of the entry in `localDrafts`.",
  };
}
