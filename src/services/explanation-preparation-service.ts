import { resolve } from "node:path";
import { isAccountInsightProvider } from "#src/domain/insight-provider";
import { walkthroughPreparedInputCodec } from "#src/domain/walkthrough-preparation";

import { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import {
  guidePreparationFailure,
  type GuidePreparationResult,
} from "#src/adapters/storage/insight-artifact-job-protocol";
import { InsightStore } from "#src/adapters/storage/insight-store";
import { ProfileStore } from "#src/adapters/storage/profile-store";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { ReviewSessionStore } from "#src/adapters/storage/review-session-store";
import { ReviewStore } from "#src/adapters/storage/review-store";
import {
  guidePreparedInputCodec,
  type GuidePreparationFailureReason,
  type GuidePreparedInput,
} from "#src/domain/guide-preparation";
import {
  parseContentHash,
  parseInsightRunId,
  type IsoTimestamp,
  type ReviewId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "#src/domain/ids";
import { sessionRepresentsReview } from "#src/domain/review";
import type { ReviewSession } from "#src/domain/review-session";
import { err, ok, type Result } from "#src/domain/result";
import { stageGuideContext } from "./guide-context-capture";
import { contentHash } from "./review-artifact-hash";
import { guideSettleCode } from "./guide-preparation-runtime";
import { explanationEvidenceReference } from "./explanation-evidence-reference";
import type { InsightEvidenceReference } from "./insight-evidence-reference";
import type {
  InsightAdmissionInput,
  InsightAdmittedRun,
} from "./insight-slot-admission";
import type { InsightResourceBundle } from "./insight-resource-bundle";
import { InsightSlotAuthority } from "./insight-slot-authority";
import {
  isTerminalStatus,
  type InsightJournalStatus,
  type InsightSlotFailure,
  type InsightSlotKey,
} from "./insight-slot-records";
import type { Active } from "./insight-run-coordinator";
import type { ReviewContextPackService } from "./review-context-pack-service";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";

/** The exact Review revision and selection one preparation is admitted for; selection never authorizes dispatch. */
export type GuidePreparationRequest = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  /** The Review's `updatedAt` the caller observed; checked once, at admission. */
  readonly revision: string;
  readonly sessionId: ReviewSessionId;
  readonly expectedHash: string;
  readonly selection: InsightAdmissionInput["selection"];
};

/** One running preparation; `result` settles after the job, installation and any durable settlement have finished. */
export type GuidePreparationOperation = {
  readonly result: Promise<GuidePreparationResult>;
  /**
   * Settles once admission is decided: the run the slot now names (also when an uncertain admission left it owned), or
   * the reason no run was admitted. Callers that must report a run identity wait for this, not for `result`.
   */
  readonly admission: Promise<
    Result<AdmittedRun, GuidePreparationFailureReason>
  >;
  /**
   * Records cancellation durably, and only then aborts the job and joins it. A prepared run is settled cancelled and
   * released. A storage failure or unknown outcome returns `unsettled`, leaves the run owned and the job running, and a
   * later call retries; only a success is remembered.
   */
  cancel(): Promise<Result<void, "unsettled">>;
  /** Stops the job without recording anything; used by shutdown, where recovery settles the run on the next launch. */
  abort(): void;
  /** Whether this process still owns an admitted run, which is until its durable settlement is confirmed. */
  owned(): boolean;
};

type Observation = {
  readonly session: ReviewSession;
  readonly sourcePath: string;
};

export type AdmittedRun = InsightSlotKey & InsightAdmittedRun;

/**
 * Prepares immutable Guide or Walkthrough inputs in a destination scope: admits a current-format run, captures run
 * owned context outside the Review lock, lets the job worker build and verify everything, then installs the verified
 * root with one short fenced transaction. No provider is reachable from here.
 */
export class ExplanationPreparationService {
  private readonly reviews: ReviewStore;
  private readonly sessions: ReviewSessionStore;
  private readonly profiles: ProfileStore;
  private readonly slots: InsightSlotAuthority;
  private readonly artifacts: InsightArtifactStore;

  /** Run ownership for the destination scope: the coordinator of that scope shares this map, so it sees live preparations. */
  private readonly owned: Map<string, Active>;

  constructor(
    private readonly source: PatchdeskPaths,
    private readonly destination: PatchdeskPaths,
    private readonly resources: InsightResourceBundle,
    private readonly operations: ReviewOperationCoordinator,
    private readonly pack: Pick<
      ReviewContextPackService,
      "captureRunContext" | "captureChangedHeadFiles"
    >,
    now: () => IsoTimestamp,
    /** The scope's one authority: sharing it keeps preparation, generation and cancel on the same journal locks. */
    authority?: InsightSlotAuthority,
  ) {
    this.owned = resources.ownership.forScope(destination.dataDirectory());
    this.reviews = new ReviewStore(source);
    this.sessions = new ReviewSessionStore(source);
    this.profiles = new ProfileStore(source);
    this.slots =
      authority ??
      new InsightSlotAuthority(
        destination,
        resources.authorityReader,
        new InsightStore(destination, resources.authorityReader),
        operations,
        now,
      );
    this.artifacts = new InsightArtifactStore(
      destination,
      resources.authorityReader,
    );
  }

  /** Starts one preparation; the caller owns the returned operation until its result settles. */
  begin(
    request: GuidePreparationRequest,
    kind: "guide" | "walkthrough" = "guide",
  ): GuidePreparationOperation {
    const controller = new AbortController();
    let admitted: AdmittedRun | undefined;
    let cancelled = false;
    let cancelling: Promise<Result<void, "unsettled">> | undefined;
    let announce: (
      decided: Result<AdmittedRun, GuidePreparationFailureReason>,
    ) => void = () => undefined;
    const admission = new Promise<
      Result<AdmittedRun, GuidePreparationFailureReason>
    >((resolve) => {
      announce = resolve;
    });
    const isOwned = (): boolean =>
      admitted !== undefined && this.owned.has(admitted.runId);
    /** True once storage confirms the run is settled or no longer named by the slot; only then is ownership released. */
    const settleDurably = async (
      run: AdmittedRun,
      act: () => Promise<
        Result<{ readonly status: InsightJournalStatus }, InsightSlotFailure>
      >,
    ): Promise<boolean> => {
      try {
        const settled = await act();
        if (
          (settled._tag === "ok" && isTerminalStatus(settled.value.status)) ||
          (settled._tag === "err" && settled.error === "not_active")
        ) {
          this.owned.delete(run.runId);
          return true;
        }
      } catch {
        // A thrown storage error is an unknown outcome: ownership stays and a retry reconciles.
      }
      return false;
    };
    const result = this.prepare(request, kind, controller, (run) => {
      admitted = run;
      announce(ok(run));
    })
      .catch(() =>
        guidePreparationFailure(controller.signal.aborted ? "aborted" : "io"),
      )
      .then(async (outcome) => {
        const run = admitted;
        // A failure before admission names no run; `announce` is a no-op once a run was announced.
        if (run === undefined && outcome._tag === "err")
          announce(err(outcome.error.reason));
        if (outcome._tag === "ok" || run === undefined) return outcome;
        const code = guideSettleCode(outcome.error.reason);
        return (await settleDurably(run, () =>
          this.slots.settleRun({ ...run, code, phase: "capture" }),
        ))
          ? outcome
          : guidePreparationFailure("unsettled");
      });
    return {
      result,
      admission,
      abort: () => controller.abort(),
      owned: isOwned,
      cancel: () => {
        if (cancelled) return Promise.resolve(ok(undefined));
        cancelling ??= (async () => {
          try {
            const run = admitted;
            if (run !== undefined && this.owned.has(run.runId)) {
              // Durable first: no signal reaches the job until the cancel epoch is recorded.
              const durable = await settleDurably(run, () =>
                this.slots.cancelRun(run, async () => ok(undefined)),
              );
              if (!durable) return err("unsettled" as const);
            }
            controller.abort();
            await result;
            // A failed settlement inside `result` leaves the run owned, so cancellation is not yet confirmed.
            if (isOwned()) return err("unsettled" as const);
            cancelled = true;
            return ok(undefined);
          } finally {
            cancelling = undefined;
          }
        })();
        return cancelling;
      },
    };
  }

  private async prepare(
    request: GuidePreparationRequest,
    kind: "guide" | "walkthrough",
    controller: AbortController,
    onAdmitted: (run: AdmittedRun) => void,
  ): Promise<GuidePreparationResult> {
    if (
      request.selection?.provider === undefined ||
      !isAccountInsightProvider(request.selection.provider)
    )
      return guidePreparationFailure("invalid_source");
    const signal = controller.signal;
    const before = await this.observe(request, request.revision);
    if (before._tag === "err") return guidePreparationFailure(before.error);
    const patchHash = parseContentHash(request.expectedHash);
    if (patchHash._tag === "err")
      return guidePreparationFailure("invalid_source");
    if (signal.aborted) return guidePreparationFailure("aborted");
    const key = {
      profileId: request.profileId,
      reviewId: request.reviewId,
      type: kind,
    } as const;
    // Both guards run under the authority's Review lock, so they must not take that lock again.
    const unchanged = async (): Promise<
      Result<void, GuidePreparationFailureReason>
    > => {
      const after = await this.readRepresented(request, undefined);
      if (after._tag === "err") return after;
      return after.value.session.key.headSha ===
        before.value.session.key.headSha &&
        after.value.session.key.baseSha === before.value.session.key.baseSha
        ? ok(undefined)
        : err("stale_source");
    };
    const admitted = await this.slots.admitRun({
      ...key,
      sessionId: request.sessionId,
      source: before.value.session.key.source,
      baseSha: before.value.session.key.baseSha,
      headSha: before.value.session.key.headSha,
      patchHash: patchHash.value,
      selection: request.selection,
      possibleSpendAcknowledged: false,
      inProcess: this.owned,
      // The authority calls this under its locks, also when an admission outcome is unknown, so the full identity is
      // kept and the run stays owned until `begin` settles it (or storage shows the slot never named it).
      claim: (named) => {
        const id = parseInsightRunId(named.runId);
        if (id._tag === "ok")
          this.owned.set(named.runId, {
            ...key,
            runId: id.value,
            controller,
            preparing: true,
          });
        onAdmitted({ ...key, ...named });
      },
      represented: unchanged,
    });
    if (admitted._tag === "err")
      return guidePreparationFailure(
        admitted.error === "already_running"
          ? "busy"
          : admitted.error === "stale_source" ||
              admitted.error === "invalid_source"
            ? admitted.error
            : "io",
      );
    const run: AdmittedRun = { ...key, ...admitted.value };
    if (signal.aborted) return guidePreparationFailure("aborted");
    const prepared = await this.runJob(request, run, before.value, signal);
    if (prepared._tag === "err") return prepared;
    const installed =
      kind === "guide"
        ? await this.slots.installGuidePreparation(
            { ...run, guidePreparation: prepared.value.root },
            unchanged,
          )
        : await this.slots.installWalkthroughPreparation(
            { ...run, walkthroughPreparation: prepared.value.root },
            unchanged,
          );
    if (installed._tag === "err")
      return guidePreparationFailure(
        installed.error === "not_active"
          ? "aborted"
          : installed.error === "stale_source" ||
              installed.error === "invalid_source"
            ? installed.error
            : "io",
      );
    return prepared;
  }

  /** Bulk work: no Review or slot lock is held while context is acquired or the worker builds and verifies the inputs. */
  private async runJob(
    request: GuidePreparationRequest,
    run: AdmittedRun,
    before: Observation,
    signal: AbortSignal,
  ): Promise<GuidePreparationResult> {
    const destinationReview = this.destination.reviewDirectory(
      request.profileId,
      request.reviewId,
    );
    const context = await stageGuideContext(
      this.pack,
      before.session,
      destinationReview,
      run.runId,
      signal,
    );
    if (context._tag === "err")
      return guidePreparationFailure(
        context.error === "context_unavailable"
          ? "context_unavailable"
          : context.error,
      );
    try {
      // Acquisition above was joined, not cancelled; a stop requested meanwhile takes effect here.
      if (signal.aborted) return guidePreparationFailure("aborted");
      const permit = await this.resources.permits.capture(
        `${run.type}-preparation:${request.profileId}:${request.reviewId}`,
        signal,
      );
      if (permit._tag === "err")
        return guidePreparationFailure(
          permit.error === "aborted" ? "aborted" : "busy",
        );
      try {
        const job = await (
          run.type === "guide"
            ? this.resources.jobs.prepareGuide
            : this.resources.jobs.prepareWalkthrough
        )(
          {
            sourceRoot: this.source.dataDirectory(),
            sourcePath: before.sourcePath,
            destinationRoot: this.destination.dataDirectory(),
            destinationReview,
            profileId: request.profileId,
            reviewId: request.reviewId,
            sessionId: request.sessionId,
            expectedHash: request.expectedHash,
            runId: run.runId,
            headSha: before.session.key.headSha,
            baseSha: before.session.key.baseSha,
            binding: run.binding,
            contextPath: context.value.path,
            contextHash: context.value.sha256,
            contextBytes: context.value.bytes,
          },
          { signal },
        );
        if (job._tag === "err") return job;
        // The job verified what it stored; the host confirms the root it will install names this run's Binding.
        const stored =
          run.type === "guide"
            ? await this.artifacts.readObject(
                request.profileId,
                request.reviewId,
                guidePreparedInputCodec,
                job.value.root,
              )
            : await this.artifacts.readObject(
                request.profileId,
                request.reviewId,
                walkthroughPreparedInputCodec,
                job.value.root,
              );
        return stored._tag === "ok" &&
          stored.value.binding.hash === run.binding.hash
          ? job
          : guidePreparationFailure("io");
      } finally {
        permit.value.release();
      }
    } finally {
      await context.value.discard();
    }
  }

  /** Projects the stored evidence manifest onto the reference the child verifies file by file. */
  evidenceReference(
    prepared: GuidePreparedInput,
    sessionId: ReviewSessionId,
    run: Pick<AdmittedRun, "profileId" | "reviewId" | "runId">,
  ): Promise<InsightEvidenceReference | undefined> {
    return explanationEvidenceReference(
      this.artifacts,
      this.destination,
      prepared,
      sessionId,
      run,
    );
  }

  /**
   * For a caller that holds the Review lock: the Review is open on the same session and the session's head, base and
   * patch are the ones the run represents. An ordinary refresh timestamp does not count as a change.
   */
  async representedInputs(
    request: GuidePreparationRequest,
    expected: { readonly headSha: string; readonly baseSha: string },
  ): Promise<Result<void, GuidePreparationFailureReason>> {
    const current = await this.readRepresented(request, undefined);
    if (current._tag === "err") return current;
    return current.value.session.key.headSha === expected.headSha &&
      current.value.session.key.baseSha === expected.baseSha
      ? ok(undefined)
      : err("stale_source");
  }

  /** Short Review-locked read of the represented session. */
  private observe(
    request: GuidePreparationRequest,
    revision: string | undefined,
  ): Promise<Result<Observation, GuidePreparationFailureReason>> {
    return this.operations.withReviewLock(
      request.profileId,
      request.reviewId,
      () => this.readRepresented(request, revision),
    );
  }

  /** Ordinary refresh timestamps do not invalidate unchanged represented content; the caller holds the Review lock. */
  private async readRepresented(
    request: GuidePreparationRequest,
    revision: string | undefined,
  ): Promise<Result<Observation, GuidePreparationFailureReason>> {
    const [profile, review] = await Promise.all([
      this.profiles.load(request.profileId),
      this.reviews.load(request.profileId, request.reviewId),
    ]);
    if (
      profile._tag === "err" ||
      profile.value.id !== request.profileId ||
      review._tag === "err"
    )
      return err("invalid_source");
    if (
      review.value.status._tag !== "Open" ||
      review.value.currentSessionId !== request.sessionId ||
      (revision !== undefined && review.value.updatedAt !== revision)
    )
      return err("stale_source");
    const session = await this.sessions.load(
      request.profileId,
      request.sessionId,
    );
    if (
      session._tag === "err" ||
      !sessionRepresentsReview(review.value, session.value)
    )
      return err("invalid_source");
    const sourcePath = this.source.patchFile(
      request.profileId,
      request.sessionId,
    );
    // GitHub's canonical rendering can differ from the captured local-worktree patch.
    if (
      resolve(session.value.patchPath) !== resolve(sourcePath) ||
      (await contentHash(sourcePath)) !== request.expectedHash
    )
      return err("stale_source");
    return ok({ session: session.value, sourcePath });
  }
}
