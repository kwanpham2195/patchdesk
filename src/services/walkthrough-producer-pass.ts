import { randomBytes } from "node:crypto";
import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import type { ExplanationConnectionIdentity } from "#src/domain/explanation-channel";
import type {
  WalkthroughAppOutcome,
  WalkthroughChildFrame,
} from "#src/domain/walkthrough-protocol";
import type { IsoTimestamp } from "#src/domain/ids";
import type { GuideStartRequest } from "./guide-generation-service";
import type { PiGuideChildOutcome } from "./pi-insight-child-invoker";
import type { InsightSlotAuthority } from "./insight-slot-authority";
import { ExplanationRequestDispatch } from "./explanation-request-dispatch";
import { WalkthroughRunOperations } from "./walkthrough-generation-operations";
import type { WalkthroughPass } from "./walkthrough-generation-resume";

/** Internal producer capability; no public Start or reader selects it yet. */
export type WalkthroughProducer = {
  invokeWalkthroughSession(input: {
    readonly profileId: string;
    readonly sessionId: string;
    readonly model: string;
    readonly reasoning: "low" | "medium" | "high";
    readonly language: GuideStartRequest["selection"]["language"];
    readonly evidence: WalkthroughPass["evidence"];
    readonly identity: ExplanationConnectionIdentity;
    readonly deadlineAt: string;
    readonly signal: AbortSignal;
    readonly handler: (
      frame: WalkthroughChildFrame,
    ) => Promise<WalkthroughAppOutcome>;
  }): Promise<PiGuideChildOutcome>;
};
type ProducerOutcome = {
  readonly expired: boolean;
  readonly outcome: PiGuideChildOutcome;
};

/** One owned channel and deadline timer; uncertainty closes every further tool and paid-request admission. */
export class WalkthroughProducerPass {
  private readonly operations: WalkthroughRunOperations;
  constructor(
    private readonly artifacts: InsightArtifactStore,
    private readonly authority: InsightSlotAuthority,
    private readonly invoker: WalkthroughProducer,
    private readonly now: () => IsoTimestamp,
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
    const remaining = Date.parse(pass.deadlineAt) - Date.parse(this.now());
    const timer = setTimeout(
      () => {
        expired = true;
        controller.abort();
      },
      Math.max(0, remaining),
    );
    const context = {
      run,
      generation: pass.generation,
      cancelEpoch: pass.cancelEpoch,
    };
    const dispatch = new ExplanationRequestDispatch(
      this.authority.explanation,
      this.artifacts,
      this.now,
      "walkthrough",
    );
    let outcome: PiGuideChildOutcome;
    try {
      if (remaining <= 0) {
        expired = true;
        controller.abort();
        outcome = { _tag: "failed", reason: "timed_out", effectKnown: true };
      } else
        outcome = await this.invoker.invokeWalkthroughSession({
          profileId: run.profileId,
          sessionId: request.sessionId,
          model: request.selection.model,
          reasoning: request.reasoning,
          language: request.selection.language,
          evidence: pass.evidence,
          deadlineAt: pass.deadlineAt,
          identity: {
            runId: run.runId,
            generation: pass.generation,
            cancelEpoch: pass.cancelEpoch,
            connection: randomBytes(18).toString("base64url"),
          },
          signal: controller.signal,
          handler: async (frame) => {
            if (unknown) return { status: "unknown" };
            let answer: WalkthroughAppOutcome;
            switch (frame.kind) {
              case "tool":
                answer = await this.operations.handle(context, frame.call);
                break;
              case "request_open":
                answer = dispatch.open(frame.totalBytes);
                break;
              case "request_chunk":
                answer = dispatch.chunk(frame);
                break;
              case "request_commit":
                answer = await dispatch.commit(context, frame);
                break;
            }
            if (answer.status === "unknown") unknown = true;
            return answer;
          },
        });
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
