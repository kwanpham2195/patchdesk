import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  parseAbsolutePath,
  parseContentHash,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type IsoTimestamp,
  type ReviewAttemptId,
  type WorkspaceProfileId,
} from "../domain/ids";
import type { ReviewAttempt } from "../domain/review-attempt";
import type { ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import type { StorageFailure } from "../adapters/storage/json-file";
import type { ReviewHeadVerifier } from "./review-head-verifier";
import { ReviewLifecycleGate } from "./review-lifecycle-gate";
import type { PiRuntimeModelCatalog } from "../adapters/pi/pi-runtime-model-catalog";
import type { ReviewRunMetadata } from "./run-projection";
import { prepareAttemptArtifacts } from "./review-attempt-artifacts";
import { contentHash } from "./review-artifact-hash";
import { readObjectField } from "./read-object-field";

export const REVIEW_REASONING_LEVELS = ["low", "medium", "high"] as const;
export type ReviewReasoningLevel = (typeof REVIEW_REASONING_LEVELS)[number];

export type ReviewExecutionFailure = {
  readonly reason:
    | "invalid_input"
    | "not_found"
    | "not_runnable"
    | "unsupported_model"
    | "catalog_unavailable"
    | "profile_not_found"
    | "github_read"
    | "head_changed"
    | "storage";
};

/**
 * Turns a prepared session into one durable attempt. This is intentionally main-process
 * only: the renderer can select a model, but it cannot mint paths or alter saved runs.
 */
export class ReviewExecutionService {
  constructor(
    private readonly sessions: ReviewSessionStore,
    private readonly paths: PatchdeskPaths,
    private readonly modelCatalog: PiRuntimeModelCatalog,
    private readonly now: () => IsoTimestamp,
    private readonly headVerifier?: ReviewHeadVerifier,
    private readonly lifecycleGate: ReviewLifecycleGate = new ReviewLifecycleGate(),
  ) {}

  async start(input: unknown): Promise<Result<{
    readonly profileId: string;
    readonly sessionId: string;
    readonly attemptId: string;
    readonly model: string;
    readonly reasoning: ReviewReasoningLevel;
    readonly metadata: ReviewRunMetadata;
  }, ReviewExecutionFailure>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    if (profileId._tag === "err") return this.startUnlocked(input);
    return this.lifecycleGate.withProfileLock(profileId.value, () => this.startUnlocked(input));
  }

  private async startUnlocked(input: unknown): Promise<Result<{
    readonly profileId: string;
    readonly sessionId: string;
    readonly attemptId: string;
    readonly model: string;
    readonly reasoning: ReviewReasoningLevel;
    readonly metadata: ReviewRunMetadata;
  }, ReviewExecutionFailure>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    const sessionId = parseReviewSessionId(readObjectField(input, "sessionId"));
    const model = readObjectField(input, "model");
    const reasoning = parseReasoning(readObjectField(input, "reasoning"));
    if (
      profileId._tag === "err" ||
      sessionId._tag === "err" ||
      typeof model !== "string" ||
      model.length === 0 ||
      reasoning === undefined
    ) return err({ reason: "invalid_input" });
    const catalog = await this.modelCatalog.get();
    if (catalog._tag === "err") return err({ reason: "catalog_unavailable" });
    if (!catalog.value.models.some((candidate) => candidate.id === model)) {
      return err({ reason: "unsupported_model" });
    }

    const session = await this.sessions.load(profileId.value, sessionId.value);
    if (session._tag === "err") {
      return err({ reason: session.error.reason === "not_found" ? "not_found" : "storage" });
    }
    if (session.value.state._tag === "Merged") return err({ reason: "not_runnable" });
    if (session.value.state._tag === "Running") {
      const currentAttemptId = session.value.currentAttemptId;
      if (currentAttemptId === undefined) return err({ reason: "not_runnable" });
      const currentAttempt = await this.sessions.loadAttempt(profileId.value, sessionId.value, currentAttemptId);
      if (currentAttempt._tag === "err" || currentAttempt.value.state._tag !== "Interrupted") {
        return err({ reason: "not_runnable" });
      }
    }
    if (this.headVerifier !== undefined) {
      const verified = await this.headVerifier.verify(session.value);
      if (verified._tag === "err") return err(verified.error);
    }

    const startedAt = this.now();
    const persisted = await this.sessions.beginAttempt({
      profileId: profileId.value,
      sessionId: sessionId.value,
      updatedAt: startedAt,
      createAttempt: async (freshSession, attemptId) => this.createAttempt({
        profileId: profileId.value,
        session: freshSession,
        attemptId,
        model,
        reasoning,
        startedAt,
      }),
    });
    if (persisted._tag === "err") {
      return err({ reason: persisted.error._tag === "BeginAttemptRejected" ? "not_runnable" : "storage" });
    }
    return ok({
      profileId: profileId.value,
      sessionId: sessionId.value,
      attemptId: persisted.value.id,
      model,
      reasoning,
      metadata: {
        agent: "Patchdesk review agent",
        model,
        reasoning,
        mode: persisted.value.reviewMode ?? "Full review",
        access: "Read-only repository inspection",
      },
    });
  }

  private async createAttempt(input: {
    readonly profileId: WorkspaceProfileId;
    readonly session: ReviewSession;
    readonly attemptId: ReviewAttemptId;
    readonly model: string;
    readonly reasoning: ReviewReasoningLevel;
    readonly startedAt: IsoTimestamp;
  }): Promise<Result<ReviewAttempt, StorageFailure>> {
    const artifacts = await prepareAttemptArtifacts({
      paths: this.paths,
      profileId: input.profileId,
      sessionId: input.session.id,
      attemptId: input.attemptId,
    });
    if (artifacts._tag === "err") return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    const [contextHash, fullPatchHash, comparisonHash] = await Promise.all([
      contentHash(artifacts.value.contextPath),
      contentHash(input.session.patchPath),
      input.session.scope.kind === "incremental"
        ? contentHash(input.session.scope.comparisonPatchPath)
        : Promise.resolve(undefined),
    ]);
    const parsedContextHash = parseContentHash(contextHash);
    const parsedFullPatchHash = parseContentHash(fullPatchHash);
    const parsedComparisonHash = comparisonHash === undefined ? undefined : parseContentHash(comparisonHash);
    const contextPath = parseAbsolutePath(artifacts.value.contextPath);
    const reviewInputPath = parseAbsolutePath(artifacts.value.reviewInputPath);
    const debugPath = parseAbsolutePath(artifacts.value.debugPath);
    const skillHash = parseContentHash("0".repeat(64));
    if (
      parsedContextHash._tag === "err" || parsedFullPatchHash._tag === "err" ||
      (parsedComparisonHash !== undefined && parsedComparisonHash._tag === "err") ||
      contextPath._tag === "err" || reviewInputPath._tag === "err" ||
      debugPath._tag === "err" || skillHash._tag === "err"
    ) return err({ _tag: "StorageFailure", operation: "write", reason: "invalid_stored_value" });
    const scope = input.session.scope.kind === "incremental" && parsedComparisonHash !== undefined
      ? { scopeKind: "incremental" as const, baseSessionId: input.session.scope.baseSessionId, comparisonContentHash: parsedComparisonHash.value }
      : { scopeKind: "full" as const };
    return ok({
      id: input.attemptId,
      sessionId: input.session.id,
      state: { _tag: "Starting" },
      model: input.model,
      reasoning: input.reasoning,
      agentIdentity: "Patchdesk review agent",
      reviewMode: input.session.scope.kind === "incremental" ? "Review updates" : "Full review",
      accessScope: "Read-only repository inspection",
      ...scope,
      fullPatchHash: parsedFullPatchHash.value,
      reviewSkillVersion: skillHash.value,
      contextHash: parsedContextHash.value,
      contextPath: contextPath.value,
      reviewInputPath: reviewInputPath.value,
      debugPath: debugPath.value,
      startedAt: input.startedAt,
    });
  }
}

function parseReasoning(value: unknown): ReviewReasoningLevel | undefined {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : undefined;
}
