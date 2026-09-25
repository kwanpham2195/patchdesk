import {
  MAX_CHANGE_INTENT_BYTES,
  type ChangeIntent,
  type ChangeIntentProvenance,
  type ResolvedChangeIntent,
} from "../domain/change-intent";
import { parseContentHash } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import type { ReviewSession } from "../domain/review-session";
import { hashReviewArtifactContent } from "./review-artifact-hash";
import type { GitReadExecutor } from "./review-worktree-service";

/**
 * Why a spec file cannot be the Change intent of an Analysis run. The run is
 * refused with this reason rather than run against no stated goal.
 */
export type ChangeIntentUnreadable = {
  readonly _tag: "ChangeIntentUnreadable";
  readonly reason: "file_missing" | "file_too_large" | "file_not_text";
};

/** Git itself failed, so nothing is known about the spec file. */
type ChangeIntentReadFailed = { readonly _tag: "ChangeIntentReadFailed" };

/**
 * The Markdown an Analysis run reads for a Change intent. A spec file is read
 * from the session's head commit (the Local snapshot of a working-tree
 * Review), never from the maintainer's working tree, so an edit made after
 * the snapshot does not reach the run.
 */
export async function resolveChangeIntent(
  git: GitReadExecutor,
  session: ReviewSession,
  intent: ChangeIntent,
): Promise<
  Result<ResolvedChangeIntent, ChangeIntentUnreadable | ChangeIntentReadFailed>
> {
  if (intent.kind === "text") return ok({ intent, markdown: intent.markdown });
  const repository = [
    "git",
    "--no-replace-objects",
    "--literal-pathspecs",
    "-C",
    session.worktree.path,
  ];
  const entry = await git.run([
    ...repository,
    "ls-tree",
    "--format=%(objectmode) %(objectsize) %(objectname)",
    "--end-of-options",
    session.key.headSha,
    "--",
    intent.path,
  ]);
  if (entry._tag === "err") return err({ _tag: "ChangeIntentReadFailed" });
  const [mode, size, objectName] = entry.value.stdout.trim().split(" ");
  // Absent, a directory, a symlink, or a submodule: no regular file to read.
  if (mode !== "100644" && mode !== "100755") return unreadable("file_missing");
  if (Number(size) > MAX_CHANGE_INTENT_BYTES)
    return unreadable("file_too_large");
  const blob = await git.run([
    ...repository,
    "cat-file",
    "blob",
    objectName ?? "",
  ]);
  if (blob._tag === "err") return err({ _tag: "ChangeIntentReadFailed" });
  const markdown = blob.value.stdout;
  // Bytes that are not UTF-8 decode to replacement characters and change the length.
  if (
    markdown.includes("\0") ||
    Buffer.byteLength(markdown, "utf8") !== Number(size)
  )
    return unreadable("file_not_text");
  return ok({ intent, markdown });
}

function unreadable(
  reason: ChangeIntentUnreadable["reason"],
): Result<never, ChangeIntentUnreadable> {
  return err({ _tag: "ChangeIntentUnreadable", reason });
}

/** What an Analysis run records about the Change intent it reads. */
export function changeIntentProvenance(
  resolved: ResolvedChangeIntent,
): ChangeIntentProvenance | undefined {
  const sha256 = parseContentHash(hashReviewArtifactContent(resolved.markdown));
  if (sha256._tag === "err") return undefined;
  return resolved.intent.kind === "text"
    ? { kind: "text", sha256: sha256.value }
    : { kind: "file", path: resolved.intent.path, sha256: sha256.value };
}
