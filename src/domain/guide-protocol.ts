import * as v from "valibot";

import {
  guideExplanationSchema,
  guideFileIdSchema,
  guideGroupIdSchema,
  guideRelevanceSchema,
  guideTitleSchema,
} from "./guide";
import {
  insightArtifactHashSchema,
  insightArtifactIdSchema,
  insightArtifactIndexDescriptorSchema,
  insightArtifactPositiveSchema,
  insightArtifactRunIdSchema,
  insightArtifactUnsignedSchema,
} from "./insight-artifact-scalars";
import { err, ok, type Result } from "./result";

/** Every channel frame, in either direction, including identity fields and JSON escaping, fits this many UTF-8 bytes. */
export const GUIDE_MAX_FRAME_BYTES = 32 * 1024;
/** Largest provider request body the app stages; a larger body refuses dispatch. */
export const GUIDE_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
/** Raw bytes per staged body chunk; base64 of this size plus identity fields stays under the frame bound. */
export const GUIDE_REQUEST_CHUNK_BYTES = 12 * 1024;

const U = insightArtifactUnsignedSchema;
const P = insightArtifactPositiveSchema;

/** The model-facing inputs. The host adds run, generation and cancel-epoch identity. */
export const guideOpenGroupInputSchema = v.strictObject({
  opId: insightArtifactIdSchema,
  title: guideTitleSchema,
  explanation: guideExplanationSchema,
});
const guideMemberInputSchema = v.strictObject({
  fileId: guideFileIdSchema,
  relevance: guideRelevanceSchema,
});
/** Encoded size, not a logical count, bounds a batch; a batch needs at least one member. */
export const guideAddMembersInputSchema = v.strictObject({
  opId: insightArtifactIdSchema,
  groupId: guideGroupIdSchema,
  members: v.pipe(v.array(guideMemberInputSchema), v.minLength(1)),
});
export const guideFinishInputSchema = v.strictObject({
  opId: insightArtifactIdSchema,
});
export const guideLookupInputSchema = v.strictObject({
  opId: insightArtifactIdSchema,
});

export type GuideOpenGroupInput = v.InferOutput<
  typeof guideOpenGroupInputSchema
>;
export type GuideAddMembersInput = v.InferOutput<
  typeof guideAddMembersInputSchema
>;

/** The three mutation kinds a GuideOperation1 records. */
export type GuideOperationKind = "open_group" | "add_members" | "finish";

/** Canonical operation payload: the model input plus the identity it was accepted under. */
const identityFields = {
  runId: insightArtifactRunIdSchema,
  generation: U,
  cancelEpoch: U,
};
export const guideOperationPayloadSchemas = {
  open_group: v.strictObject({
    ...guideOpenGroupInputSchema.entries,
    ...identityFields,
  }),
  add_members: v.strictObject({
    ...guideAddMembersInputSchema.entries,
    ...identityFields,
  }),
  finish: v.strictObject({
    ...guideFinishInputSchema.entries,
    ...identityFields,
  }),
} as const;

/** Accepted receipt data. It never carries a whole group or result. */
export const guideReceiptResultSchemas = {
  open_group: v.strictObject({ groupId: guideGroupIdSchema }),
  add_members: v.strictObject({
    groupId: guideGroupIdSchema,
    accepted: P,
  }),
  /** `receipts` is the index of every receipt accepted before the finish receipt itself. */
  finish: v.strictObject({
    sequence: P,
    receipts: insightArtifactIndexDescriptorSchema,
  }),
} as const;

const receiptResultUnion = v.union([
  guideReceiptResultSchemas.open_group,
  guideReceiptResultSchemas.add_members,
  guideReceiptResultSchemas.finish,
]);

const connectionIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{8,64}$/));
/** Identity every frame binds; the app compares each field before any side effect. */
const frameIdentity = {
  ...identityFields,
  connection: connectionIdSchema,
  correlation: P,
};

const toolCallSchema = v.variant("tool", [
  v.strictObject({
    tool: v.literal("open_group"),
    input: guideOpenGroupInputSchema,
  }),
  v.strictObject({
    tool: v.literal("add_members"),
    input: guideAddMembersInputSchema,
  }),
  v.strictObject({
    tool: v.literal("finish"),
    input: guideFinishInputSchema,
  }),
  v.strictObject({
    tool: v.literal("lookup_receipt"),
    input: guideLookupInputSchema,
  }),
]);

/** Child to app. The child never names a destination, header or credential. */
export const guideChildFrameSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("tool"),
    ...frameIdentity,
    call: toolCallSchema,
  }),
  v.strictObject({
    kind: v.literal("request_open"),
    ...frameIdentity,
    totalBytes: v.pipe(P, v.maxValue(GUIDE_MAX_REQUEST_BYTES)),
  }),
  v.strictObject({
    kind: v.literal("request_chunk"),
    ...frameIdentity,
    handle: P,
    offset: U,
    data: v.pipe(
      v.string(),
      v.regex(/^[A-Za-z0-9+/]*={0,2}$/),
      v.maxLength(Math.ceil(GUIDE_REQUEST_CHUNK_BYTES / 3) * 4),
    ),
  }),
  v.strictObject({
    kind: v.literal("request_commit"),
    ...frameIdentity,
    handle: P,
    sha256: insightArtifactHashSchema,
    bytes: P,
  }),
]);
export type GuideChildFrame = v.InferOutput<typeof guideChildFrameSchema>;

/** Why the app refused a frame. A refusal has no side effect and is final for that correlation. */
export const GUIDE_REFUSAL_REASONS = [
  "stale_identity",
  "closed",
  "unknown_group",
  "unknown_file",
  "duplicate_member",
  "op_conflict",
  "invalid_input",
  "too_large",
  "sensitive",
  "storage",
  "cancelled",
  "unsupported",
] as const;
export type GuideRefusalReason = (typeof GUIDE_REFUSAL_REASONS)[number];

/** App to child. Replies repeat the connection identity so the child can verify who answered. */
export const guideAppReplySchema = v.strictObject({
  kind: v.literal("reply"),
  ...frameIdentity,
  outcome: v.variant("status", [
    v.strictObject({
      status: v.literal("receipt"),
      sequence: P,
      result: receiptResultUnion,
    }),
    v.strictObject({ status: v.literal("not_found") }),
    v.strictObject({ status: v.literal("handle"), handle: P }),
    v.strictObject({ status: v.literal("stored") }),
    v.strictObject({
      status: v.literal("permission"),
      requestOrdinal: P,
      sha256: insightArtifactHashSchema,
      bytes: P,
    }),
    v.strictObject({
      status: v.literal("refused"),
      reason: v.picklist(GUIDE_REFUSAL_REASONS),
    }),
    /**
     * The app cannot say whether the mutation or admission was recorded. Unlike `refused`, which promises no side
     * effect, this stops the producer: it makes no further paid request and resolves the question through `lookup_receipt`
     * only on a later explicit run.
     */
    v.strictObject({ status: v.literal("unknown") }),
  ]),
});
export type GuideAppReply = v.InferOutput<typeof guideAppReplySchema>;
export type GuideAppOutcome = GuideAppReply["outcome"];

/** Parses one newline-free frame line; the byte bound is checked before any JSON parse. */
export function parseGuideFrameLine<TSchema extends v.GenericSchema>(
  schema: TSchema,
  line: string,
): Result<v.InferOutput<TSchema>, "frame_too_large" | "invalid_frame"> {
  if (new TextEncoder().encode(line).length > GUIDE_MAX_FRAME_BYTES)
    return err("frame_too_large");
  try {
    const parsed = v.safeParse(schema, JSON.parse(line));
    return parsed.success ? ok(parsed.output) : err("invalid_frame");
  } catch {
    return err("invalid_frame");
  }
}

/** Encodes one frame; a frame over the bound is a programming error in the sender, never truncated. */
export function encodeGuideFrameLine(
  frame: GuideChildFrame | GuideAppReply,
): Result<string, "frame_too_large"> {
  const line = JSON.stringify(frame);
  return new TextEncoder().encode(line).length > GUIDE_MAX_FRAME_BYTES
    ? err("frame_too_large")
    : ok(line);
}
