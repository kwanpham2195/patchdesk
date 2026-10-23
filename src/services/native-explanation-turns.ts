import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import { InsightResultStore } from "#src/adapters/storage/insight-result-store";
import { guideRuntimeCodec } from "#src/domain/guide-result";
import { walkthroughRuntimeCodec } from "#src/domain/walkthrough-result";
import {
  insightAuthorizationCodec,
  insightProvenanceCodec,
  insightRunPolicyCodec,
} from "#src/domain/insight-run-binding-contract";
import type { InsightJournalState } from "#src/domain/insight-run-journal-contract";
import type { InsightArtifactReference } from "#src/domain/insight-artifact-scalars";
import {
  nativeTurnStartCodec,
  nativeTurnObservationCodec,
  type NativeTurnEvent,
} from "#src/domain/native-explanation-turn";
import type { IsoTimestamp } from "#src/domain/ids";
import { err, ok, type Result } from "#src/domain/result";
import type { GuideRunContext } from "./guide-generation-operations";
import type { ExplanationRunTransactions } from "./explanation-run-transactions";
import type { NativeExplanationLifecycle } from "./explanation-producer";
import type { GuideStartRequest } from "./guide-generation-service";

/** Counts actual intents in the selected ledger, never fabricated API requests. */
export function explanationStartCount(state: InsightJournalState): number {
  return state.nativeExecution?.starts.count ?? state.dispatches.count;
}

/** An active native generation without its own start may own preflight processes; older cessation proves nothing. */
export async function nativePreflightMayOwnProcess(
  artifacts: InsightArtifactStore,
  context: Pick<GuideRunContext, "run">,
  state: InsightJournalState,
): Promise<Result<boolean, "storage">> {
  if (context.run.type !== "guide" && context.run.type !== "walkthrough")
    return ok(false);
  const { profileId, reviewId } = context.run;
  const authorization = await artifacts.readObject(
    profileId,
    reviewId,
    insightAuthorizationCodec,
    state.authorization,
  );
  if (
    authorization._tag === "err" ||
    authorization.value.runId !== context.run.runId
  )
    return err("storage");
  const selection = await artifacts.readObject(
    profileId,
    reviewId,
    insightProvenanceCodec,
    authorization.value.selection,
  );
  if (selection._tag === "err") return err("storage");
  if (selection.value.provider === "pi") return ok(false);
  if (
    state.nativeExecution === undefined ||
    state.nativeExecution.starts.count === 0
  )
    return ok(true);
  const native = await nativeTurnStatus(artifacts, context, state);
  return native._tag === "err"
    ? native
    : ok(native.value.generation !== state.generation);
}

/** Bounded reads used by conclusion, recovery, Resume and reader projections. */
export async function nativeTurnStatus(
  artifacts: InsightArtifactStore,
  context: Pick<GuideRunContext, "run">,
  state: InsightJournalState,
): Promise<
  Result<
    {
      readonly newest: InsightArtifactReference;
      readonly ceased: boolean;
      readonly known: boolean;
      readonly generation: number;
    },
    "storage"
  >
> {
  const native = state.nativeExecution;
  if (native === undefined || native.starts.count === 0) return err("storage");
  const { profileId, reviewId } = context.run;
  const store = new InsightResultStore(artifacts, profileId, reviewId);
  const starts = await store.readIndex(
    "NativeTurnStart1",
    native.starts,
    native.starts.count - 1,
    1,
  );
  const newest = starts._tag === "ok" ? starts.value[0]?.value : undefined;
  if (newest === undefined) return err("storage");
  const start = await artifacts.readObject(
    profileId,
    reviewId,
    nativeTurnStartCodec,
    newest,
  );
  if (
    start._tag === "err" ||
    start.value.binding.hash !== state.binding.hash ||
    start.value.ordinal !== native.starts.count ||
    start.value.generation > state.generation ||
    (start.value.generation === state.generation &&
      start.value.authorization.hash !== state.authorization.hash)
  )
    return err("storage");
  const generation = start.value.generation;
  if (native.observations.count === 0)
    return ok({ newest, ceased: false, known: false, generation });
  const observations = await store.readIndex(
    "NativeTurnObservation1",
    native.observations,
    native.observations.count - 1,
    1,
  );
  const entry = observations._tag === "ok" ? observations.value[0] : undefined;
  if (entry === undefined) return err("storage");
  const observed = await artifacts.readObject(
    profileId,
    reviewId,
    nativeTurnObservationCodec,
    entry.value,
  );
  if (observed._tag === "err") return err("storage");
  const ceased =
    observed.value.start.hash === newest.hash &&
    observed.value.start.bytes === newest.bytes &&
    observed.value.event.kind === "cessation_confirmed";
  return ok({
    newest,
    generation,
    ceased,
    known:
      ceased &&
      observed.value.event.kind === "cessation_confirmed" &&
      observed.value.event.outcome === "known",
  });
}

/** Commits native send intent and observations through the existing journal transaction owner. */
export class NativeExplanationTurns implements NativeExplanationLifecycle {
  private startReference: InsightArtifactReference | undefined;
  private starting = false;
  private readonly finished = new AbortController();
  /** Native finish interrupts execution without classifying it as user cancellation. */
  readonly finishSignal = this.finished.signal;
  /** Logical operations require a committed send intent on this connection. */
  get started(): boolean {
    return this.startReference !== undefined;
  }

  constructor(
    private readonly authority: Pick<ExplanationRunTransactions, "produce">,
    private readonly artifacts: InsightArtifactStore,
    private readonly context: GuideRunContext,
    private readonly request: GuideStartRequest,
    private readonly connection: string,
    private readonly now: () => IsoTimestamp,
    private readonly signal: AbortSignal,
  ) {}

  /** Returns permission only after the start's journal pointer is confirmed committed. */
  async start(input: {
    readonly version: string;
    readonly prompt: string;
    readonly toolContractHash: string;
  }): Promise<Result<InsightArtifactReference, "refused" | "unknown">> {
    if (this.starting || Buffer.byteLength(input.prompt, "utf8") > 65_536)
      return err("refused");
    this.starting = true;
    const { run, generation, cancelEpoch } = this.context;
    const { profileId, reviewId } = run;
    const [prompt, model] = await Promise.all([
      this.artifacts.writeTextRoot(profileId, reviewId, input.prompt),
      this.artifacts.writeTextRoot(
        profileId,
        reviewId,
        this.request.selection.model,
      ),
    ]);
    if (prompt._tag === "err" || model._tag === "err") return err("refused");
    let reference: InsightArtifactReference | undefined;
    const committed = await this.authority.produce(run, async ({ state }) => {
      const runtimeRef =
        run.type === "guide" ? state.guideRuntime : state.walkthroughRuntime;
      const preparation =
        run.type === "guide"
          ? state.guidePreparation
          : state.walkthroughPreparation;
      if (
        this.signal.aborted ||
        state.status !== "running" ||
        state.generation !== generation ||
        state.cancelEpoch !== cancelEpoch ||
        state.dispatches.count !== 0 ||
        runtimeRef === undefined ||
        preparation === undefined
      )
        return err("not_active" as const);
      const runtime =
        run.type === "guide"
          ? await this.artifacts.readObject(
              profileId,
              reviewId,
              guideRuntimeCodec,
              runtimeRef,
            )
          : await this.artifacts.readObject(
              profileId,
              reviewId,
              walkthroughRuntimeCodec,
              runtimeRef,
            );
      if (runtime._tag === "err" || runtime.value.phase !== "building")
        return err("not_active" as const);
      const authorization = await this.artifacts.readObject(
        profileId,
        reviewId,
        insightAuthorizationCodec,
        state.authorization,
      );
      if (authorization._tag === "err")
        return err("storage_unavailable" as const);
      if (
        authorization.value.runId !== run.runId ||
        authorization.value.policy.hash !== state.policy.hash
      )
        return err("not_active" as const);
      const [selection, policy] = await Promise.all([
        this.artifacts.readObject(
          profileId,
          reviewId,
          insightProvenanceCodec,
          authorization.value.selection,
        ),
        this.artifacts.readObject(
          profileId,
          reviewId,
          insightRunPolicyCodec,
          state.policy,
        ),
      ]);
      if (selection._tag === "err" || policy._tag === "err")
        return err("storage_unavailable" as const);
      if (
        selection.value.provider === "pi" ||
        selection.value.provider !== this.request.selection.provider ||
        selection.value.model.data.sha256 !== model.value.data.sha256 ||
        selection.value.reasoning !== this.request.reasoning ||
        (run.type === "walkthrough"
          ? policy.value.kind !== "walkthrough-deadline/1" ||
            Date.parse(this.now()) >= Date.parse(policy.value.deadlineAt)
          : policy.value.kind !== "no-total-deadline/1")
      )
        return err("not_active" as const);
      const store = new InsightResultStore(this.artifacts, profileId, reviewId);
      const starts =
        state.nativeExecution === undefined
          ? await store.emptyIndex("NativeTurnStart1")
          : ok(state.nativeExecution.starts);
      const observations =
        state.nativeExecution === undefined
          ? await store.emptyIndex("NativeTurnObservation1")
          : ok(state.nativeExecution.observations);
      if (starts._tag === "err" || observations._tag === "err")
        return err("storage_unavailable" as const);
      const record = await this.artifacts.writeObject(
        profileId,
        reviewId,
        nativeTurnStartCodec,
        {
          binding: state.binding,
          authorization: state.authorization,
          provider: selection.value.provider,
          version: input.version,
          generation,
          cancelEpoch,
          ordinal: starts.value.count + 1,
          connection: this.connection,
          model: model.value,
          reasoning: this.request.reasoning,
          prompt: prompt.value,
          promptBytes: prompt.value.data.bytes,
          promptHash: prompt.value.data.sha256,
          toolContractHash: input.toolContractHash,
          evidence: preparation,
          policy: state.policy,
          createdAt: this.now(),
        },
      );
      if (record._tag === "err") return err("storage_unavailable" as const);
      const appended = await store.appendIndex(
        "NativeTurnStart1",
        starts.value,
        starts.value.count + 1,
        record.value,
      );
      if (appended._tag === "err") return err("storage_unavailable" as const);
      reference = record.value;
      return ok({
        status: state.status,
        // A native turn has no exact request or billing receipts, even when its local outcome is known.
        usageUnknown: true,
        nativeExecution: {
          starts: appended.value,
          observations: observations.value,
        },
        staged: [{ schema: "NativeTurnStart1", root: record.value }],
      });
    });
    if (committed._tag === "err" || reference === undefined)
      return err(
        committed._tag === "err" && committed.error === "outcome_unknown"
          ? "unknown"
          : "refused",
      );
    this.startReference = reference;
    return ok(reference);
  }

  /** Records only events for this connection's committed start, even after cancellation raised the epoch. */
  async observe(event: NativeTurnEvent): Promise<Result<void, "unknown">> {
    const start = this.startReference;
    if (start === undefined) return err("unknown");
    const { run } = this.context;
    const committed = await this.authority.produce(run, async ({ state }) => {
      const native = state.nativeExecution;
      if (native === undefined || state.generation !== this.context.generation)
        return err("not_active" as const);
      const latest = await nativeTurnStatus(
        this.artifacts,
        this.context,
        state,
      );
      if (latest._tag === "err" || latest.value.newest.hash !== start.hash)
        return err("not_active" as const);
      // A late interrupt acknowledgment cannot revoke already confirmed process cessation.
      if (latest.value.ceased) return ok(undefined);
      const record = await this.artifacts.writeObject(
        run.profileId,
        run.reviewId,
        nativeTurnObservationCodec,
        { start, event, createdAt: this.now() },
      );
      if (record._tag === "err") return err("storage_unavailable" as const);
      const observations = await new InsightResultStore(
        this.artifacts,
        run.profileId,
        run.reviewId,
      ).appendIndex(
        "NativeTurnObservation1",
        native.observations,
        native.observations.count + 1,
        record.value,
      );
      if (observations._tag === "err")
        return err("storage_unavailable" as const);
      return ok({
        status: state.status,
        nativeExecution: { ...native, observations: observations.value },
        staged: [{ schema: "NativeTurnObservation1", root: record.value }],
      });
    });
    return committed._tag === "ok" ? ok(undefined) : err("unknown");
  }

  /** Called immediately after the operation service accepts finish, before releasing its response. */
  async finish(): Promise<void> {
    if (this.finished.signal.aborted) return;
    this.finished.abort();
  }
}
