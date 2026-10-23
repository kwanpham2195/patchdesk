import * as v from "valibot";
import type { InsightArtifactCodec } from "./insight-artifact-index";
import { explanationFrameIdentity } from "./explanation-channel";
import {
  insightArtifactHashSchema as hash,
  insightArtifactIdSchema as id,
  insightArtifactIndexDescriptorSchema as index,
  insightArtifactPositiveSchema as positive,
  insightArtifactReferenceSchema as reference,
  insightArtifactTimeSchema as time,
  insightArtifactUnsignedSchema as unsigned,
  insightTextRootDescriptorSchema as text,
} from "./insight-artifact-scalars";

const startFields = v.strictObject({
  binding: reference,
  authorization: reference,
  provider: v.picklist(["codex-cli-account", "pi-cli-account"]),
  version: id,
  generation: positive,
  cancelEpoch: unsigned,
  ordinal: positive,
  connection: explanationFrameIdentity.connection,
  model: text,
  reasoning: v.picklist(["minimal", "low", "medium", "high", "xhigh"]),
  prompt: text,
  promptBytes: unsigned,
  promptHash: hash,
  toolContractHash: hash,
  evidence: reference,
  policy: reference,
  createdAt: time,
});

/** A durable intent to send a native generating command, never an exact HTTP request receipt. */
const start = v.pipe(
  startFields,
  v.check(
    (value) =>
      value.promptBytes === value.prompt.data.bytes &&
      value.promptHash === value.prompt.data.sha256,
  ),
);
/** Exact native send-intent wrapper; prompt identity must match its TextRoot. */
export const nativeTurnStartCodec: InsightArtifactCodec<typeof start> = {
  name: "NativeTurnStart1",
  schema: start,
};

const event = v.variant("kind", [
  v.strictObject({ kind: v.literal("accepted_start") }),
  v.strictObject({ kind: v.literal("provider_turn"), turnId: id }),
  v.strictObject({
    kind: v.literal("ended"),
    outcome: v.picklist(["known", "unknown"]),
  }),
  v.strictObject({ kind: v.literal("interrupt_requested") }),
  v.strictObject({
    kind: v.literal("cessation_confirmed"),
    outcome: v.picklist(["known", "unknown"]),
  }),
  v.strictObject({ kind: v.literal("cessation_unknown") }),
]);
const observation = v.strictObject({
  start: reference,
  event,
  createdAt: time,
});

/** Bounded local observations contain no native output or provider errors. */
export const nativeTurnObservationCodec: InsightArtifactCodec<
  typeof observation
> = {
  name: "NativeTurnObservation1",
  schema: observation,
};

/** The native journal variant retains all generations' immutable records. */
export const nativeExecutionSchema = v.strictObject({
  starts: index,
  observations: index,
});

/** Parsed native observation event. */
export type NativeTurnEvent = v.InferOutput<typeof event>;
