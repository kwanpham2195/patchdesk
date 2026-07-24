import { writeAtomicJson } from "../adapters/storage/json-file";
import { readFile } from "node:fs/promises";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { parseAbsolutePath, parseReviewAttemptId, parseReviewSessionId, parseWorkspaceProfileId, type IsoTimestamp } from "../domain/ids";
import { mapFindingLocation, parseUnifiedPatch } from "../domain/patch";
import { completeAttempt, type ReviewSession } from "../domain/review-session";
import { parseModelReviewResult, parseReviewResult, type ModelReviewResult, type ReviewResult } from "../domain/review-result";
import { parsePriorFindingEvidence, projectFindingLifecycle, type FindingLifecycleEntry } from "../domain/finding-lifecycle";
import type { RepoRelativePath } from "../domain/ids";
import { parseRevisionComparison } from "../domain/review-comparison";
import { err, ok, type Result } from "../domain/result";
import { createReviewBatch } from "./review-workbench";
import { readObjectField } from "./read-object-field";

/** Persists only validated structured review output; it has no shell, model, or GitHub write capability. */
export class ReviewCompletionService {
  constructor(private readonly paths: PatchdeskPaths, private readonly now: () => IsoTimestamp) {}
  async complete(input: unknown): Promise<Result<unknown, { readonly reason: string }>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId")); const sessionId = parseReviewSessionId(readObjectField(input, "sessionId")); const attemptId = parseReviewAttemptId(readObjectField(input, "attemptId"));
    const modelResult = parseModelReviewResult(readObjectField(input, "result"));
    if (profileId._tag === "err" || sessionId._tag === "err" || attemptId._tag === "err" || modelResult._tag === "err") return err({ reason: "invalid_result" });
    const store = new ReviewSessionStore(this.paths); const [session, attempt] = await Promise.all([store.load(profileId.value, sessionId.value), store.loadAttempt(profileId.value, sessionId.value, attemptId.value)]);
    if (session._tag === "err" || attempt._tag === "err") return err({ reason: "not_found" });
    const patch = await readFile(session.value.patchPath, "utf8").catch(() => undefined);
    if (patch === undefined) return err({ reason: "storage_failed" });
    const files = parseUnifiedPatch(patch);
    const { priorFindingAssessments, ...currentModelResult } = modelResult.value;
    if (session.value.scope.kind === "full" && (priorFindingAssessments?.length ?? 0) > 0) return err({ reason: "invalid_result" });
    const result = parseReviewResult({
      ...currentModelResult,
      findings: modelResult.value.findings.map((finding) => {
        const location = mapFindingLocation(files, finding);
        return {
          ...finding,
          mappingStatus: location.mappingStatus,
          ...(location.path === undefined ? {} : { file: location.path }),
          ...(location.side === undefined ? {} : { diffSide: location.side }),
          ...(location.line === undefined ? {} : { lineStart: location.startLine ?? location.line }),
          ...(location.startLine === undefined ? {} : { lineEnd: location.line }),
        };
      }),
    });
    if (result._tag === "err") return err({ reason: "invalid_result" });
    const lifecycle = await this.projectLifecycle(session.value, priorFindingAssessments, result.value);
    if (lifecycle._tag === "err") return lifecycle;
    const resultPath = parseAbsolutePath(this.paths.attemptResultFile(profileId.value, sessionId.value, attemptId.value)); if (resultPath._tag === "err") return err({ reason: "storage_failed" });
    const completed = completeAttempt(session.value, attempt.value, result.value, this.now(), resultPath.value); if (completed._tag === "err") return err({ reason: "not_current" });
    const completedAt = this.now();
    const completedAttempt = { ...attempt.value, ...completed.value.attempt, completedAt };
    const alreadyReportedFindingIds = lifecycle.value === undefined
      ? undefined
      : new Set(lifecycle.value.flatMap((entry) => entry.draftPostability === "already_reported" && entry.currentFindingId !== undefined ? [entry.currentFindingId] : []));
    const batch = createReviewBatch({ session: completed.value.session, attempt: completedAttempt, result: result.value, createdAt: completedAt, ...(alreadyReportedFindingIds === undefined ? {} : { alreadyReportedFindingIds }) }); if (batch._tag === "err") return err({ reason: "not_current" });
    const next = { ...completed.value.session, batch: { state: batch.value.batch.state }, batchContent: batch.value.batch, updatedAt: this.now() };
    const savedResult = await writeAtomicJson(resultPath.value, result.value);
    if (savedResult._tag === "err") return err({ reason: savedResult.error.reason === "sensitive_value" ? "invalid_result" : "storage_failed" });
    const savedLifecycle = lifecycle.value === undefined || session.value.scope.kind !== "incremental"
      ? { _tag: "ok" as const, value: undefined }
      : await writeAtomicJson(session.value.scope.lifecyclePath, lifecycle.value);
    if (savedLifecycle._tag === "err") return err({ reason: "storage_failed" });
    const savedAttempt = await store.saveAttempt(profileId.value, sessionId.value, completedAttempt); const savedSession = savedAttempt._tag === "ok" ? await store.save(next) : savedAttempt;
    return savedSession._tag === "ok" ? ok({ session: next, batch: batch.value.batch }) : err({ reason: "storage_failed" });
  }

  private async projectLifecycle(
    session: ReviewSession,
    assessments: ModelReviewResult["priorFindingAssessments"],
    result: ReviewResult,
  ): Promise<Result<ReadonlyArray<FindingLifecycleEntry> | undefined, { readonly reason: string }>> {
    if (session.scope.kind === "full") return ok(undefined);
    const [rawComparison, rawPriorFindings] = await Promise.all([
      readFile(session.scope.comparisonMetadataPath, "utf8").catch(() => undefined),
      readFile(session.scope.previousFindingsPath, "utf8").catch(() => undefined),
    ]);
    if (rawComparison === undefined || rawPriorFindings === undefined) return err({ reason: "storage_failed" });
    let comparisonJson: unknown;
    let priorFindingsJson: unknown;
    try { comparisonJson = JSON.parse(rawComparison); priorFindingsJson = JSON.parse(rawPriorFindings); } catch { return err({ reason: "storage_failed" }); }
    const comparison = parseRevisionComparison(comparisonJson);
    const priorFindings = parsePriorFindingEvidence(priorFindingsJson);
    if (comparison._tag === "err" || priorFindings._tag === "err" || comparison.value.baseSessionId !== session.scope.baseSessionId || comparison.value.baseHeadSha !== session.scope.baseHeadSha || comparison.value.headSha !== session.scope.headSha) return err({ reason: "storage_failed" });
    const lifecycle = projectFindingLifecycle({
      priorFindings: priorFindings.value,
      assessments: assessments ?? [],
      currentFindings: result.findings,
      changedPaths: new Set(comparison.value.files.flatMap((file) => file.oldPath === undefined ? [file.path] : [file.path, file.oldPath]) as Array<RepoRelativePath>),
    });
    return lifecycle._tag === "ok" ? ok(lifecycle.value) : err({ reason: "invalid_result" });
  }
}
