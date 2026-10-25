import type { InsightActivityEvent } from "#src/adapters/codex/codex-activity";
import type { InsightRunRef } from "./insight-slot-records";
import { randomBytes } from "node:crypto";
import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import type { IsoTimestamp } from "#src/domain/ids";
import type {
  ExplanationProducers,
  ExplanationProducerOutcome,
} from "./explanation-producer";
import { NativeExplanationTurns } from "./native-explanation-turns";
import { selectExplanationProducer } from "./explanation-producer";
import type { InsightSlotAuthority } from "./insight-slot-authority";
import { WalkthroughRunOperations } from "./walkthrough-generation-operations";
import type { WalkthroughPass } from "./walkthrough-generation-resume";

type ProducerOutcome = {
  readonly expired: boolean;
  readonly outcome: ExplanationProducerOutcome;
};

/** One owned channel and deadline timer; uncertainty closes every further tool and paid-request admission. */
export class WalkthroughProducerPass {
  private readonly operations: WalkthroughRunOperations;
  constructor(
    private readonly artifacts: InsightArtifactStore,
    private readonly authority: InsightSlotAuthority,
    private readonly producers: ExplanationProducers,
    private readonly now: () => IsoTimestamp,
    private readonly onActivity?: (
      run: InsightRunRef,
      event: InsightActivityEvent,
    ) => void,
  ) {
    this.operations = new WalkthroughRunOperations(
      authority.explanation,
      artifacts,
    );
  }

  /** Joins the child and clears its deadline timer on every outcome. */
  async run(
    pass: WalkthroughPass,
    controller: AbortController,
  ): Promise<ProducerOutcome> {
    const { run, request } = pass;
    let unknown = false;
    let expired = false;
    const deadline = new AbortController();
    const signal = AbortSignal.any([controller.signal, deadline.signal]);
    const remaining = Date.parse(pass.deadlineAt) - Date.parse(this.now());
    const timer = setTimeout(
      () => {
        expired = true;
        deadline.abort();
      },
      Math.max(0, remaining),
    );
    const context = {
      run,
      generation: pass.generation,
      cancelEpoch: pass.cancelEpoch,
    };
    let outcome: ExplanationProducerOutcome;
    try {
      if (remaining <= 0) {
        expired = true;
        deadline.abort();
        outcome = { _tag: "failed", reason: "timed_out", effectKnown: true };
      } else {
        const producer = await selectExplanationProducer(
          this.producers,
          this.artifacts,
          this.authority.explanation,
          pass,
        );
        const identity = {
          runId: run.runId,
          generation: pass.generation,
          cancelEpoch: pass.cancelEpoch,
          connection: randomBytes(18).toString("base64url"),
        };
        const input = {
          profileId: run.profileId,
          sessionId: request.sessionId,
          model: request.selection.model,
          reasoning: request.reasoning,
          language: request.selection.language,
          evidence: pass.evidence,
          deadline: {
            kind: "walkthrough-deadline/1",
            deadlineAt: pass.deadlineAt,
          } as const,
          identity,
          signal,
          onActivity: (event: InsightActivityEvent) =>
            this.onActivity?.(run, event),
        };
        if (producer === undefined)
          outcome = {
            _tag: "failed",
            reason: "runtime_unavailable",
            effectKnown: true,
          };
        else {
          const lifecycle = new NativeExplanationTurns(
            this.authority.explanation,
            this.artifacts,
            context,
            request,
            identity.connection,
            this.now,
            signal,
          );
          outcome = await producer.invokeWalkthroughSession({
            ...input,
            lifecycle,
            tool: async (call) => {
              if (!lifecycle.started)
                return { status: "refused", reason: "stale_identity" };
              if (unknown) return { status: "unknown" };
              const answer = await this.operations.handle(context, call);
              if (answer.status === "unknown") unknown = true;
              if (call.tool === "finish" && answer.status === "receipt")
                await lifecycle.finish();
              return answer;
            },
          });
        }
      }
    } catch {
      outcome = {
        _tag: "failed",
        reason: "execution_failed",
        effectKnown: false,
      };
    } finally {
      clearTimeout(timer);
      this.operations.forget(run.runId);
    }
    return {
      expired,
      outcome: unknown
        ? { _tag: "failed", reason: "execution_failed", effectKnown: false }
        : outcome,
    };
  }
}
