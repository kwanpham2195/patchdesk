import { readdir } from "node:fs/promises";

import {
  parseIsoTimestamp,
  parseWorkspaceProfileId,
  type IsoTimestamp,
  type ReviewId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import { failInsightRun, type InsightType } from "../domain/insight-record";
import { mapConcurrent } from "../domain/map-concurrent";
import { err, ok, type Result } from "../domain/result";
import type { InsightStore } from "../adapters/storage/insight-store";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ReviewStore } from "../adapters/storage/review-store";
import type {
  Active,
  InsightCoordinatorFailure,
  InsightRunResponse,
} from "./insight-run-coordinator";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";

/**
 * Fails the Insight runs a crash left marked active, one Review at a time and
 * across every profile at startup, so a restart never leaves a run stuck.
 */
export class InsightRecovery {
  constructor(
    private readonly reviews: Pick<ReviewStore, "list">,
    private readonly insights: Pick<InsightStore, "load" | "mutate">,
    private readonly paths: PatchdeskPaths,
    private readonly operations: ReviewOperationCoordinator,
    private readonly active: ReadonlyMap<string, Active>,
    private readonly now: () => IsoTimestamp,
    private readonly diagnostics?: Pick<ReviewDiagnosticService, "record">,
  ) {}

  async recover(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly type: InsightType;
  }): Promise<
    Result<InsightRunResponse | undefined, InsightCoordinatorFailure>
  > {
    return this.operations.withReviewLock(input.profileId, input.reviewId, () =>
      this.recoverUnlocked(input),
    );
  }

  private async recoverUnlocked(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly type: InsightType;
  }): Promise<
    Result<InsightRunResponse | undefined, InsightCoordinatorFailure>
  > {
    const record = await this.insights.load(
      input.profileId,
      input.reviewId,
      input.type,
    );
    if (record._tag === "err")
      return record.error.reason === "not_found"
        ? ok(undefined)
        : err("storage_unavailable");
    const active = record.value.activeRun;
    if (active === undefined || this.active.has(active.id))
      return active === undefined
        ? ok(undefined)
        : ok({ runId: active.id, type: input.type, status: active.status });
    const timestamp = parseIsoTimestamp(this.now());
    if (timestamp._tag === "err") return err("storage_unavailable");
    const failed = await this.insights.mutate({
      profileId: input.profileId,
      reviewId: input.reviewId,
      type: input.type,
      now: timestamp.value,
      operation: (current) =>
        failInsightRun(
          current,
          active.id,
          {
            runId: active.id,
            reason: "failed",
            category: "unexpected_failure",
            retryable: true,
            failedAt: timestamp.value,
          },
          timestamp.value,
        ),
    });
    if (failed._tag === "err") return err("storage_unavailable");
    return ok({
      runId: active.id,
      type: input.type,
      status: "failed",
      failureReason: "failed",
    });
  }

  async recoverAll(): Promise<void> {
    let profileEntries: ReadonlyArray<string>;
    try {
      profileEntries = await readdir(this.paths.dataProfilesDirectory());
    } catch {
      return;
    }
    const profileIds = profileEntries.flatMap((entry) => {
      const profileId = parseWorkspaceProfileId(entry);
      return profileId._tag === "ok" ? [profileId.value] : [];
    });
    const listed = await mapConcurrent(profileIds, 4, async (profileId) => ({
      profileId,
      reviews: await this.reviews.list(profileId),
    }));
    await mapConcurrent(
      listed.filter((entry) => entry.reviews._tag === "err"),
      4,
      async ({ profileId }) =>
        this.recordRecoveryDiagnostic(
          profileId,
          undefined,
          "review_list_failed",
        ),
    );
    const recoveryTargets = listed.flatMap(({ profileId, reviews }) =>
      reviews._tag === "ok"
        ? reviews.value.flatMap((review) =>
            (["analysis", "walkthrough", "brief"] as const).map((type) => ({
              profileId,
              review,
              type,
            })),
          )
        : [],
    );
    await mapConcurrent(recoveryTargets, 8, async (target) => {
      const recovered = await this.recover({
        profileId: target.profileId,
        reviewId: target.review.id,
        type: target.type,
      });
      if (recovered._tag === "err")
        await this.recordRecoveryDiagnostic(
          target.profileId,
          target.review.currentSessionId,
          `${target.type}_recovery_failed`,
        );
    });
  }

  private async recordRecoveryDiagnostic(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId | undefined,
    detail: string,
  ): Promise<void> {
    try {
      await this.diagnostics?.record(
        sessionId === undefined
          ? {
              profileId,
              category: "recovery",
              phase: "insight-recovery-failed",
              retryable: true,
              detail,
            }
          : {
              profileId,
              sessionId,
              category: "recovery",
              phase: "insight-recovery-failed",
              retryable: true,
              detail,
            },
      );
    } catch {
      // Diagnostics are best effort and never become an unhandled rejection.
    }
  }
}
