import { err, ok, type Result } from "../domain/result";
import type { ReviewWorkflowStarter } from "./review-workflow-starter";
import {
  ReviewRunRegistry,
  type OwnedRun,
  type RunOwnership,
} from "./review-run-registry";
import {
  appendRunActivity,
  type ReviewActivityStep,
  type ReviewRunMetadata,
  type SafeRunProjection,
} from "./run-projection";

export type ReviewRunStartInput = RunOwnership & {
  readonly profileId: string;
  readonly metadata?: ReviewRunMetadata;
};

export type ReviewRunObservation = RunOwnership & {
  readonly runId: string;
};

export type ReviewRunObservationFailure = {
  readonly _tag: "RunNotOwned";
};

type WorkflowStarter = Pick<ReviewWorkflowStarter, "start">;

/**
 * Owns explicit review execution independently from observation.
 *
 * A session/attempt pair is a first-writer-wins idempotency key for the
 * lifetime of this coordinator. The Flue-owned run ID and failure details stay
 * behind this boundary; observers receive only Patchdesk's coarse projection.
 */
export class ReviewRunCoordinator {
  private readonly startedAt = new Map<string, number>();

  constructor(
    private readonly workflow: WorkflowStarter,
    private readonly runs = new ReviewRunRegistry(),
    private readonly now: () => number = Date.now,
    private readonly nowIso: () => string = () => new Date().toISOString(),
  ) {}

  start(input: ReviewRunStartInput): OwnedRun {
    const owner = ownership(input);
    const existing = this.runs.find(owner);
    if (existing !== undefined) return existing;

    const run = this.runs.create(owner, input.metadata);
    this.startedAt.set(run.runId, this.now());
    void this.execute(run, input);
    return this.runs.find(owner) ?? run;
  }

  observe(
    input: ReviewRunObservation,
  ): Result<SafeRunProjection, ReviewRunObservationFailure> {
    const owned = this.runs.get(input.runId, input);
    if (owned._tag === "err") return err(owned.error);

    const projection = this.withCurrentElapsed(owned.value);
    if (projection !== owned.value.projection) {
      this.runs.update(input.runId, projection);
    }
    return ok(projection);
  }

  private async execute(
    run: OwnedRun,
    input: ReviewRunStartInput,
  ): Promise<void> {
    this.recordActivity(run.runId, "inspecting");

    try {
      const result = await this.workflow.start(input, {
        onActivity: (step) => this.recordActivity(run.runId, step),
      });
      if (result._tag === "err") {
        this.fail(run.runId);
        return;
      }

      const current = this.runs.get(run.runId, run);
      if (current._tag === "err") return;
      this.runs.update(run.runId, appendRunActivity({
        ...current.value.projection,
        status: "completed",
        elapsedMs: this.elapsed(run.runId),
        step: "complete",
      }, {
        at: this.nowIso(),
        elapsedMs: this.elapsed(run.runId),
        step: "complete",
        label: "Review result is ready",
      }));
    } catch {
      this.fail(run.runId);
    }
  }

  private fail(runId: string): void {
    const current = this.runs.findByRunId(runId);
    if (current === undefined) return;
    this.runs.update(runId, appendRunActivity({
      ...current.projection,
      status: "failed",
      elapsedMs: this.elapsed(runId),
      step: "failed",
      message: "Review run failed",
    }, {
      at: this.nowIso(),
      elapsedMs: this.elapsed(runId),
      step: "failed",
      label: "Review stopped",
    }));
  }

  private recordActivity(
    runId: string,
    step: Exclude<ReviewActivityStep, "complete" | "failed">,
  ): void {
    const current = this.runs.findByRunId(runId);
    if (current === undefined || current.projection.step === step) return;
    const label = step === "preparing"
      ? "Preparing review snapshot"
      : step === "inspecting"
        ? "Inspecting changed files"
        : step === "validating"
          ? "Validating findings"
          : "Drafting review result";
    this.runs.update(runId, appendRunActivity({
      ...current.projection,
      status: "running",
      elapsedMs: this.elapsed(runId),
      step,
    }, {
      at: this.nowIso(),
      elapsedMs: this.elapsed(runId),
      step,
      label,
    }));
  }

  private withCurrentElapsed(run: OwnedRun): SafeRunProjection {
    if (
      run.projection.status !== "queued" &&
      run.projection.status !== "connecting" &&
      run.projection.status !== "running"
    ) {
      return run.projection;
    }

    const elapsedMs = this.elapsed(run.runId);
    return elapsedMs === run.projection.elapsedMs
      ? run.projection
      : { ...run.projection, elapsedMs };
  }

  private elapsed(runId: string): number {
    const startedAt = this.startedAt.get(runId);
    return startedAt === undefined
      ? 0
      : Math.max(0, this.now() - startedAt);
  }
}

function ownership(input: RunOwnership): RunOwnership {
  return { sessionId: input.sessionId, attemptId: input.attemptId };
}
