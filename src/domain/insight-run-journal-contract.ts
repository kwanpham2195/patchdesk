import * as v from "valibot";

import {
  encodeInsightArtifactDirect,
  type InsightArtifactCodec,
} from "./insight-artifact-index";
import {
  insightArtifactIdSchema,
  insightArtifactIndexDescriptorSchema,
  insightArtifactPositiveSchema,
  insightArtifactReferenceSchema,
  insightArtifactRunIdSchema,
  insightArtifactTimeSchema,
  insightArtifactUnsignedSchema,
  parseInsightArtifactCanonicalJson,
} from "./insight-artifact-scalars";
import { err, ok, type Result } from "./result";

// Closed schemas from astra-contract-r2 section 7 plus the 2026-10-20 erratum; objects without a codec yet (CandidateRoot, DraftRoot, Operation, Receipt) stay R<X> descriptors.

const reference = insightArtifactReferenceSchema;
const nullableReference = v.nullable(reference);
const index = insightArtifactIndexDescriptorSchema;

// Pre-capture statuses: the only ones a journal may hold while its first CandidateRoot is uncommitted.
const PRE_CAPTURE_STATUSES: ReadonlyArray<string> = [
  "queued",
  "preparing",
  "cancelling",
  "cancelled",
  "failed",
  "superseded",
];

const journalStateSchema = v.pipe(
  v.strictObject({
    binding: reference,
    generation: insightArtifactUnsignedSchema,
    candidate: nullableReference,
    draft: nullableReference,
    checkpoint: nullableReference,
    checkpointVersion: insightArtifactUnsignedSchema,
    authorization: reference,
    policy: reference,
    dispatches: index,
    usage: reference,
    seal: nullableReference,
    status: v.picklist([
      "queued",
      "preparing",
      "running",
      "waiting",
      "paused",
      "cancelling",
      "cancelled",
      "failed",
      "superseded",
      "complete",
    ]),
    cancelEpoch: insightArtifactUnsignedSchema,
    failure: nullableReference,
    publication: nullableReference,
  }),
  v.check(
    (state) =>
      state.candidate !== null ||
      (PRE_CAPTURE_STATUSES.includes(state.status) &&
        state.draft === null &&
        state.checkpoint === null &&
        state.seal === null &&
        state.publication === null &&
        state.dispatches.count === 0),
    "A journal without a CandidateRoot must be pre-capture with no draft, checkpoint, seal, publication or dispatch.",
  ),
  v.check(
    (state) =>
      state.failure !== null ||
      !["failed", "cancelled", "superseded", "paused"].includes(state.status),
    "A failed, cancelled, superseded or paused journal must name its FailureRecord.",
  ),
);

const journalHeadSchema = v.strictObject({
  runId: insightArtifactRunIdSchema,
  sequence: insightArtifactUnsignedSchema,
  previous: nullableReference,
  transaction: nullableReference,
  state: reference,
  receipts: index,
  transactions: index,
});

const localIntentSchema = v.pipe(
  v.strictObject({
    transactionId: insightArtifactIdSchema,
    runId: insightArtifactRunIdSchema,
    expectedSequence: insightArtifactUnsignedSchema,
    expectedHead: nullableReference,
    operation: nullableReference,
    receipt: nullableReference,
    nextState: reference,
    nextReceipts: index,
    objects: index,
    createdAt: insightArtifactTimeSchema,
  }),
  v.check(
    (intent) =>
      (intent.operation === null) === (intent.receipt === null) &&
      (intent.expectedSequence === 0) === (intent.expectedHead === null),
    "An internal transaction has a null operation and receipt together; only the first transaction has no expected head.",
  ),
);

const transactionEntrySchema = v.strictObject({
  sequence: insightArtifactPositiveSchema,
  intent: reference,
});

// Registered-name membership is checked by whichever reader dereferences the digest's root.
const objectDigestSchema = v.strictObject({
  schema: v.pipe(
    v.string(),
    v.maxLength(64),
    v.regex(/^[A-Z][A-Za-z0-9]*(?:<[A-Z][A-Za-z0-9]*>)?$/),
  ),
  root: reference,
});

const journalPointerSchema = v.strictObject({
  format: v.literal(2),
  runId: insightArtifactRunIdSchema,
  sequence: insightArtifactUnsignedSchema,
  head: reference,
});

const pendingIntentLocatorSchema = v.strictObject({
  format: v.literal(2),
  runId: insightArtifactRunIdSchema,
  intent: reference,
});

export const insightJournalStateCodec: InsightArtifactCodec<
  typeof journalStateSchema
> = { name: "JournalState", schema: journalStateSchema };

export const insightJournalHeadCodec: InsightArtifactCodec<
  typeof journalHeadSchema
> = { name: "JournalHead", schema: journalHeadSchema };

export const insightLocalIntentCodec: InsightArtifactCodec<
  typeof localIntentSchema
> = { name: "LocalIntent", schema: localIntentSchema };

export const insightTransactionEntryCodec: InsightArtifactCodec<
  typeof transactionEntrySchema
> = { name: "TransactionEntry", schema: transactionEntrySchema };

export const insightObjectDigestCodec: InsightArtifactCodec<
  typeof objectDigestSchema
> = { name: "ObjectDigest", schema: objectDigestSchema };

/** Parsed journal state; the references it names are not followed. */
export type InsightJournalState = v.InferOutput<typeof journalStateSchema>;

/** Parsed head; the chain behind `previous` is not followed. */
export type InsightJournalHead = v.InferOutput<typeof journalHeadSchema>;

/** Parsed intent; the objects it lists are not followed. */
export type InsightLocalIntent = v.InferOutput<typeof localIntentSchema>;

/** Direct canonical pointer, not a wrapped immutable object. */
export type InsightJournalPointer = v.InferOutput<typeof journalPointerSchema>;

/** Direct canonical locator naming the one intent a writer may have left uncommitted; it is not authoritative by itself. */
type InsightPendingIntentLocator = v.InferOutput<
  typeof pendingIntentLocatorSchema
>;

type InvalidInsightJournalBytes = {
  readonly _tag: "InvalidInsightJournalBytes";
};

export function parseInsightJournalPointer(
  bytes: Uint8Array,
): Result<InsightJournalPointer, InvalidInsightJournalBytes> {
  const parsed = parseInsightArtifactCanonicalJson(bytes, journalPointerSchema);
  return parsed._tag === "ok"
    ? parsed
    : err({ _tag: "InvalidInsightJournalBytes" });
}

export function encodeInsightJournalPointer(
  value: InsightJournalPointer,
): Result<Uint8Array, InvalidInsightJournalBytes> {
  const encoded = encodeInsightArtifactDirect(journalPointerSchema, value);
  return encoded._tag === "ok"
    ? ok(encoded.value)
    : err({ _tag: "InvalidInsightJournalBytes" });
}

export function parseInsightPendingIntentLocator(
  bytes: Uint8Array,
): Result<InsightPendingIntentLocator, InvalidInsightJournalBytes> {
  const parsed = parseInsightArtifactCanonicalJson(
    bytes,
    pendingIntentLocatorSchema,
  );
  return parsed._tag === "ok"
    ? parsed
    : err({ _tag: "InvalidInsightJournalBytes" });
}

export function encodeInsightPendingIntentLocator(
  value: InsightPendingIntentLocator,
): Result<Uint8Array, InvalidInsightJournalBytes> {
  const encoded = encodeInsightArtifactDirect(
    pendingIntentLocatorSchema,
    value,
  );
  return encoded._tag === "ok"
    ? ok(encoded.value)
    : err({ _tag: "InvalidInsightJournalBytes" });
}
