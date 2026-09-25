import { readFile } from "node:fs/promises";

import type { InsightStore } from "../adapters/storage/insight-store";
import { resolveSuggestionTarget } from "../domain/finding-suggestion";
import { parseRepoRelativePath } from "../domain/ids";
import { sameInsightRevision } from "../domain/insight-record";
import type { LocalApplyFile } from "../domain/local-apply-operation";
import {
  composeLocalApplyFileChange,
  type LocalApplyEdit,
} from "../domain/local-apply-patch";
import { err, ok, type Result } from "../domain/result";
import { parseReviewResult } from "../domain/review-result";
import {
  hashFileBytes,
  readCheckoutFile,
  resolveCheckoutRoot,
} from "./local-apply-checkout";
import type {
  LocalApplyFailure,
  LocalApplyRequest,
} from "./local-apply-service";
import type { GitReadExecutor } from "./review-worktree-service";

/** The checkout root, each file's hashes, and the one patch `git apply` receives. */
export type ComposedApply = {
  readonly root: string;
  readonly files: ReadonlyArray<LocalApplyFile>;
  readonly patch: string;
};

/** Every requested Finding's verified replacement and its range in the represented patch. */
export async function loadVerifiedEdits(
  insights: Pick<InsightStore, "loadTyped">,
  request: LocalApplyRequest,
  patchPath: string,
): Promise<
  Result<ReadonlyMap<string, ReadonlyArray<LocalApplyEdit>>, LocalApplyFailure>
> {
  if (
    request.findingIds.length === 0 ||
    new Set(request.findingIds).size !== request.findingIds.length
  )
    return err({ reason: "not_applicable" });
  const record = await insights.loadTyped(
    request.profileId,
    request.reviewId,
    "analysis",
    parseReviewResult,
  );
  if (record._tag === "err") return err({ reason: "not_applicable" });
  const retained = record.value.retained;
  if (
    retained === undefined ||
    retained.runId !== request.runId ||
    !sameInsightRevision(retained.revision, {
      sessionId: request.expected.sessionId,
      headSha: request.expected.headSha,
      patchHash: request.expected.patchHash,
    })
  )
    return err({ reason: "not_applicable" });
  const patch = await readFile(patchPath, "utf8").catch(() => undefined);
  if (patch === undefined) return err({ reason: "storage" });
  const findings = new Map(
    retained.value.findings.map((finding) => [finding.id, finding]),
  );
  const byPath = new Map<string, LocalApplyEdit[]>();
  for (const findingId of request.findingIds) {
    const finding = findings.get(findingId);
    const code = finding?.suggestedReplacement?.code;
    if (
      finding === undefined ||
      code === undefined ||
      finding.disposition === "dismissed"
    )
      return err({ reason: "not_applicable" });
    const target = resolveSuggestionTarget(patch, finding);
    if (target === undefined) return err({ reason: "not_applicable" });
    const edits = byPath.get(target.path) ?? [];
    const overlaps = edits.some(
      (edit) => edit.startLine <= target.line && target.startLine <= edit.line,
    );
    if (overlaps) return err({ reason: "overlapping" });
    edits.push({
      startLine: target.startLine,
      line: target.line,
      originalLines: target.originalLines,
      code,
    });
    byPath.set(target.path, edits);
  }
  return ok(byPath);
}

/** Reads each file's current bytes and computes its expected post-image in memory. */
export async function composeLocalApply(
  git: GitReadExecutor,
  localPath: string,
  edits: ReadonlyMap<string, ReadonlyArray<LocalApplyEdit>>,
): Promise<Result<ComposedApply, LocalApplyFailure>> {
  const root = await resolveCheckoutRoot(git, localPath);
  if (root === undefined) return err({ reason: "checkout_unavailable" });
  const files: LocalApplyFile[] = [];
  const patches: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const [rawPath, fileEdits] of edits) {
    const path = parseRepoRelativePath(rawPath);
    if (path._tag === "err") return err({ reason: "path_refused" });
    const bytes = await readCheckoutFile(root, path.value);
    if (bytes === undefined) return err({ reason: "path_refused" });
    let content: string;
    try {
      content = decoder.decode(bytes);
    } catch {
      return err({ reason: "file_changed" });
    }
    const change = composeLocalApplyFileChange(path.value, content, fileEdits);
    if (change._tag === "err")
      return err({
        reason: change.error === "overlapping" ? "overlapping" : "file_changed",
      });
    const preImageSha256 = hashFileBytes(bytes);
    const postImageSha256 = hashFileBytes(
      Buffer.from(change.value.postImage, "utf8"),
    );
    if (preImageSha256 === undefined || postImageSha256 === undefined)
      return err({ reason: "storage" });
    files.push({ path: path.value, preImageSha256, postImageSha256 });
    patches.push(change.value.patch);
  }
  return ok({ root, files, patch: patches.join("") });
}
