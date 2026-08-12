import type { GitHubMergeWriter, GitHubReader } from "../adapters/github/github-adapter";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { MergeOperationStore } from "../adapters/storage/merge-operation-store";
import { parseContentHash, parseGitSha, parseIsoTimestamp, parseReviewId, parseReviewSessionId, parseWorkspaceProfileId, type IsoTimestamp } from "../domain/ids";
import { confirmMergeOperation, markMergeOutcomeUnknown, rejectMergeOperation, requestMergeOperation } from "../domain/merge-operation";
import { markReviewTerminal } from "../domain/review";
import { err, ok, type Result } from "../domain/result";
import { mergePullRequest, type MergeMethod } from "./merge-service";
import { readObjectField } from "./read-object-field";
import type { ReviewWriteGate } from "./review-write-gate";

import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
/** Main-process merge boundary; the renderer supplies only an already-confirmed method and acknowledgement. */
export class MergeWriteController {
  private readonly inFlight = new Set<string>();

  constructor(
    _profiles: ProfileStore,
    private readonly sessions: ReviewSessionStore,
    private readonly github: Pick<GitHubReader, "getMergePolicy" | "getPullRequest" | "getPullRequestDiff"> & GitHubMergeWriter,
    private readonly methods: ReadonlyArray<MergeMethod>,
    private readonly now: () => IsoTimestamp,
    private readonly operations: MergeOperationStore,
    private readonly writeGate?: ReviewWriteGate,
    private readonly reviews?: Pick<ReviewStore, "load" | "save">,
    private readonly writeCoordinator?: ReviewOperationCoordinator,
  ) {}

  async merge(input: unknown): Promise<Result<unknown, { readonly reason: string }>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    const sessionId = parseReviewSessionId(readObjectField(input, "sessionId"));
    const reviewId = parseReviewId(readObjectField(input, "reviewId"));
    const expectedHead = parseGitSha(readObjectField(input, "expectedHeadSha"));
    const expectedBase = parseGitSha(readObjectField(input, "expectedBaseSha"));
    const expectedPatch = parseContentHash(readObjectField(input, "expectedPatchHash"));
    const expectedRevision = parseIsoTimestamp(readObjectField(input, "expectedRevision"));
    const method = readObjectField(input, "method");
    const acknowledgedWarnings = readObjectField(input, "acknowledgedWarnings");
    if (profileId._tag === "err" || sessionId._tag === "err" || reviewId._tag === "err" || expectedHead._tag === "err" || expectedBase._tag === "err" || expectedPatch._tag === "err" || expectedRevision._tag === "err" || !isMethod(method) || this.writeGate === undefined) return err({ reason: "invalid_input" });
    const acknowledgement = parseAcknowledgement(acknowledgedWarnings, expectedHead.value, expectedBase.value, expectedPatch.value);
    if (acknowledgement === undefined) return err({ reason: "invalid_input" });
    const key = `${profileId.value}:${reviewId.value}`;
    const acquired = this.writeCoordinator === undefined
      ? !this.inFlight.has(key)
      : this.writeCoordinator.acquire(key);
    if (!acquired) return err({ reason: "merge_in_progress" });
    if (this.writeCoordinator === undefined) this.inFlight.add(key);
    try {
    const gated = await this.writeGate.requireFresh(profileId.value, reviewId.value, { sessionId: sessionId.value, headSha: expectedHead.value, patchHash: expectedPatch.value, draftRevision: expectedRevision.value });
    if (gated._tag === "err") return err({ reason: gated.error.reason });
    if (gated.value.session.pr.baseSha !== acknowledgement.revision.baseSha) return err({ reason: "stale" });
    const [profile, session] = [ok(gated.value.profile), ok(gated.value.session)] as const;
    if (profile._tag === "err" || session._tag === "err") return err({ reason: "not_found" });
    const startedAt = this.now();
    const requested = requestMergeOperation({ operationId: `merge-${startedAt.replace(/[^0-9]/g, "")}`, profileId: profileId.value, sessionId: sessionId.value, pr: { host: session.value.key.host, owner: session.value.key.owner, repo: session.value.key.repo, number: session.value.key.prNumber }, expectedHeadSha: session.value.key.headSha, method, acknowledgedWarningCodes: acknowledgement.warningCodes, startedAt });
    if (requested._tag === "err") return err({ reason: "invalid_input" });
    if ((await this.operations.begin(requested.value))._tag === "err") return err({ reason: "storage_failed" });
    const unknown = markMergeOutcomeUnknown(requested.value);
    if (unknown._tag === "err" || (await this.operations.markOutcomeUnknown(unknown.value))._tag === "err") return err({ reason: "storage_failed" });
    const merged = await mergePullRequest({ profile: profile.value, session: session.value, ...(session.value.visibleResult === undefined ? {} : { result: session.value.visibleResult }), gateway: this.github, method, supportedMethods: this.methods, acknowledgedWarningCodes: acknowledgement.warningCodes, now: startedAt });
    if (merged._tag === "err") {
      const rejected = rejectMergeOperation(unknown.value, mergeReason(merged.error._tag));
      if (rejected._tag === "ok") await this.operations.reject(rejected.value);
      return err({ reason: mergeReason(merged.error._tag) });
    }
    const confirmed = confirmMergeOperation(unknown.value, startedAt, merged.value.session.mergeDecision?.mergeCommitSha);
    if (confirmed._tag === "err" || (await this.operations.confirm(confirmed.value))._tag === "err") return err({ reason: "merge_outcome_unknown" });
    const saved = await this.sessions.save(merged.value.session);
    if (saved._tag === "err") return err({ reason: "merge_outcome_unknown" });
    let terminalReview = undefined;
    if (this.reviews !== undefined && reviewId._tag === "ok") {
      const currentReview = await this.reviews.load(profileId.value, reviewId.value);
      if (currentReview._tag !== "ok") return err({ reason: "merge_outcome_unknown" });
      const marked = markReviewTerminal(currentReview.value, "merged", startedAt);
      const savedReview = await this.reviews.save(marked, currentReview.value.updatedAt);
      if (savedReview._tag === "err") return err({ reason: "merge_outcome_unknown" });
      terminalReview = marked;
    }
    const removed = await this.operations.removeAfterSessionReceipt(profileId.value, sessionId.value);
    return removed._tag === "ok" ? ok({ session: merged.value.session, readiness: merged.value.readiness, ...(terminalReview === undefined ? {} : { review: terminalReview }) }) : err({ reason: "merge_outcome_unknown" });
    } finally {
      if (this.writeCoordinator === undefined) this.inFlight.delete(key);
      else this.writeCoordinator.release(key);
    }
  }
}

type MergeWarningAcknowledgement = {
  readonly revision: { readonly headSha: string; readonly baseSha: string; readonly patchHash: string };
  readonly warningCodes: ReadonlyArray<"request_changes" | "high_severity_finding" | "analysis_finding">;
};

function parseAcknowledgement(value: unknown, expectedHeadSha: string, expectedBaseSha: string, expectedPatchHash: string): MergeWarningAcknowledgement | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const revision = readObjectField(value, "revision");
  const warningCodes = readObjectField(value, "warningCodes");
  if (typeof revision !== "object" || revision === null || Array.isArray(revision) || !Array.isArray(warningCodes) || !warningCodes.every(isMergeWarningCode)) return undefined;
  const headSha = readObjectField(revision, "headSha");
  const baseSha = readObjectField(revision, "baseSha");
  const patchHash = readObjectField(revision, "patchHash");
  return headSha === expectedHeadSha && baseSha === expectedBaseSha && patchHash === expectedPatchHash
    ? { revision: { headSha, baseSha, patchHash }, warningCodes: [...new Set(warningCodes)].sort() }
    : undefined;
}

function isMergeWarningCode(value: unknown): value is MergeWarningAcknowledgement["warningCodes"][number] { return value === "request_changes" || value === "high_severity_finding" || value === "analysis_finding"; }

function isMethod(value: unknown): value is MergeMethod { return value === "merge" || value === "squash" || value === "rebase"; }
function mergeReason(tag: string): string { return tag === "MergeBlocked" ? "merge_blocked" : tag === "MergeAcknowledgementRequired" ? "merge_acknowledgement_required" : tag === "StaleHeadBlocksMerge" || tag === "RevisionChangedBlocksMerge" ? "stale_head" : tag === "RevisionUnavailableBlocksMerge" ? "not_fresh" : "merge_failed"; }
