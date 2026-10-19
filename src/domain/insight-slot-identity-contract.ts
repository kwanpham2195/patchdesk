import * as v from "valibot";

import type { InsightArtifactCodec } from "./insight-artifact-index";
import {
  insightTextRootDescriptorSchema,
  parseInsightArtifactCanonicalJson,
} from "./insight-artifact-scalars";
import { err, ok, type Result } from "./result";

const slotIdentityDescriptorSchema = v.strictObject({
  profileId: insightTextRootDescriptorSchema,
  reviewId: insightTextRootDescriptorSchema,
  type: v.picklist(["analysis", "walkthrough", "brief", "guide"]),
});

const wrappedSlotIdentityDescriptorSchema = v.strictObject({
  format: v.literal(2),
  schema: v.literal("SlotIdentity"),
  value: slotIdentityDescriptorSchema,
});

/** Parsed descriptors only; the storage reader verifies the profileId and reviewId text bytes against the slot's own IDs. */
export type InsightSlotIdentityDescriptor = v.InferOutput<
  typeof slotIdentityDescriptorSchema
>;

/** Parses the exact canonical wrapper without following any index, blob or text reference. */
export function parseWrappedInsightSlotIdentityDescriptor(
  bytes: Uint8Array,
): Result<
  InsightSlotIdentityDescriptor,
  { readonly _tag: "InvalidInsightSlotIdentityDescriptor" }
> {
  const parsed = parseInsightArtifactCanonicalJson(
    bytes,
    wrappedSlotIdentityDescriptorSchema,
  );
  return parsed._tag === "err"
    ? err({ _tag: "InvalidInsightSlotIdentityDescriptor" })
    : ok(parsed.value.value);
}

/** The only registered SlotIdentity wrapper; writers encode through `encodeWrappedInsightArtifact`. */
export const insightSlotIdentityCodec: InsightArtifactCodec<
  typeof slotIdentityDescriptorSchema
> = { name: "SlotIdentity", schema: slotIdentityDescriptorSchema };
