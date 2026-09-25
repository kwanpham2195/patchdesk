import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import { containsSensitiveData } from "../adapters/storage/json-file";
import {
  MAX_CHANGE_INTENT_BYTES,
  type ChangeIntent,
  type ResolvedChangeIntent,
} from "../domain/change-intent";
import { parseContentHash } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import type { ReviewSession } from "../domain/review-session";
import { readCheckoutFile } from "./local-apply-checkout";
import { hashReviewArtifactContent } from "./review-artifact-hash";
import type { GitReadExecutor } from "./review-worktree-service";

/**
 * Why a spec file cannot be the Change intent of an Analysis run. The run is
 * refused with this reason rather than run against no stated goal.
 */
export type ChangeIntentUnreadable = {
  readonly _tag: "ChangeIntentUnreadable";
  readonly reason:
    | "file_missing"
    | "file_too_large"
    | "file_not_text"
    /** It holds a credential-shaped value, which Patchdesk never writes to disk. */
    | "file_sensitive";
};

/** Git or the session checkout failed, so nothing is known about the spec file. */
type ChangeIntentReadFailed = { readonly _tag: "ChangeIntentReadFailed" };

/**
 * The Markdown an Analysis run reads for a Change intent. A spec file is the
 * blob at the session's head commit (the Local snapshot of a working-tree
 * Review), never the maintainer's working tree, so an edit made after the
 * snapshot does not reach the run.
 */
export async function resolveChangeIntent(
  git: GitReadExecutor,
  session: ReviewSession,
  intent: ChangeIntent,
): Promise<
  Result<ResolvedChangeIntent, ChangeIntentUnreadable | ChangeIntentReadFailed>
> {
  if (intent.kind === "text") return resolved(intent, intent.markdown);
  const entry = await git.run([
    "git",
    "--no-replace-objects",
    "--literal-pathspecs",
    "-C",
    session.worktree.path,
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
  // The session worktree is the head commit checked out; the blob id proves these are its bytes unconverted.
  const root = await realpath(session.worktree.path).catch(() => undefined);
  const bytes =
    root === undefined ? undefined : await readCheckoutFile(root, intent.path);
  if (bytes === undefined || gitBlobId(bytes, objectName) !== objectName)
    return err({ _tag: "ChangeIntentReadFailed" });
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return unreadable("file_not_text");
  }
  if (markdown.includes("\0")) return unreadable("file_not_text");
  if (containsSensitiveData(markdown)) return unreadable("file_sensitive");
  return resolved(intent, markdown);
}

/** Git's object id for a blob of `bytes`, in the hash its repository uses: SHA-256 ids are 64 characters. */
function gitBlobId(bytes: Buffer, objectName: string | undefined): string {
  return createHash(objectName?.length === 64 ? "sha256" : "sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function resolved(
  intent: ChangeIntent,
  markdown: string,
): Result<ResolvedChangeIntent, ChangeIntentReadFailed> {
  const sha256 = parseContentHash(hashReviewArtifactContent(markdown));
  return sha256._tag === "ok"
    ? ok({ intent, markdown, sha256: sha256.value })
    : err({ _tag: "ChangeIntentReadFailed" });
}

function unreadable(
  reason: ChangeIntentUnreadable["reason"],
): Result<never, ChangeIntentUnreadable> {
  return err({ _tag: "ChangeIntentUnreadable", reason });
}
