import type { LogEntryInput } from "#src/domain/log-entry";
import { logInsightEvidenceFailure } from "./insight-evidence-diagnostic";
import {
  insightFailureDiagnostic,
  insightEvidenceFailureCategory,
  sanitizedInsightFailureDetail,
} from "#src/domain/insight-failure-diagnostic";
import * as v from "valibot";

import { definedProps } from "#src/domain/defined-props";
import {
  parseContentHash,
  parseIsoTimestamp,
  type ContentHash,
  type InsightRunId,
  type IsoTimestamp,
} from "#src/domain/ids";
import {
  completeInsightRun,
  startInsightExecution,
  failInsightRun,
  provenanceFromRun,
  sameInsightRevision,
  type InsightFailureCategory,
  type InsightRecord,
  type RetainedInsightEnvelope,
  type InsightType,
} from "#src/domain/insight-record";
import { rawJsonValueSchema } from "#src/domain/json";
import {
  isLocalReview,
  isPullRequestReview,
  type Review,
} from "#src/domain/review";
import { err, type Result } from "#src/domain/result";
import type { InsightActivitySink } from "#src/adapters/codex/codex-activity";
import type { InsightStore } from "#src/adapters/storage/insight-store";
import { InsightEvidenceStore } from "#src/adapters/storage/insight-evidence-store";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import type {
  InsightEvidenceFailure,
  InsightEvidenceBundle,
} from "#src/domain/insight-evidence";
import type { ProfileStore } from "#src/adapters/storage/profile-store";
import type { ReviewSession } from "#src/domain/review-session";
import type { PreparedGuide } from "./guide-operation";
import type { ReviewSessionStore } from "#src/adapters/storage/review-session-store";
import type { ReviewStore } from "#src/adapters/storage/review-store";
import type { BriefReachComputer } from "./brief-reach-service";
import {
  postDesktopNotification,
  type DesktopNotifier,
} from "./desktop-notifier";
import type {
  Active,
  InsightCoordinatorFailure,
  InsightInvocationInput as ProviderInvocationInput,
  InsightInvoker,
  InsightRunResponse,
} from "./insight-run-coordinator";
import { validateInsightResult } from "./insight-result-validation";
import { localReviewNotificationSubject } from "./local-review-notification-subject";
import { contentHash } from "./review-artifact-hash";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";

type InsightInvocationInput = ProviderInvocationInput & {
  readonly evidence: InsightEvidenceBundle;
};

/** Announces settled runs: the notifier, and the profiles that name a local Review's checkout folder. */
export type InsightSettledNotifier = {
  readonly notifier: DesktopNotifier;
  readonly profiles: Pick<ProfileStore, "list">;
};

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
    private readonly invokers: Readonly<Record<InsightType, InsightInvoker>>,
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
    private readonly paths: PatchdeskPaths,
    private readonly diagnostics?: Pick<ReviewDiagnosticService, "record">,
    /** Counts a completed Brief's Reach block; absent leaves the block off. */
    private readonly reach?: BriefReachComputer,
    private readonly notifications?: InsightSettledNotifier,
    private readonly diagnostic?: (entry: LogEntryInput) => void,
  ) {}

  /** Preparation owns the Review lock; provider work starts only after a fresh admission check. */
  async prepareAndExecute(
    input: ProviderInvocationInput,
    session: ReviewSession,
    startedHash: ContentHash,
    controller: AbortController,
    onActivity: InsightActivitySink | undefined,
    prepare: () => Promise<
      Result<
        {
          readonly evidence: InsightEvidenceBundle;
          readonly guide?: PreparedGuide;
        },
        InsightFailureCategory | "cancelled"
      >
    >,
  ): Promise<void> {
    try {
      const prepared = await this.operations.withReviewLock(
        input.profileId,
        input.reviewId,
        async () => {
          const current = await this.reviews.load(
            input.profileId,
            input.reviewId,
          );
          if (current._tag === "err")
            return err("evidence_unavailable" as const);
          if (
            current.value.status._tag === "Terminal" ||
            current.value.currentSessionId !== session.id
          )
            return err("superseded" as const);
          const record = await this.insights.load(
            input.profileId,
            input.reviewId,
            input.type,
          );
          if (record._tag === "err") {
            // A current slot hides the legacy record, so the run was replaced rather than lost.
            const fenced =
              record.error.reason === "not_found"
                ? await this.insights.isLegacyFenced(
                    input.profileId,
                    input.reviewId,
                    input.type,
                  )
                : undefined;
            return err(
              fenced?._tag === "ok" && fenced.value
                ? ("superseded" as const)
                : ("evidence_unavailable" as const),
            );
          }
          if (record.value.activeRun?.id !== input.runId)
            return err("superseded" as const);
          if (record.value.activeRun.status === "cancelling")
            return err("cancelled" as const);
          if (controller.signal.aborted) return err("cancelled" as const);
          return prepare();
        },
      );
      if (prepared._tag === "err") {
        await this.failPreparation(input, controller, prepared.error);
        return;
      }
      const invocation = { ...input, ...prepared.value };
      await this.execute(
        invocation,
        input.type,
        input.runId,
        startedHash,
        controller,
        onActivity,
      );
    } catch {
      await this.failPreparation(input, controller, "unexpected_failure");
    } finally {
      this.active.delete(input.runId);
    }
  }

  private async failPreparation(
    input: ProviderInvocationInput,
    controller: AbortController,
    failure: InsightFailureCategory | "cancelled" | "superseded",
  ): Promise<void> {
    const at = this.now();
    await this.persistTerminal(
      input,
      input.type,
      input.runId,
      at,
      (record) =>
        failInsightRun(
          record,
          input.runId,
          {
            runId: input.runId,
            reason:
              controller.signal.aborted || failure === "cancelled"
                ? "cancelled"
                : failure === "superseded"
                  ? "superseded"
                  : "failed",
            ...definedProps({
              category:
                failure === "cancelled" || failure === "superseded"
                  ? undefined
                  : failure,
            }),
            retryable: true,
            failedAt: at,
          },
          at,
        ),
      "preparation",
    );
    if (failure !== "cancelled" && failure !== "superseded")
      await this.recordDiagnostic(input, input.type, `preparation_${failure}`);
  }

  async execute(
    input: InsightInvocationInput,
    type: InsightType,
    runId: InsightRunId,
    startedHash: ContentHash,
    controller: AbortController,
    onActivity: InsightActivitySink | undefined,
  ): Promise<void> {
    try {
      const evidenceStore = new InsightEvidenceStore(this.paths);
      const identity = input.evidence.identity;
      const matchesRun =
        identity.profileId === input.profileId &&
        identity.reviewId === input.reviewId &&
        identity.sessionId === input.sessionId &&
        identity.runId === runId &&
        identity.type === type &&
        identity.headSha === input.expectedHeadSha &&
        identity.patchHash === startedHash;
      const before = matchesRun
        ? await evidenceStore.validate(input.evidence)
        : err({
            _tag: "InsightEvidenceFailure" as const,
            reason: "evidence_mismatch" as const,
            detail: "identity_mismatch" as const,
          });
      const invocation = controller.signal.aborted
        ? err({
            reason: "cancelled" as const,
            phase: undefined,
            stderr: undefined,
          })
        : before._tag === "err"
          ? err({
              reason: insightEvidenceFailureCategory(before.error.reason),
              phase: "evidence",
              stderr: undefined,
            })
          : await this.invokePrepared(input, controller, onActivity);
      const after = await evidenceStore.validate(input.evidence);
      if (after._tag === "err") {
        await this.recordExecutionFailure(
          input,
          type,
          runId,
          insightEvidenceFailureCategory(after.error.reason),
          after.error.reason,
          after.error,
        );
        return;
      }
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
            ? invocation.error.reason
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
                    ...definedProps({
                      incompleteReason:
                        invocation._tag === "err" &&
                        "incompleteReason" in invocation.error
                          ? invocation.error.incompleteReason
                          : undefined,
                    }),
                    retryable: true,
                    failedAt: timestamp.value,
                  },
              timestamp.value,
            ),
          "invocation",
          cancelled
            ? undefined
            : before._tag === "err"
              ? before.error
              : invocation._tag === "err" &&
                  "evidenceFailure" in invocation.error
                ? invocation.error.evidenceFailure
                : undefined,
        );
        if (
          category !== undefined ||
          (invocation._tag === "err" && invocation.error.phase === "cleanup")
        ) {
          const diagnostic = insightFailureDiagnostic(
            category ?? "cancelled",
            invocation._tag === "err" ? invocation.error.phase : undefined,
            invocation._tag === "err" && "detail" in invocation.error
              ? invocation.error.detail
              : undefined,
          );
          const detail =
            invocation._tag === "err" && invocation.error.stderr !== undefined
              ? sanitizedInsightFailureDetail(invocation.error.stderr)
              : diagnostic.detail;
          await this.recordDiagnostic(
            input,
            type,
            `${input.provider}:${diagnostic.code}:${detail}`,
          );
        }
        return;
      }
      // Every invoker leaves its payload `unknown`; the JSON grammar is the contract validation needs.
      const payload = v.safeParse(rawJsonValueSchema, invocation.value);
      if (!payload.success) {
        await this.failAsInvalidResult(
          input,
          type,
          runId,
          timestamp.value,
          "payload_not_json",
        );
        return;
      }
      const validated = await validateInsightResult(
        type,
        payload.output,
        input,
        {
          sessionId: input.sessionId,
          headSha: latestSession.value.key.headSha,
          patchHash: latestHash.value,
        },
        this.reach,
        controller.signal,
      );
      if (validated._tag === "err") {
        await this.failAsInvalidResult(
          input,
          type,
          runId,
          timestamp.value,
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
              ...definedProps({ changeIntent: active.changeIntent }),
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

  private async invokePrepared(
    input: InsightInvocationInput,
    controller: AbortController,
    onActivity: InsightActivitySink | undefined,
  ): ReturnType<InsightInvoker["invoke"]> {
    const admitted = await this.operations.withReviewLock(
      input.profileId,
      input.reviewId,
      async () => {
        const review = await this.reviews.load(input.profileId, input.reviewId);
        if (review._tag === "err")
          return err({ reason: "evidence_unavailable" as const });
        if (
          review.value.status._tag === "Terminal" ||
          review.value.currentSessionId !== input.sessionId ||
          (await contentHash(input.patchPath)) !==
            input.evidence.identity.patchHash ||
          controller.signal.aborted
        )
          return err({ reason: "cancelled" as const });
        const at = this.now();
        const changed = await this.insights.mutate({
          profileId: input.profileId,
          reviewId: input.reviewId,
          type: input.type,
          now: at,
          operation: (record) => startInsightExecution(record, input.runId, at),
        });
        if (changed._tag === "err")
          return err({ reason: "execution_failed" as const });
        if (controller.signal.aborted)
          return err({ reason: "cancelled" as const });
        const active = this.active.get(input.runId);
        if (active !== undefined) active.preparing = false;
        // Keep only invocation admission under the lock, never its pending provider result.
        return {
          _tag: "ok" as const,
          value: {
            result: this.invokers[input.type].invoke(input, {
              signal: controller.signal,
              onActivity,
              onAnalysisCommandFailure:
                input.type === "analysis" &&
                input.provider === "codex-cli-account"
                  ? (failure) => {
                      void this.recordDiagnostic(
                        input,
                        "analysis",
                        `codex_first_command_failed run=${input.runId} ordinal=${failure.commandOrdinal} exit=${failure.exitCode ?? "none"} target=${failure.targetClass} class=${failure.failureClass}`,
                      );
                    }
                  : undefined,
            }),
          },
        };
      },
    );
    return admitted._tag === "err" ? admitted : admitted.value.result;
  }

  /**
   * One terminal record for every rejected payload, whether the JSON grammar
   * or the type's own schema turned it down, so the renderer shows a single
   * invalid-result state for both.
   */
  private async failAsInvalidResult(
    input: InsightInvocationInput,
    type: InsightType,
    runId: InsightRunId,
    failedAt: IsoTimestamp,
    detail: string,
  ): Promise<void> {
    await this.persistTerminal(
      input,
      type,
      runId,
      failedAt,
      (record) =>
        failInsightRun(
          record,
          runId,
          {
            runId,
            reason: "invalid_result",
            category: "invalid_result",
            retryable: true,
            failedAt,
          },
          failedAt,
        ),
      "invalid_result",
    );
    await this.recordDiagnostic(input, type, detail);
  }

  private async persistTerminal(
    input: ProviderInvocationInput,
    type: InsightType,
    runId: InsightRunId,
    at: IsoTimestamp,
    operation: (
      record: InsightRecord<unknown>,
    ) => Result<InsightRecord<unknown>, "superseded">,
    detail: string,
    evidenceFailure?: InsightEvidenceFailure,
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
          const evidence =
            detail === "completion" && input.evidence !== undefined
              ? await new InsightEvidenceStore(this.paths).validate(
                  input.evidence,
                )
              : undefined;
          let settledEvidenceFailure: InsightEvidenceFailure | undefined;
          const mutated = await this.insights.mutate({
            profileId: input.profileId,
            reviewId: input.reviewId,
            type,
            now: at,
            operation: (record) => {
              const active = record.activeRun;
              // Cancellation admitted under this lock wins over a provider result queued behind it.
              if (active?.id === runId && active.status === "cancelling") {
                return failInsightRun(
                  record,
                  runId,
                  {
                    runId,
                    reason: "cancelled",
                    retryable: true,
                    failedAt: at,
                  },
                  at,
                );
              }
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
              if (evidence?._tag === "err") {
                settledEvidenceFailure = evidence.error;
                return failInsightRun(
                  record,
                  runId,
                  {
                    runId,
                    reason: "failed",
                    category: insightEvidenceFailureCategory(
                      evidence.error.reason,
                    ),
                    retryable: true,
                    failedAt: at,
                  },
                  at,
                );
              }
              settledEvidenceFailure = evidenceFailure;
              return operation(record);
            },
          });
          // Posted inside the lock but outside the record transition, so only a persisted settlement is announced.
          if (mutated._tag === "ok") {
            if (
              settledEvidenceFailure !== undefined &&
              mutated.value.replacementFailure?.runId === runId &&
              mutated.value.replacementFailure.reason === "failed" &&
              mutated.value.replacementFailure.category ===
                insightEvidenceFailureCategory(settledEvidenceFailure.reason)
            )
              logInsightEvidenceFailure(
                this.diagnostic,
                runId,
                settledEvidenceFailure.detail ?? "tree_invalid",
              );
            const outcome = settledOutcome(mutated.value, runId);
            if (outcome !== undefined)
              await this.announceSettled(review.value, type, runId, outcome);
          }
          return mutated;
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

  /** Posts one InsightSettled notification; total, because a notification never fails the run it announces. */
  private async announceSettled(
    review: Review,
    type: InsightType,
    runId: InsightRunId,
    outcome: "completed" | "failed",
  ): Promise<void> {
    if (this.notifications === undefined) return;
    const { notifier, profiles } = this.notifications;
    const settled = {
      _tag: "InsightSettled",
      reviewId: review.id,
      insightType: type,
      outcome,
    } as const;
    if (isPullRequestReview(review)) {
      const { host, owner, repo, source } = review.identity;
      postDesktopNotification(notifier, {
        ...settled,
        pullRequest: { host, owner, repo, number: source.prNumber },
      });
      return;
    }
    if (!isLocalReview(review)) return;
    try {
      const subject = await localReviewNotificationSubject(profiles, review);
      postDesktopNotification(notifier, {
        ...settled,
        ...subject,
        requestedByAgent:
          review.agentRunRequests?.some(
            (request) =>
              request.status === "approved" && request.runId === runId,
          ) ?? false,
      });
    } catch {
      // The profile read only names the checkout folder; a failed read loses this one notification.
    }
  }

  private async recordExecutionFailure(
    input: ProviderInvocationInput,
    type: InsightType,
    runId: InsightRunId,
    category: InsightFailureCategory,
    detail:
      | "invalid_timestamp"
      | "unexpected_failure"
      | "evidence_unavailable"
      | "evidence_mismatch"
      | "invalid_input",
    evidenceFailure?: InsightEvidenceFailure,
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
        evidenceFailure,
      );
    }
    await this.recordDiagnostic(input, type, detail);
  }

  private async recordDiagnostic(
    input: ProviderInvocationInput,
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

/** A cancelled or superseded run is the maintainer's own doing or already replaced, so it settles silently. */
function settledOutcome(
  record: InsightRecord<RetainedInsightEnvelope>,
  runId: InsightRunId,
): "completed" | "failed" | undefined {
  if (record.retained?.runId === runId) return "completed";
  const failure = record.replacementFailure;
  return failure?.runId === runId &&
    (failure.reason === "failed" || failure.reason === "invalid_result")
    ? "failed"
    : undefined;
}

function safeFailureDetail(): "unexpected_failure" {
  return "unexpected_failure";
}
