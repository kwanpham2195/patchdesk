import { writeAtomicJson } from "../adapters/storage/json-file";
import { readFile } from "node:fs/promises";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { parseAbsolutePath, parseReviewAttemptId, parseReviewSessionId, parseWorkspaceProfileId, type IsoTimestamp } from "../domain/ids";
import { mapFindingLocation, parseUnifiedPatch } from "../domain/patch";
import { completeAttempt } from "../domain/review-session";
import { parseModelReviewResult, parseReviewResult } from "../domain/review-result";
import { err, ok, type Result } from "../domain/result";
import { createLocalDraft } from "./review-workbench";

/** Persists only validated structured review output; it has no shell, model, or GitHub write capability. */
export class ReviewCompletionService {
  constructor(private readonly paths: PatchdeskPaths, private readonly now: () => IsoTimestamp) {}
  async complete(input: unknown): Promise<Result<unknown, { readonly reason: string }>> {
    const profileId = parseWorkspaceProfileId(field(input, "profileId")); const sessionId = parseReviewSessionId(field(input, "sessionId")); const attemptId = parseReviewAttemptId(field(input, "attemptId"));
    const modelResult = parseModelReviewResult(field(input, "result"));
    if (profileId._tag === "err" || sessionId._tag === "err" || attemptId._tag === "err" || modelResult._tag === "err" || modelResult.value.rawNotes !== undefined) return err({ reason: "invalid_result" });
    const store = new ReviewSessionStore(this.paths); const [session, attempt] = await Promise.all([store.load(profileId.value, sessionId.value), store.loadAttempt(profileId.value, sessionId.value, attemptId.value)]);
    if (session._tag === "err" || attempt._tag === "err") return err({ reason: "not_found" });
    const patch = await readFile(session.value.patchPath, "utf8").catch(() => undefined);
    if (patch === undefined) return err({ reason: "storage_failed" });
    const files = parseUnifiedPatch(patch);
    const result = parseReviewResult({
      ...modelResult.value,
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
    const resultPath = parseAbsolutePath(this.paths.attemptResultFile(profileId.value, sessionId.value, attemptId.value)); if (resultPath._tag === "err") return err({ reason: "storage_failed" });
    const completed = completeAttempt(session.value, attempt.value, result.value, this.now(), resultPath.value); if (completed._tag === "err") return err({ reason: "not_current" });
    const completedAt = this.now();
    const completedAttempt = { ...attempt.value, ...completed.value.attempt, completedAt };
    const draft = createLocalDraft({ session: completed.value.session, attempt: completedAttempt, result: result.value, createdAt: completedAt }); if (draft._tag === "err") return err({ reason: "not_current" });
    const next = { ...completed.value.session, draft: { state: draft.value.draft.state }, draftContent: draft.value.draft, updatedAt: this.now() };
    const savedResult = await writeAtomicJson(resultPath.value, result.value);
    if (savedResult._tag === "err") return err({ reason: savedResult.error.reason === "sensitive_value" ? "invalid_result" : "storage_failed" });
    const savedAttempt = await store.saveAttempt(profileId.value, sessionId.value, completedAttempt); const savedSession = savedAttempt._tag === "ok" ? await store.save(next) : savedAttempt;
    return savedSession._tag === "ok" ? ok({ session: next, draft: draft.value.draft }) : err({ reason: "storage_failed" });
  }
}
function field(value: unknown, name: string): unknown { return typeof value === "object" && value !== null && name in value ? (value as Record<string, unknown>)[name] : undefined; }
