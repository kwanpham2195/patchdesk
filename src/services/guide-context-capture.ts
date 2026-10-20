import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";

import { definedProps } from "#src/domain/defined-props";
import { err, ok, type Result } from "#src/domain/result";
import type { ReviewSession } from "#src/domain/review-session";
import type { ReviewContextPackService } from "./review-context-pack-service";

/** A private, hash-bound context input in the run's destination scope; only its locator leaves the host. */
export type StagedGuideContext = {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Removes the staged file once the job has read it or the run stopped. */
  discard(): Promise<void>;
};

/**
 * Acquires the permitted run context (comments, checks, rules, package summary) outside every Review lock and stages it
 * in a new private file. The shared session context is never rewritten, so a concurrent Insight keeps its own.
 */
export async function stageGuideContext(
  pack: Pick<ReviewContextPackService, "captureRunContext">,
  session: ReviewSession,
  destinationReview: string,
  runId: string,
  signal?: AbortSignal,
): Promise<
  Result<StagedGuideContext, "context_unavailable" | "aborted" | "io">
> {
  const captured = await pack.captureRunContext(
    session,
    definedProps({ signal }),
  );
  if (captured._tag === "err")
    return err(
      captured.error._tag === "ContextAborted"
        ? "aborted"
        : "context_unavailable",
    );
  if (signal?.aborted) return err("aborted");
  const { material, upstream } = captured.value;
  // The job parses this with `guideContextInputSchema` before using any field.
  const staged = {
    pr: material.pr,
    ...definedProps({ comments: material.comments, checks: material.checks }),
    criteria: [...material.criteria],
    packageSummary: material.packageSummary,
    omitted: material.omitted,
    upstreamCompleteness: upstream,
  };
  const bytes = Buffer.from(JSON.stringify(staged), "utf8");
  const path = join(destinationReview, `.guide-context-${runId}.json`);
  // Only a file this call created may be removed: a failed exclusive open means the path belongs to someone else.
  let created = false;
  try {
    const file = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
  } catch {
    if (created) await unlink(path).catch(() => undefined);
    return err("io");
  }
  return ok({
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    discard: () => unlink(path).catch(() => undefined),
  });
}
