import { createHash } from "node:crypto";
import * as v from "valibot";

import { guideInventoryEntrySchema } from "#src/domain/guide";
import { guidePreparedInputCodec } from "#src/domain/guide-preparation";
import {
  GuideBuild,
  guideOthersIds,
  parseGuideOperationPayload,
  parseGuideReceiptResult,
} from "#src/domain/guide-result-records";
import {
  guideOperationCodec,
  guideReceiptCodec,
  guideRuntimeCodec,
} from "#src/domain/guide-result";
import {
  parseInsightRunId,
  parseReviewId,
  parseWorkspaceProfileId,
  type ReviewId,
  type WorkspaceProfileId,
} from "#src/domain/ids";
import {
  insightArtifactReferenceSchema,
  insightArtifactUnsignedSchema,
  type InsightArtifactIndexDescriptor,
  type InsightArtifactReference,
} from "#src/domain/insight-artifact-scalars";
import { err, type Result } from "#src/domain/result";
import { GuideGraphWriter } from "./guide-result-validation";
import { InsightResultStore } from "./insight-result-store";
import { validateExplanationPreparedEvidence } from "./explanation-prepared-evidence-validation";
import { readBoundedInsightArtifactFile } from "./insight-artifact-files";
import { InsightArtifactStore } from "./insight-artifact-store";
import { PatchdeskPaths } from "./patchdesk-paths";

const boundedPath = v.pipe(v.string(), v.minLength(1), v.maxLength(4_096));

/** Main-derived identities and references for one Guide validation; no model text or path beyond the scope root crosses it. */
export const guideValidationInputSchema = v.strictObject({
  destinationRoot: boundedPath,
  profileId: v.pipe(
    v.string(),
    v.check((value) => parseWorkspaceProfileId(value)._tag === "ok"),
  ),
  reviewId: v.pipe(
    v.string(),
    v.check((value) => parseReviewId(value)._tag === "ok"),
  ),
  runId: v.pipe(
    v.string(),
    v.check((value) => parseInsightRunId(value)._tag === "ok"),
  ),
  binding: insightArtifactReferenceSchema,
  preparation: insightArtifactReferenceSchema,
  runtime: insightArtifactReferenceSchema,
  generation: insightArtifactUnsignedSchema,
  cancelEpoch: insightArtifactUnsignedSchema,
});
export type GuideValidationInput = v.InferOutput<
  typeof guideValidationInputSchema
>;

const GUIDE_VALIDATION_FAILURE_REASONS = [
  "aborted",
  "invalid_input",
  "rejected",
  "io",
  "transport",
  "busy",
] as const;
export type GuideValidationFailureReason =
  (typeof GUIDE_VALIDATION_FAILURE_REASONS)[number];

/** Descriptor-only reply: the stored result and validation roots, with counts for diagnostics. */
export const guideValidationResultSchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("ok"),
    value: v.strictObject({
      result: insightArtifactReferenceSchema,
      validation: insightArtifactReferenceSchema,
      counts: v.strictObject({
        groups: insightArtifactUnsignedSchema,
        members: insightArtifactUnsignedSchema,
        inventory: insightArtifactUnsignedSchema,
        others: insightArtifactUnsignedSchema,
        receipts: insightArtifactUnsignedSchema,
      }),
    }),
  }),
  v.strictObject({
    _tag: v.literal("err"),
    error: v.strictObject({
      _tag: v.literal("GuideValidationFailure"),
      reason: v.picklist(GUIDE_VALIDATION_FAILURE_REASONS),
    }),
  }),
]);
export type GuideValidationResult = v.InferOutput<
  typeof guideValidationResultSchema
>;

/** Constructs a prose-free validation failure. */
export function guideValidationFailure(
  reason: GuideValidationFailureReason,
): Result<
  never,
  {
    readonly _tag: "GuideValidationFailure";
    readonly reason: GuideValidationFailureReason;
  }
> {
  return err({ _tag: "GuideValidationFailure", reason });
}

/** Receipt payloads and results are small canonical JSON; a larger text is corrupt. */
const MAX_OPERATION_TEXT_BYTES = 128 * 1024;
/** The inventory is parsed whole in the worker, like the patch itself. */
const MAX_INVENTORY_BYTES = 64 * 1024 * 1024;
const RECEIPT_WINDOW = 64;

type Options = { readonly signal?: AbortSignal };

/**
 * Worker operation: replays every frozen receipt against the complete prepared inventory, then has the graph writer
 * store and read back the strict result graph (groups, members, inventory, derived Others, validation, root). It never
 * publishes a result, calls a provider or touches the slot. Any receipt, field or membership that disagrees with the
 * frozen record rejects the whole run; no partial graph is named.
 */
export async function validateGuideResult(
  input: GuideValidationInput,
  options: Options = {},
): Promise<GuideValidationResult> {
  const profile = parseWorkspaceProfileId(input.profileId);
  const review = parseReviewId(input.reviewId);
  const run = parseInsightRunId(input.runId);
  if (profile._tag === "err" || review._tag === "err" || run._tag === "err")
    return guideValidationFailure("invalid_input");
  const paths = PatchdeskPaths.fromEnvironment({
    PATCHDESK_CONFIG_DIRECTORY: input.destinationRoot,
    PATCHDESK_DATA_DIRECTORY: input.destinationRoot,
    PATCHDESK_CACHE_DIRECTORY: input.destinationRoot,
  });
  const artifacts = new InsightArtifactStore(
    paths,
    readBoundedInsightArtifactFile,
  );
  try {
    return await new Validation(
      artifacts,
      paths,
      new InsightResultStore(artifacts, profile.value, review.value),
      profile.value,
      review.value,
      input,
      options,
    ).run();
  } catch {
    return guideValidationFailure(options.signal?.aborted ? "aborted" : "io");
  }
}

/** One accepted operation as replay saw it; `result` is the receipt's canonical result text. */
export type ReplayedOperation = {
  readonly sequence: number;
  readonly kind: "open_group" | "add_members" | "finish";
  readonly payloadHash: string;
  readonly result: string;
};
export type ReplayedOperations = ReadonlyMap<string, ReplayedOperation>;

/**
 * Applies a run's receipts in sequence order with the shared membership rules. The worker replays the frozen index
 * (a closed Guide is required); the app replays a building index to recover its in-memory view after a restart.
 */
export class GuideReceiptReplay {
  constructor(
    private readonly artifacts: InsightArtifactStore,
    private readonly store: InsightResultStore,
    private readonly profile: WorkspaceProfileId,
    private readonly review: ReviewId,
    private readonly identity: {
      readonly runId: string;
      readonly generation: number;
      readonly cancelEpoch: number;
    },
    private readonly options: Options,
  ) {}

  /** Reads every frozen receipt in order and applies it with the shared membership rules. */
  async replay(
    frozen: {
      readonly sequence: number;
      readonly receipts: InsightArtifactIndexDescriptor;
    },
    inventoryIds: ReadonlySet<string>,
    requireFinish: boolean,
  ): Promise<
    | { readonly build: GuideBuild; readonly ops: ReplayedOperations }
    | "io"
    | undefined
  > {
    const build = new GuideBuild(inventoryIds);
    const ops = new Map<string, ReplayedOperation>();
    const seen = new Set<string>();
    for (let start = 0; start < frozen.sequence; start += RECEIPT_WINDOW) {
      if (this.options.signal?.aborted) return "io";
      const window = await this.store.readIndex(
        "GuideReceipt1",
        frozen.receipts,
        start,
        Math.min(RECEIPT_WINDOW, frozen.sequence - start),
      );
      if (window._tag === "err") return "io";
      for (const [offset, entry] of window.value.entries()) {
        const sequence = start + offset + 1;
        if (entry.key !== String(sequence).padStart(16, "0")) return undefined;
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- receipts apply in sequence order
        const applied = await this.applyReceipt(
          build,
          entry.value,
          sequence,
          sequence === frozen.sequence,
          requireFinish,
          seen,
          ops,
        );
        if (applied !== true) return applied;
      }
    }
    return !requireFinish || build.isClosed ? { build, ops } : undefined;
  }

  private async applyReceipt(
    build: GuideBuild,
    reference: InsightArtifactReference,
    sequence: number,
    last: boolean,
    requireFinish: boolean,
    seen: Set<string>,
    ops: Map<string, ReplayedOperation>,
  ): Promise<true | "io" | undefined> {
    const receipt = await this.artifacts.readObject(
      this.profile,
      this.review,
      guideReceiptCodec,
      reference,
    );
    if (receipt._tag === "err" || receipt.value.sequence !== sequence)
      return receipt._tag === "err" ? "io" : undefined;
    const operation = await this.artifacts.readObject(
      this.profile,
      this.review,
      guideOperationCodec,
      receipt.value.operation,
    );
    if (operation._tag === "err") return "io";
    const op = operation.value;
    if (
      op.runId !== this.identity.runId ||
      op.generation !== this.identity.generation ||
      op.cancelEpoch !== this.identity.cancelEpoch ||
      seen.has(op.opId) ||
      (op.kind === "finish" && !last) ||
      (requireFinish && last && op.kind !== "finish") ||
      op.payloadHash !== op.payload.data.sha256
    )
      return undefined;
    seen.add(op.opId);
    const [payloadText, resultText] = await Promise.all([
      this.store.readText(op.payload, MAX_OPERATION_TEXT_BYTES),
      this.store.readText(receipt.value.result, MAX_OPERATION_TEXT_BYTES),
    ]);
    if (payloadText._tag === "err" || resultText._tag === "err") return "io";
    if (
      createHash("sha256").update(payloadText.value).digest("hex") !==
      op.payloadHash
    )
      return undefined;
    ops.set(op.opId, {
      sequence,
      kind: op.kind,
      payloadHash: op.payloadHash,
      result: resultText.value,
    });
    switch (op.kind) {
      case "open_group": {
        const payload = parseGuideOperationPayload(
          "open_group",
          payloadText.value,
        );
        const result = parseGuideReceiptResult("open_group", resultText.value);
        if (
          payload._tag === "err" ||
          result._tag === "err" ||
          !sameIdentity(payload.value, op)
        )
          return undefined;
        const accepted = build.openGroup(payload.value);
        return accepted._tag === "ok" &&
          accepted.value.groupId === result.value.groupId
          ? true
          : undefined;
      }
      case "add_members": {
        const payload = parseGuideOperationPayload(
          "add_members",
          payloadText.value,
        );
        const result = parseGuideReceiptResult("add_members", resultText.value);
        if (
          payload._tag === "err" ||
          result._tag === "err" ||
          !sameIdentity(payload.value, op)
        )
          return undefined;
        const accepted = build.addMembers(payload.value);
        return accepted._tag === "ok" &&
          accepted.value.groupId === result.value.groupId &&
          accepted.value.accepted === result.value.accepted
          ? true
          : undefined;
      }
      case "finish": {
        const payload = parseGuideOperationPayload("finish", payloadText.value);
        const result = parseGuideReceiptResult("finish", resultText.value);
        if (
          payload._tag === "err" ||
          result._tag === "err" ||
          !sameIdentity(payload.value, op)
        )
          return undefined;
        if (
          result.value.sequence !== sequence ||
          result.value.receipts.count !== sequence - 1
        )
          return undefined;
        return build.finish()._tag === "ok" ? true : undefined;
      }
    }
  }
}

class Validation {
  constructor(
    private readonly artifacts: InsightArtifactStore,
    private readonly paths: PatchdeskPaths,
    private readonly store: InsightResultStore,
    private readonly profile: WorkspaceProfileId,
    private readonly review: ReviewId,
    private readonly input: GuideValidationInput,
    private readonly options: Options,
  ) {}

  private stopped(reason: GuideValidationFailureReason): GuideValidationResult {
    return guideValidationFailure(
      this.options.signal?.aborted ? "aborted" : reason,
    );
  }

  async run(): Promise<GuideValidationResult> {
    const { input } = this;
    const runtime = await this.artifacts.readObject(
      this.profile,
      this.review,
      guideRuntimeCodec,
      input.runtime,
    );
    if (runtime._tag === "err") return this.stopped("io");
    const frozen = runtime.value.frozen;
    if (
      runtime.value.phase !== "validating" ||
      frozen === null ||
      runtime.value.result !== null ||
      frozen.sequence !== frozen.receipts.count ||
      frozen.sequence < 1 ||
      runtime.value.preparation.hash !== input.preparation.hash
    )
      return this.stopped("rejected");
    const prepared = await this.artifacts.readObject(
      this.profile,
      this.review,
      guidePreparedInputCodec,
      input.preparation,
    );
    if (prepared._tag === "err") return this.stopped("io");
    if (prepared.value.binding.hash !== input.binding.hash)
      return this.stopped("rejected");
    if (
      !(await validateExplanationPreparedEvidence(
        this.artifacts,
        this.paths,
        { profileId: this.profile, reviewId: this.review, runId: input.runId },
        prepared.value,
        this.options,
        "guide",
      ))
    )
      return this.stopped("rejected");
    const inventoryText = await this.store.readText(
      prepared.value.inventory,
      MAX_INVENTORY_BYTES,
    );
    if (inventoryText._tag === "err") return this.stopped("io");
    const inventory = parseInventory(inventoryText.value);
    if (inventory === undefined) return this.stopped("rejected");
    const replayed = await new GuideReceiptReplay(
      this.artifacts,
      this.store,
      this.profile,
      this.review,
      input,
      this.options,
    ).replay(frozen, new Set(inventory.map((e) => e.id)), true);
    if (replayed === undefined) return this.stopped("rejected");
    if (replayed === "io") return this.stopped("io");
    if (this.options.signal?.aborted) return this.stopped("io");
    const groups = replayed.build.snapshot();
    const writer = new GuideGraphWriter(
      this.artifacts,
      this.store,
      this.profile,
      this.review,
      input,
      this.options,
    );
    const written = await writer.writeGraph(
      inventory,
      groups,
      guideOthersIds(
        inventory.map((entry) => entry.id),
        groups,
      ),
      frozen,
      prepared.value.contextCompleteness,
    );
    if (written === undefined) return this.stopped("io");
    if (written === "rejected") return this.stopped("rejected");
    const verified = await writer.readBack(written.root, inventory, groups);
    if (!verified) return this.stopped("io");
    return {
      _tag: "ok",
      value: {
        result: written.root,
        validation: written.validation,
        counts: {
          groups: groups.length,
          members: groups.reduce((sum, group) => sum + group.members.length, 0),
          inventory: inventory.length,
          others: written.others,
          receipts: frozen.sequence,
        },
      },
    };
  }
}

function sameIdentity(
  payload: {
    readonly runId: string;
    readonly generation: number;
    readonly cancelEpoch: number;
    readonly opId: string;
  },
  op: {
    readonly runId: string;
    readonly generation: number;
    readonly cancelEpoch: number;
    readonly opId: string;
  },
): boolean {
  return (
    payload.runId === op.runId &&
    payload.generation === op.generation &&
    payload.cancelEpoch === op.cancelEpoch &&
    payload.opId === op.opId
  );
}

function parseInventory(
  text: string,
): ReadonlyArray<v.InferOutput<typeof guideInventoryEntrySchema>> | undefined {
  try {
    const parsed = v.safeParse(
      v.array(guideInventoryEntrySchema),
      JSON.parse(text),
    );
    if (!parsed.success || parsed.output.length === 0) return undefined;
    return parsed.output.every((entry, at) => entry.id === `f${at + 1}`)
      ? parsed.output
      : undefined;
  } catch {
    return undefined;
  }
}
