import type { GitHubMergeWriter, GitHubReader } from "../adapters/github/github-adapter";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { parseReviewSessionId, parseWorkspaceProfileId, type IsoTimestamp } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import { mergePullRequest, type MergeMethod } from "./merge-service";
import { readObjectField } from "./read-object-field";

/** Main-process merge boundary; the renderer supplies only an already-confirmed method and acknowledgement. */
export class MergeWriteController {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly sessions: ReviewSessionStore,
    private readonly github: Pick<GitHubReader, "getPullRequest" | "getPullRequestChecks"> & GitHubMergeWriter,
    private readonly methods: ReadonlyArray<MergeMethod>,
    private readonly now: () => IsoTimestamp,
  ) {}

  async merge(input: unknown): Promise<Result<unknown, { readonly reason: string }>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    const sessionId = parseReviewSessionId(readObjectField(input, "sessionId"));
    const method = readObjectField(input, "method");
    const acknowledgedWarnings = readObjectField(input, "acknowledgedWarnings");
    if (profileId._tag === "err" || sessionId._tag === "err" || !isMethod(method) || typeof acknowledgedWarnings !== "boolean") return err({ reason: "invalid_input" });
    const [profile, session] = await Promise.all([this.profiles.load(profileId.value), this.sessions.load(profileId.value, sessionId.value)]);
    if (profile._tag === "err" || session._tag === "err" || session.value.visibleResult === undefined) return err({ reason: "not_found" });
    const merged = await mergePullRequest({ profile: profile.value, session: session.value, result: session.value.visibleResult, gateway: this.github, method, supportedMethods: this.methods, acknowledgedWarnings, now: this.now() });
    if (merged._tag === "err") return err({ reason: mergeReason(merged.error._tag) });
    const saved = await this.sessions.save(merged.value.session);
    return saved._tag === "ok" ? ok({ session: merged.value.session, readiness: merged.value.readiness }) : err({ reason: "storage_failed" });
  }
}

function isMethod(value: unknown): value is MergeMethod { return value === "merge" || value === "squash" || value === "rebase"; }
function mergeReason(tag: string): string { return tag === "MergeBlocked" ? "merge_blocked" : tag === "MergeAcknowledgementRequired" ? "merge_acknowledgement_required" : tag === "StaleHeadBlocksMerge" ? "stale_head" : "merge_failed"; }
