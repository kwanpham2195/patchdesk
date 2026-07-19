import { err, ok, type Result } from "../domain/result";
import type { SafeRunProjection } from "./run-projection";
export type RunOwnership = { readonly sessionId: string; readonly attemptId: string };
export type OwnedRun = RunOwnership & { readonly runId: string; readonly projection: SafeRunProjection };
/** Process-local ownership registry that prevents generic Flue run IDs crossing Patchdesk session boundaries. */
export class ReviewRunRegistry {
  private readonly runs = new Map<string, OwnedRun>();
  create(owner: RunOwnership): OwnedRun {
    const existing = this.find(owner);
    if (existing !== undefined) return existing;

    const run = {
      ...owner,
      runId: ownedRunId(owner),
      projection: {
        status: "queued" as const,
        elapsedMs: 0,
        step: "preparing" as const,
      },
    };
    this.runs.set(run.runId, run);
    return run;
  }

  find(owner: RunOwnership): OwnedRun | undefined {
    return this.runs.get(ownedRunId(owner));
  }

  update(runId: string, projection: SafeRunProjection): void { const run = this.runs.get(runId); if (run !== undefined) this.runs.set(runId, { ...run, projection }); }
  get(runId: string, owner: RunOwnership): Result<OwnedRun, { readonly _tag: "RunNotOwned" }> { const run = this.runs.get(runId); return run === undefined || run.sessionId !== owner.sessionId || run.attemptId !== owner.attemptId ? err({ _tag: "RunNotOwned" }) : ok(run); }
}

function ownedRunId(owner: RunOwnership): string {
  return `patchdesk:${owner.sessionId}:${owner.attemptId}`;
}
