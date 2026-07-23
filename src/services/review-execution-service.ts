import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  parseAbsolutePath,
  parseContentHash,
  parseReviewAttemptId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type IsoTimestamp,
} from "../domain/ids";
import type { ReviewAttempt } from "../domain/review-attempt";
import { startNextAttempt } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import type { ReviewHeadVerifier } from "./review-head-verifier";
import type { PiRuntimeModelCatalog } from "../adapters/pi/pi-runtime-model-catalog";
import type { ReviewRunMetadata } from "./run-projection";

export const REVIEW_REASONING_LEVELS = ["low", "medium", "high"] as const;
export type ReviewReasoningLevel = (typeof REVIEW_REASONING_LEVELS)[number];

export type ReviewExecutionFailure = {
  readonly reason:
    | "invalid_input"
    | "not_found"
    | "not_runnable"
    | "unsupported_model"
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
  ) {}

  async start(input: unknown): Promise<Result<{
    readonly profileId: string;
    readonly sessionId: string;
    readonly attemptId: string;
    readonly model: string;
    readonly reasoning: ReviewReasoningLevel;
    readonly metadata: ReviewRunMetadata;
  }, ReviewExecutionFailure>> {
    const profileId = parseWorkspaceProfileId(field(input, "profileId"));
    const sessionId = parseReviewSessionId(field(input, "sessionId"));
    const model = field(input, "model");
    const reasoning = parseReasoning(field(input, "reasoning"));
    if (
      profileId._tag === "err" ||
      sessionId._tag === "err" ||
      typeof model !== "string" ||
      model.length === 0 ||
      reasoning === undefined
    ) return err({ reason: "invalid_input" });
    const supportedModels = await this.modelCatalog.list();
    if (!supportedModels.some((candidate) => candidate.id === model)) {
      return err({ reason: "unsupported_model" });
    }

    const session = await this.sessions.load(profileId.value, sessionId.value);
    if (session._tag === "err") {
      return err({ reason: session.error.reason === "not_found" ? "not_found" : "storage" });
    }
    if (session.value.state._tag === "Running" || session.value.state._tag === "Merged") {
      return err({ reason: "not_runnable" });
    }
    if (this.headVerifier !== undefined) {
      const verified = await this.headVerifier.verify(session.value);
      if (verified._tag === "err") return err(verified.error);
    }

    const previous = await this.sessions.listAttempts(profileId.value, sessionId.value);
    if (previous._tag === "err") return err({ reason: "storage" });
    const started = startNextAttempt(session.value, previous.value.map((attempt) => attempt.id));
    if (started._tag === "err") return err({ reason: "not_runnable" });

    // Session preparation currently writes one immutable context artifact. The
    // execution attempt receives its own debug path but reads that prepared
    // snapshot until context preparation is moved to allocated attempts.
    const preparedAttempt = parseReviewAttemptId("001");
    if (preparedAttempt._tag === "err") return err({ reason: "storage" });
    const [contextHash, fullPatchHash, comparisonHash] = await Promise.all([
      contentHash(this.paths.attemptContextFile(profileId.value, sessionId.value, preparedAttempt.value)),
      contentHash(session.value.patchPath),
      session.value.scope.kind === "incremental"
        ? contentHash(session.value.scope.comparisonPatchPath)
        : Promise.resolve(undefined),
    ]);
    const parsedContextHash = parseContentHash(contextHash);
    const parsedFullPatchHash = parseContentHash(fullPatchHash);
    const parsedComparisonHash = comparisonHash === undefined
      ? undefined
      : parseContentHash(comparisonHash);
    const contextPath = parseAbsolutePath(this.paths.attemptContextFile(profileId.value, sessionId.value, preparedAttempt.value));
    const reviewInputPath = parseAbsolutePath(this.paths.attemptReviewInputFile(profileId.value, sessionId.value, preparedAttempt.value));
    const debugPath = parseAbsolutePath(this.paths.attemptDebugFile(profileId.value, sessionId.value, started.value.attemptId));
    const skillHash = parseContentHash("0".repeat(64));
    if (
      parsedContextHash._tag === "err" ||
      parsedFullPatchHash._tag === "err" ||
      (parsedComparisonHash !== undefined && parsedComparisonHash._tag === "err") ||
      contextPath._tag === "err" ||
      reviewInputPath._tag === "err" ||
      debugPath._tag === "err" ||
      skillHash._tag === "err"
    ) return err({ reason: "storage" });

    const scope = session.value.scope.kind === "incremental" && parsedComparisonHash !== undefined
      ? {
          scopeKind: "incremental" as const,
          baseSessionId: session.value.scope.baseSessionId,
          comparisonContentHash: parsedComparisonHash.value,
        }
      : { scopeKind: "full" as const };
    const attempt: ReviewAttempt = {
      id: started.value.attemptId,
      sessionId: session.value.id,
      // The CLI only returns a provider run ID after the finite workflow has
      // completed. Never claim a placeholder is a real Flue run identifier.
      state: { _tag: "Starting" },
      model,
      reasoning,
      agentIdentity: "Patchdesk review agent",
      reviewMode: session.value.scope.kind === "incremental" ? "Review updates" : "Full review",
      accessScope: "Read-only repository inspection",
      ...scope,
      fullPatchHash: parsedFullPatchHash.value,
      reviewSkillVersion: skillHash.value,
      contextHash: parsedContextHash.value,
      contextPath: contextPath.value,
      reviewInputPath: reviewInputPath.value,
      debugPath: debugPath.value,
      startedAt: this.now(),
    };
    const startedSession = {
      ...started.value.session,
      updatedAt: this.now(),
    };
    const persisted = await this.sessions.beginAttempt({
      profileId: profileId.value,
      session: startedSession,
      attempt,
    });
    if (persisted._tag === "err") return err({ reason: "storage" });
    return ok({
      profileId: profileId.value,
      sessionId: sessionId.value,
      attemptId: started.value.attemptId,
      model,
      reasoning,
      metadata: {
        agent: "Patchdesk review agent",
        model,
        reasoning,
        mode: attempt.reviewMode ?? "Full review",
        access: "Read-only repository inspection",
      },
    });
  }
}

function parseReasoning(value: unknown): ReviewReasoningLevel | undefined {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : undefined;
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

async function contentHash(path: string): Promise<string> {
  const content = await readFile(path, "utf8").catch(() => undefined);
  return content === undefined ? "" : createHash("sha256").update(content).digest("hex");
}
