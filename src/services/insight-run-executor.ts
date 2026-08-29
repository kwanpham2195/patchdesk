import {
  parseContentHash,
  parseIsoTimestamp,
  type ContentHash,
  type InsightRunId,
  type IsoTimestamp,
} from "../domain/ids";
import {
  completeInsightRun,
  failInsightRun,
  provenanceFromRun,
  sameInsightRevision,
  type InsightFailureCategory,
  type InsightRecord,
  type InsightType,
} from "../domain/insight-record";
import type { RawJsonValue } from "../domain/json";
import { err, type Result } from "../domain/result";
import type { InsightStore } from "../adapters/storage/insight-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type {
  Active,
  InsightCoordinatorFailure,
  InsightInvocationInput,
  InsightInvoker,
  InsightRunResponse,
} from "./insight-run-coordinator";
import { validateInsightResult } from "./insight-result-validation";
import { contentHash } from "./review-artifact-hash";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";

/**
 * Runs one Insight invocation to its terminal state: invoke the provider,
 * validate the result against the run's own revision, and persist the
 * outcome under the Review lock.
 */
export class InsightRunExecutor {
  constructor(
    private readonly reviews: Pick<ReviewStore, "load">,
    private readonly sessions: Pick<ReviewSessionStore, "load">,
    private readonly insights: InsightStore,
    private readonly invokers: Readonly<{
      readonly analysis: InsightInvoker;
      readonly walkthrough: InsightInvoker;
    }>,
    private readonly operations: ReviewOperationCoordinator,
    private readonly active: Map<string, Active>,
    private readonly now: () => IsoTimestamp,
    private readonly recover: (input: {
      readonly profileId: InsightInvocationInput["profileId"];
      readonly reviewId: InsightInvocationInput["reviewId"];
      readonly type: InsightType;
    }) => Promise<
      Result<InsightRunResponse | undefined, InsightCoordinatorFailure>
    >,
    private readonly diagnostics?: Pick<ReviewDiagnosticService, "record">,
  ) {}

  async execute(
    input: InsightInvocationInput,
    type: InsightType,
    runId: InsightRunId,
    startedHash: ContentHash,
    controller: AbortController,
  ): Promise<void> {
    try {
      const invocation = await this.invokers[type].invoke(input, {
        signal: controller.signal,
      });
      const latestReview = await this.reviews.load(
        input.profileId,
        input.reviewId,
      );
      const latestSession =
        latestReview._tag === "ok"
          ? await this.sessions.load(
              input.profileId,
              latestReview.value.currentSessionId,
            )
          : err({
              _tag: "StorageFailure" as const,
              operation: "read" as const,
              reason: "io" as const,
            });
      const latestHash =
        latestSession._tag === "ok"
          ? parseContentHash(await contentHash(latestSession.value.patchPath))
          : err({ _tag: "InvalidDomainValue" as const, field: "patchHash" });
      const timestamp = parseIsoTimestamp(this.now());
      if (timestamp._tag === "err") {
        await this.recordExecutionFailure(
          input,
          type,
          runId,
          "unexpected_failure",
          "invalid_timestamp",
        );
        return;
      }
      const current =
        latestReview._tag === "ok" &&
        latestSession._tag === "ok" &&
        latestHash._tag === "ok" &&
        latestReview.value.currentSessionId === input.sessionId &&
        latestSession.value.id === input.sessionId &&
        latestHash.value === startedHash;
      if (!current) {
        await this.persistTerminal(
          input,
          type,
          runId,
          timestamp.value,
          (record) =>
            failInsightRun(
              record,
              runId,
              {
                runId,
                reason: "superseded",
                retryable: true,
                failedAt: timestamp.value,
              },
              timestamp.value,
            ),
          "superseded",
        );
        return;
      }
      if (invocation._tag === "err" || controller.signal.aborted) {
        const cancelled =
          controller.signal.aborted ||
          (invocation._tag === "err" &&
            invocation.error.reason === "cancelled");
        const category =
          invocation._tag === "err" && invocation.error.reason !== "cancelled"
            ? safeFailureCategory(invocation.error.reason)
            : undefined;
        // Attach a truncated stderr diagnostic when the walkthrough process provides one.
        const stderr =
          invocation._tag === "err" && invocation.error.stderr !== undefined
            ? invocation.error.stderr.slice(0, 500)
            : undefined;
        await this.persistTerminal(
          input,
          type,
          runId,
          timestamp.value,
          (record) =>
            failInsightRun(
              record,
              runId,
              category === undefined
                ? {
                    runId,
                    reason: cancelled ? "cancelled" : "failed",
                    retryable: true,
                    failedAt: timestamp.value,
                  }
                : {
                    runId,
                    reason: cancelled ? "cancelled" : "failed",
                    category,
                    retryable: true,
                    failedAt: timestamp.value,
                  },
              timestamp.value,
            ),
          "invocation",
        );
        if (stderr !== undefined)
          await this.recordDiagnostic(input, type, `stderr:${stderr}`);
        // Without the phase an invocation failure records no cause at all.
        if (category !== undefined)
          await this.recordDiagnostic(
            input,
            type,
            `invocation_${category}${phaseLabel(
              invocation._tag === "err" ? invocation.error.phase : undefined,
            )}`,
          );
        return;
      }
      const validated = await validateInsightResult(
        type,
        // SAFETY: invocation.value is InsightInvoker.invoke's ok payload. Its only implementation
        // (CodexInsightInvoker -> CodexAppServerClient.run) resolves it from `JSON.parse` of the
        // provider's turn/completed RPC payload, so it is always JSON-grammar data even though the
        // invoker interface leaves it `unknown`.
        invocation.value as RawJsonValue,
        input,
        {
          sessionId: input.sessionId,
          headSha: latestSession.value.key.headSha,
          patchHash: latestHash.value,
        },
      );
      if (validated._tag === "err") {
        await this.persistTerminal(
          input,
          type,
          runId,
          timestamp.value,
          (record) =>
            failInsightRun(
              record,
              runId,
              {
                runId,
                reason: "invalid_result",
                category: "invalid_result",
                retryable: true,
                failedAt: timestamp.value,
              },
              timestamp.value,
            ),
          "invalid_result",
        );
        await this.recordDiagnostic(
          input,
          type,
          `invalid_result_${validated.error}`,
        );
        return;
      }
      await this.persistTerminal(
        input,
        type,
        runId,
        timestamp.value,
        (record) => {
          const active = record.activeRun;
          if (active?.id !== runId) return err("superseded" as const);
          if (
            !sameInsightRevision(active.revision, {
              sessionId: input.sessionId,
              headSha: latestSession.value.key.headSha,
              patchHash: latestHash.value,
            })
          ) {
            return failInsightRun(
              record,
              runId,
              {
                runId,
                reason: "superseded",
                retryable: true,
                failedAt: timestamp.value,
              },
              timestamp.value,
            );
          }
          return completeInsightRun(
            record,
            runId,
            {
              runId,
              revision: active.revision,
              generatedAt: timestamp.value,
              provenance: provenanceFromRun(active),
              value: validated.value,
            },
            timestamp.value,
          );
        },
        "completion",
      );
    } catch {
      await this.recordExecutionFailure(
        input,
        type,
        runId,
        "unexpected_failure",
        safeFailureDetail(),
      );
    } finally {
      this.active.delete(runId);
    }
  }

  private async persistTerminal(
    input: InsightInvocationInput,
    type: InsightType,
    runId: InsightRunId,
    at: IsoTimestamp,
    operation: (
      record: InsightRecord<unknown>,
    ) => Result<InsightRecord<unknown>, "superseded">,
    detail: string,
  ): Promise<boolean> {
    try {
      const changed = await this.operations.withReviewLock(
        input.profileId,
        input.reviewId,
        async () => {
          const review = await this.reviews.load(
            input.profileId,
            input.reviewId,
          );
          if (review._tag === "err") return undefined;
          const session = await this.sessions.load(
            input.profileId,
            review.value.currentSessionId,
          );
          if (session._tag === "err") return undefined;
          const patchHash = parseContentHash(
            await contentHash(session.value.patchPath),
          );
          if (patchHash._tag === "err") return undefined;
          return this.insights.mutate({
            profileId: input.profileId,
            reviewId: input.reviewId,
            type,
            now: at,
            operation: (record) => {
              const active = record.activeRun;
              if (
                active?.id === runId &&
                (review.value.status._tag === "Terminal" ||
                  review.value.currentSessionId !== active.revision.sessionId ||
                  !sameInsightRevision(active.revision, {
                    sessionId: session.value.id,
                    headSha: session.value.key.headSha,
                    patchHash: patchHash.value,
                  }))
              ) {
                return failInsightRun(
                  record,
                  runId,
                  {
                    runId,
                    reason: "superseded",
                    retryable: true,
                    failedAt: at,
                  },
                  at,
                );
              }
              return operation(record);
            },
          });
        },
      );
      if (changed === undefined) throw new Error("revision_unavailable");
      if (changed._tag === "ok") return true;
      if (changed.error === "superseded") return false;
    } catch {
      // Fall through to orphan recovery and diagnostic reporting.
    }
    this.active.delete(runId);
    const recovered = await this.recover({
      profileId: input.profileId,
      reviewId: input.reviewId,
      type,
    });
    if (recovered._tag === "err")
      await this.recordDiagnostic(input, type, `${detail}_recovery_failed`);
    await this.recordDiagnostic(input, type, `${detail}_persist_failed`);
    return false;
  }

  private async recordExecutionFailure(
    input: InsightInvocationInput,
    type: InsightType,
    runId: InsightRunId,
    category: InsightFailureCategory,
    detail: "invalid_timestamp" | "unexpected_failure",
  ): Promise<void> {
    const timestamp = parseIsoTimestamp(this.now());
    if (timestamp._tag === "ok") {
      await this.persistTerminal(
        input,
        type,
        runId,
        timestamp.value,
        (record) =>
          failInsightRun(
            record,
            runId,
            {
              runId,
              reason: "failed",
              category,
              retryable: true,
              failedAt: timestamp.value,
            },
            timestamp.value,
          ),
        detail,
      );
    }
    await this.recordDiagnostic(input, type, detail);
  }

  private async recordDiagnostic(
    input: InsightInvocationInput,
    type: InsightType,
    detail: string,
  ): Promise<void> {
    try {
      await this.diagnostics?.record({
        profileId: input.profileId,
        sessionId: input.sessionId,
        category: "run",
        phase: `insight-${type}-failed`,
        retryable: true,
        detail: `insight_${type}_${detail}`,
      });
    } catch {
      // Diagnostics are best effort and never become an unhandled rejection.
    }
  }
}

/** Renders the invoker's bounded phase label; never provider text. */
function phaseLabel(phase: string | undefined): string {
  return phase !== undefined && /^[a-z_]{1,32}$/.test(phase) ? `_${phase}` : "";
}

function safeFailureDetail(): "unexpected_failure" {
  return "unexpected_failure";
}

function safeFailureCategory(value: string): InsightFailureCategory {
  switch (value) {
    case "authentication_required":
    case "rate_limited":
    case "runtime_unavailable":
    case "timed_out":
    case "execution_failed":
    case "invalid_result":
    case "unexpected_failure":
      return value;
    default:
      return "unexpected_failure";
  }
}
