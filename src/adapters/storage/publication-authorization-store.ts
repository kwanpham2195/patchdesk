import * as v from "valibot";

import {
  parseContentHash,
  parseGitSha,
  parseInsightRunId,
  parseIsoTimestamp,
  parsePublicationAuthorizationId,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type ReviewId,
  type WorkspaceProfileId,
} from "../../domain/ids";
import type { PublicationAuthorization } from "../../domain/publication-authorization";
import type { GitHubReviewEvent } from "../../domain/review-batch";
import { err, ok, type Result } from "../../domain/result";
import { readJsonFile, writeAtomicJson, type StorageFailure } from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

const stateSchema = v.variant("_tag", [
  v.strictObject({ _tag: v.literal("Armed") }),
  v.strictObject({ _tag: v.literal("Revoked"), reason: v.picklist(["updates_available", "refresh", "revision_changed", "draft_changed", "draft_not_empty", "analysis_failed", "analysis_cancelled", "validation_failed", "needs_attention", "authorization_mismatch"] as const) }),
  v.strictObject({ _tag: v.literal("Consumed"), consumedAt: v.pipe(v.string(), v.isoTimestamp()) }),
]);
const schema = v.strictObject({
  schemaVersion: v.literal(1),
  id: v.pipe(v.string(), v.minLength(1)),
  profileId: v.pipe(v.string(), v.minLength(1)),
  reviewId: v.pipe(v.string(), v.minLength(1)),
  sessionId: v.pipe(v.string(), v.minLength(1)),
  headSha: v.pipe(v.string(), v.minLength(40)),
  patchHash: v.pipe(v.string(), v.length(64)),
  analysisRunId: v.pipe(v.string(), v.minLength(1)),
  expectedDraftRevision: v.pipe(v.string(), v.isoTimestamp()),
  event: v.picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
  state: stateSchema,
});

type Failure = StorageFailure;

export class PublicationAuthorizationStore {
  constructor(private readonly paths: PatchdeskPaths) {}

  async load(profileId: WorkspaceProfileId, reviewId: ReviewId): Promise<Result<PublicationAuthorization, Failure>> {
    const stored = await readJsonFile(this.paths.publicationAuthorizationFile(profileId, reviewId));
    if (stored._tag === "err") return stored;
    const parsed = v.safeParse(schema, stored.value);
    if (!parsed.success) return invalidRead();
    const value = parseAuthorization(parsed.output);
    return value._tag === "ok" && value.value.profileId === profileId && value.value.reviewId === reviewId ? value : invalidRead();
  }

  async save(value: PublicationAuthorization): Promise<Result<void, Failure>> {
    return writeAtomicJson(this.paths.publicationAuthorizationFile(value.profileId, value.reviewId), value);
  }
}

function parseAuthorization(input: v.InferOutput<typeof schema>): Result<PublicationAuthorization, Failure> {
  const id = parsePublicationAuthorizationId(input.id);
  const profileId = parseWorkspaceProfileId(input.profileId);
  const reviewId = parseReviewId(input.reviewId);
  const sessionId = parseReviewSessionId(input.sessionId);
  const headSha = parseGitSha(input.headSha);
  const patchHash = parseContentHash(input.patchHash);
  const analysisRunId = parseInsightRunId(input.analysisRunId);
  const expectedDraftRevision = parseIsoTimestamp(input.expectedDraftRevision);
  const createdAt = parseIsoTimestamp(input.createdAt);
  if ([id, profileId, reviewId, sessionId, headSha, patchHash, analysisRunId, expectedDraftRevision, createdAt].some((item) => item._tag === "err")) return invalidRead();
  if (id._tag === "err" || profileId._tag === "err" || reviewId._tag === "err" || sessionId._tag === "err" || headSha._tag === "err" || patchHash._tag === "err" || analysisRunId._tag === "err" || expectedDraftRevision._tag === "err" || createdAt._tag === "err") return invalidRead();
  const consumedAt = input.state._tag === "Consumed" ? parseIsoTimestamp(input.state.consumedAt) : undefined;
  if (consumedAt?._tag === "err") return invalidRead();
  const state = input.state._tag === "Armed" ? input.state : input.state._tag === "Revoked" ? input.state : consumedAt === undefined ? undefined : { _tag: "Consumed" as const, consumedAt: consumedAt.value };
  if (state === undefined) return invalidRead();
  return ok({ schemaVersion: 1, id: id.value, profileId: profileId.value, reviewId: reviewId.value, sessionId: sessionId.value, headSha: headSha.value, patchHash: patchHash.value, analysisRunId: analysisRunId.value, expectedDraftRevision: expectedDraftRevision.value, event: input.event as GitHubReviewEvent, createdAt: createdAt.value, state: state as PublicationAuthorization["state"] });
}

function invalidRead(): Result<never, Failure> {
  return err({ _tag: "StorageFailure", operation: "read", reason: "invalid_stored_value" });
}
