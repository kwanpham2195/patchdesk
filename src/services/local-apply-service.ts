import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { InsightStore } from "../adapters/storage/insight-store";
import type { LocalApplyOperationStore } from "../adapters/storage/local-apply-operation-store";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type {
  FindingId,
  InsightRunId,
  IsoTimestamp,
  ReviewId,
  WorkspaceProfileId,
} from "../domain/ids";
import {
  decideLocalApplyRecovery,
  type LocalApplyOperation,
  type LocalApplyRecoveryDecision,
} from "../domain/local-apply-operation";
import { definedProps } from "../domain/defined-props";
import { err, ok, type Result } from "../domain/result";
import { isLocalReview, type Review } from "../domain/review";
import type { LocalReviewSource } from "../domain/review-source";
import type { AppLogService } from "./app-log-service";
import {
  findWorkingTreeConversion,
  resolveCheckoutRoot,
} from "./local-apply-checkout";
import {
  composeLocalApply,
  loadVerifiedEdits,
  type ComposedApply,
} from "./local-apply-composition";
import {
  markLocalApplyDraftsApplied,
  observeLocalApplyFiles,
} from "./local-apply-settlement";
import { resolveLocalReviewCheckout } from "./local-checkout";
import type { LocalReviewOpening } from "./local-review-opening";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type { ReviewWorkbenchProjection } from "./review-workbench-projection";
import type {
  LocalWriteGateFailure,
  ReviewWriteExpectation,
  ReviewWriteGate,
} from "./review-write-gate";
import type { GitReadExecutor } from "./review-worktree-service";

/** Identity only: the main process derives every range and replacement (ADR 0048). */
export type LocalApplyRequest = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly runId: InsightRunId;
  readonly findingIds: ReadonlyArray<FindingId>;
  readonly expected: ReviewWriteExpectation;
};

export type LocalApplyFailure = {
  readonly reason:
    | LocalWriteGateFailure["reason"]
    | "not_working_tree"
    /** An earlier Apply on this Review is not settled; recovery must run first. */
    | "apply_locked"
    | "in_progress"
    /** A Finding is missing, dismissed, from another run, or has no verified suggestion. */
    | "not_applicable"
    | "overlapping"
    /** A path leaves the checkout, passes through a symlink, or is not a regular file. */
    | "path_refused"
    /** A file no longer holds the lines its suggestion was verified against, or is not UTF-8. */
    | "file_changed"
    /** `git apply --check` refused the composed patch; nothing was written. */
    | "check_failed"
    /** Git would convert line endings or run a filter when writing a file, so its bytes could not be confirmed. */
    | "working_tree_conversion";
};

export type LocalApplyOutcome =
  | {
      readonly status: "applied";
      /** Absent when the next session could not be prepared; the Apply is still confirmed. */
      readonly workbench?: ReviewWorkbenchProjection;
    }
  | { readonly status: "outcome_unknown" };

export type LocalApplyRecoveryOutcome = {
  readonly decision: LocalApplyRecoveryDecision | "none";
  readonly workbench?: ReviewWorkbenchProjection;
};

type LocalApplyDependencies = {
  readonly gate: Pick<ReviewWriteGate, "requireFreshLocal">;
  readonly operations: Pick<
    LocalApplyOperationStore,
    "load" | "begin" | "save" | "remove" | "listReviews"
  >;
  readonly insights: Pick<InsightStore, "loadTyped">;
  readonly reviews: Pick<ReviewStore, "load" | "save">;
  readonly profiles: Pick<ProfileStore, "load" | "list">;
  readonly opening: Pick<LocalReviewOpening, "openLocked">;
  readonly coordinator: Pick<
    ReviewOperationCoordinator,
    "acquire" | "release" | "withReviewLock"
  >;
  /** Runs `git apply` on the maintainer's checkout; no other git write happens here. */
  readonly git: GitReadExecutor;
  readonly paths: PatchdeskPaths;
  readonly logs: Pick<AppLogService, "write">;
  readonly now: () => IsoTimestamp;
};

/**
 * Applies a set of verified Finding suggestions to a working-tree checkout
 * with `git apply` (ADR 0050 "Git writes"), under the ADR 0035 contract:
 * durable intent first, outcome-unknown immediately before the write, and
 * confirmation from file hashes before success is reported.
 */
export class LocalApplyService {
  constructor(private readonly dependencies: LocalApplyDependencies) {}

  async apply(
    request: LocalApplyRequest,
  ): Promise<Result<LocalApplyOutcome, LocalApplyFailure>> {
    const key = `${request.profileId}:${request.reviewId}`;
    if (!this.dependencies.coordinator.acquire(key))
      return err({ reason: "in_progress" });
    try {
      return await this.applyLocked(request);
    } finally {
      this.dependencies.coordinator.release(key);
    }
  }

  /** The explicit check: reads file hashes only and never applies again. */
  async recover(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<LocalApplyRecoveryOutcome, LocalApplyFailure>> {
    const key = `${profileId}:${reviewId}`;
    if (!this.dependencies.coordinator.acquire(key))
      return err({ reason: "in_progress" });
    try {
      return await this.recoverLocked(profileId, reviewId, "check");
    } finally {
      this.dependencies.coordinator.release(key);
    }
  }

  /** Settles every Apply a previous run of the app left unsettled. */
  async recoverAll(): Promise<void> {
    const profiles = await this.dependencies.profiles.list();
    if (profiles._tag === "err") return;
    // Each Review settles under its own lock, so they need no ordering among themselves.
    await Promise.all(
      profiles.value.map(async (profile) => {
        const reviewIds = await this.dependencies.operations.listReviews(
          profile.id,
        );
        if (reviewIds._tag === "err") return;
        await Promise.all(
          reviewIds.value.map((reviewId) =>
            this.dependencies.coordinator
              .withReviewLock(profile.id, reviewId, () =>
                this.recoverLocked(profile.id, reviewId, "startup"),
              )
              // One Review's failed recovery must not keep the local API from starting; its record stays for the next start or a check.
              .catch(() => {
                this.dependencies.logs.write({
                  process: "main",
                  level: "warn",
                  topic: "local-apply",
                  message: "Local apply recovery failed",
                  profileId: profile.id,
                  meta: { reviewId },
                });
              }),
          ),
        );
      }),
    );
  }

  private async applyLocked(
    request: LocalApplyRequest,
  ): Promise<Result<LocalApplyOutcome, LocalApplyFailure>> {
    const { profileId, reviewId } = request;
    const existing = await this.dependencies.operations.load(
      profileId,
      reviewId,
    );
    if (existing._tag === "err") return err({ reason: "storage" });
    if (existing.value !== undefined && existing.value.state !== "Confirmed")
      return err({ reason: "apply_locked" });
    const fresh = await this.dependencies.gate.requireFreshLocal(
      profileId,
      reviewId,
      request.expected,
    );
    if (fresh._tag === "err") return fresh;
    const { review, session, checkoutPath } = fresh.value;
    if (review.identity.source.kind !== "working_tree")
      return err({ reason: "not_working_tree" });
    const edits = await loadVerifiedEdits(
      this.dependencies.insights,
      request,
      session.patchPath,
    );
    if (edits._tag === "err") return edits;
    const composed = await composeLocalApply(
      this.dependencies.git,
      checkoutPath,
      edits.value,
    );
    if (composed._tag === "err") return composed;
    const conversion = await findWorkingTreeConversion(
      this.dependencies.git,
      composed.value.root,
      composed.value.files.map((file) => file.path),
    );
    if (conversion._tag === "unreadable")
      return err({ reason: "checkout_unavailable" });
    if (conversion._tag === "converts")
      return err({ reason: "working_tree_conversion" });
    const now = this.dependencies.now();
    const intent: LocalApplyOperation = {
      schemaVersion: 1,
      profileId,
      reviewId,
      sessionId: session.id,
      headSha: session.key.headSha,
      analysisRunId: request.runId,
      findingIds: request.findingIds,
      files: composed.value.files,
      state: "Requested",
      requestedAt: now,
      updatedAt: now,
    };
    const begun = await this.dependencies.operations.begin(intent);
    if (begun._tag === "err")
      return err({
        reason:
          begun.error._tag === "LocalApplyOperationExists"
            ? "apply_locked"
            : "storage",
      });
    return this.write(intent, composed.value, review);
  }

  private async write(
    intent: LocalApplyOperation,
    composed: ComposedApply,
    review: Review<LocalReviewSource>,
  ): Promise<Result<LocalApplyOutcome, LocalApplyFailure>> {
    const { profileId, reviewId } = intent;
    const scratchRoot =
      this.dependencies.paths.localApplyScratchDirectory(profileId);
    let scratch: string | undefined;
    try {
      await mkdir(scratchRoot, { recursive: true });
      scratch = await mkdtemp(join(scratchRoot, "apply-"));
      const patchFile = join(scratch, "suggestions.patch");
      await writeFile(patchFile, composed.patch);
      const apply = (check: boolean) =>
        this.dependencies.git.run([
          "git",
          "-C",
          composed.root,
          "apply",
          ...(check ? ["--check"] : []),
          // The maintainer's `apply.whitespace` setting must not rewrite the replacement.
          "--whitespace=nowarn",
          patchFile,
        ]);
      const checked = await apply(true);
      const unchanged = await observeLocalApplyFiles(
        composed.root,
        intent.files,
      );
      if (
        checked._tag === "err" ||
        decideLocalApplyRecovery(intent.files, unchanged) !== "not_applied"
      ) {
        await this.dependencies.operations.remove(profileId, reviewId);
        return err({
          reason: checked._tag === "err" ? "check_failed" : "file_changed",
        });
      }
      const unknown = this.transition(intent, "OutcomeUnknown");
      if ((await this.dependencies.operations.save(unknown))._tag === "err") {
        await this.dependencies.operations.remove(profileId, reviewId);
        return err({ reason: "storage" });
      }
      const applied = await apply(false);
      const observed = await observeLocalApplyFiles(
        composed.root,
        intent.files,
      );
      if (
        applied._tag === "err" ||
        decideLocalApplyRecovery(intent.files, observed) !== "confirmed"
      ) {
        this.log("warn", "Local apply outcome unknown", intent, {});
        return ok({ status: "outcome_unknown" });
      }
      return ok(await this.confirm(unknown, review, "write"));
    } catch {
      // A failure before the outcome-unknown mark means `git apply` never ran.
      const stored = await this.dependencies.operations.load(
        profileId,
        reviewId,
      );
      if (stored._tag === "ok" && stored.value?.state === "Requested") {
        await this.dependencies.operations.remove(profileId, reviewId);
        return err({ reason: "storage" });
      }
      return ok({ status: "outcome_unknown" });
    } finally {
      if (scratch !== undefined)
        await rm(scratch, { recursive: true, force: true }).catch(
          () => undefined,
        );
    }
  }

  /**
   * Persists confirmation, marks the drafted Findings it wrote as applied, then
   * prepares the next session through the local open path, which carries the
   * other Local drafts. Both are bookkeeping: a failure leaves the Apply
   * confirmed, and the stale session's Findings cannot apply again because
   * the freshness gate sees the changed checkout.
   */
  private async confirm(
    operation: LocalApplyOperation,
    review: Review<LocalReviewSource>,
    trigger: "write" | "check" | "startup",
  ): Promise<LocalApplyOutcome> {
    const confirmed = this.transition(operation, "Confirmed");
    // Success is reported only after confirmation is durable (ADR 0035).
    if ((await this.dependencies.operations.save(confirmed))._tag === "err")
      return { status: "outcome_unknown" };
    this.log("info", "Local apply confirmed", operation, { trigger });
    if (
      !(await markLocalApplyDraftsApplied(
        this.dependencies.reviews,
        operation,
        this.dependencies.now(),
      ).catch(() => false))
    )
      this.log("warn", "Local apply drafts not marked applied", operation, {});
    const next = await this.dependencies.opening
      .openLocked(
        {
          profileId: operation.profileId,
          repository: {
            host: review.identity.host,
            owner: review.identity.owner,
            repo: review.identity.repo,
          },
          request: {
            kind: "working_tree",
            ...definedProps({ checkout: review.identity.source.checkout }),
          },
        },
        operation.reviewId,
      )
      .catch(() => undefined);
    await this.dependencies.operations.remove(
      operation.profileId,
      operation.reviewId,
    );
    if (next?._tag === "ok")
      return { status: "applied", workbench: next.value };
    this.log("warn", "Local apply next session not prepared", operation, {});
    return { status: "applied" };
  }

  private async recoverLocked(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    trigger: "check" | "startup",
  ): Promise<Result<LocalApplyRecoveryOutcome, LocalApplyFailure>> {
    const stored = await this.dependencies.operations.load(profileId, reviewId);
    if (stored._tag === "err") return err({ reason: "storage" });
    const operation = stored.value;
    if (operation === undefined) return ok({ decision: "none" });
    // An intent never marked outcome-unknown means `git apply` never started.
    if (operation.state === "Requested" || operation.state === "Confirmed") {
      await this.dependencies.operations.remove(profileId, reviewId);
      const decision =
        operation.state === "Confirmed" ? "confirmed" : "not_applied";
      this.log("info", "Local apply recovery decided", operation, {
        decision,
        trigger,
      });
      return ok({ decision });
    }
    const [profile, review] = await Promise.all([
      this.dependencies.profiles.load(profileId),
      this.dependencies.reviews.load(profileId, reviewId),
    ]);
    if (
      profile._tag === "err" ||
      review._tag === "err" ||
      !isLocalReview(review.value)
    )
      return err({ reason: "storage" });
    const localReview = review.value;
    const checkout = await resolveLocalReviewCheckout(
      this.dependencies,
      profile.value,
      localReview.identity,
      localReview.identity.source.checkout,
    );
    const root =
      checkout._tag === "err"
        ? undefined
        : await resolveCheckoutRoot(
            this.dependencies.git,
            checkout.value.checkoutPath,
          );
    const observed =
      root === undefined
        ? operation.files.map(() => undefined)
        : await observeLocalApplyFiles(root, operation.files);
    const decision = decideLocalApplyRecovery(operation.files, observed);
    this.log(
      decision === "check_required" ? "warn" : "info",
      "Local apply recovery decided",
      operation,
      { decision, trigger },
    );
    if (decision === "not_applied") {
      await this.dependencies.operations.remove(profileId, reviewId);
      return ok({ decision });
    }
    if (decision === "check_required") {
      if (operation.state !== "CheckRequired")
        await this.dependencies.operations.save(
          this.transition(operation, "CheckRequired"),
        );
      return ok({ decision });
    }
    const confirmed = await this.confirm(operation, localReview, trigger);
    if (confirmed.status === "outcome_unknown")
      return err({ reason: "storage" });
    return ok({
      decision,
      ...definedProps({ workbench: confirmed.workbench }),
    });
  }

  private transition(
    operation: LocalApplyOperation,
    state: LocalApplyOperation["state"],
  ): LocalApplyOperation {
    return { ...operation, state, updatedAt: this.dependencies.now() };
  }

  private log(
    level: "info" | "warn",
    message: string,
    operation: LocalApplyOperation,
    meta: { readonly decision?: string; readonly trigger?: string },
  ): void {
    this.dependencies.logs.write({
      process: "main",
      level,
      topic: "local-apply",
      message,
      profileId: operation.profileId,
      sessionId: operation.sessionId,
      meta: {
        reviewId: operation.reviewId,
        files: operation.files.length,
        findings: operation.findingIds.length,
        ...meta,
      },
    });
  }
}
