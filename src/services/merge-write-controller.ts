import type { GitHubMergeWriter, GitHubReader } from "../adapters/github/github-adapter";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { MergeOperationStore } from "../adapters/storage/merge-operation-store";
import { parseReviewSessionId, parseWorkspaceProfileId, type IsoTimestamp } from "../domain/ids";
import { confirmMergeOperation, markMergeOutcomeUnknown, rejectMergeOperation, requestMergeOperation } from "../domain/merge-operation";
import { err, ok, type Result } from "../domain/result";
import { mergePullRequest, type MergeMethod } from "./merge-service";
import { readObjectField } from "./read-object-field";

/** Main-process merge boundary; the renderer supplies only an already-confirmed method and acknowledgement. */
export class MergeWriteController {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly profiles: ProfileStore,
    private readonly sessions: ReviewSessionStore,
    private readonly github: Pick<GitHubReader, "getMergePolicy"> & GitHubMergeWriter,
    private readonly methods: ReadonlyArray<MergeMethod>,
    private readonly now: () => IsoTimestamp,
    private readonly operations: MergeOperationStore,
  ) {}

  async merge(input: unknown): Promise<Result<unknown, { readonly reason: string }>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    const sessionId = parseReviewSessionId(readObjectField(input, "sessionId"));
    const method = readObjectField(input, "method");
    const acknowledgedWarnings = readObjectField(input, "acknowledgedWarnings");
    if (profileId._tag === "err" || sessionId._tag === "err" || !isMethod(method) || typeof acknowledgedWarnings !== "boolean") return err({ reason: "invalid_input" });
    const key = `${profileId.value}:${sessionId.value}`;
    if (this.inFlight.has(key)) return err({ reason: "merge_in_progress" });
    this.inFlight.add(key);
    try {
    const [profile, session] = await Promise.all([this.profiles.load(profileId.value), this.sessions.load(profileId.value, sessionId.value)]);
    if (profile._tag === "err" || session._tag === "err") return err({ reason: "not_found" });
    const startedAt = this.now();
    const requested = requestMergeOperation({ operationId: `merge-${startedAt.replace(/[^0-9]/g, "")}`, profileId: profileId.value, sessionId: sessionId.value, pr: { host: session.value.key.host, owner: session.value.key.owner, repo: session.value.key.repo, number: session.value.key.prNumber }, expectedHeadSha: session.value.key.headSha, method, acknowledgedWarningCodes: acknowledgedWarnings ? ["warnings_acknowledged"] : [], startedAt });
    if (requested._tag === "err") return err({ reason: "invalid_input" });
    if ((await this.operations.begin(requested.value))._tag === "err") return err({ reason: "storage_failed" });
    const unknown = markMergeOutcomeUnknown(requested.value);
    if (unknown._tag === "err" || (await this.operations.markOutcomeUnknown(unknown.value))._tag === "err") return err({ reason: "storage_failed" });
    const merged = await mergePullRequest({ profile: profile.value, session: session.value, ...(session.value.visibleResult === undefined ? {} : { result: session.value.visibleResult }), gateway: this.github, method, supportedMethods: this.methods, acknowledgedWarnings, now: startedAt });
    if (merged._tag === "err") {
      const rejected = rejectMergeOperation(unknown.value, mergeReason(merged.error._tag));
      if (rejected._tag === "ok") await this.operations.reject(rejected.value);
      return err({ reason: mergeReason(merged.error._tag) });
    }
    const confirmed = confirmMergeOperation(unknown.value, startedAt, merged.value.session.mergeDecision?.mergeCommitSha);
    if (confirmed._tag === "err" || (await this.operations.confirm(confirmed.value))._tag === "err") return err({ reason: "merge_outcome_unknown" });
    const saved = await this.sessions.save(merged.value.session);
    if (saved._tag === "err") return err({ reason: "merge_outcome_unknown" });
    const removed = await this.operations.removeAfterSessionReceipt(profileId.value, sessionId.value);
    return removed._tag === "ok" ? ok({ session: merged.value.session, readiness: merged.value.readiness }) : err({ reason: "merge_outcome_unknown" });
    } finally {
      this.inFlight.delete(key);
    }
  }
}

function isMethod(value: unknown): value is MergeMethod { return value === "merge" || value === "squash" || value === "rebase"; }
function mergeReason(tag: string): string { return tag === "MergeBlocked" ? "merge_blocked" : tag === "MergeAcknowledgementRequired" ? "merge_acknowledgement_required" : tag === "StaleHeadBlocksMerge" ? "stale_head" : "merge_failed"; }
