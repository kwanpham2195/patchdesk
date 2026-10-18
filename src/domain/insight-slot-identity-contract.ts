import * as v from "valibot";

import {
  insightArtifactHashSchema,
  insightArtifactReferenceSchema,
  insightArtifactUnsignedSchema,
  parseInsightArtifactCanonicalJson,
} from "./insight-artifact-scalars";
import { err, ok, type Result } from "./result";

const bytesRootDescriptorSchema = v.strictObject({
  blocks: v.strictObject({
    root: insightArtifactReferenceSchema,
    count: insightArtifactUnsignedSchema,
  }),
  bytes: insightArtifactUnsignedSchema,
  sha256: insightArtifactHashSchema,
});

const textRootDescriptorSchema = v.strictObject({
  data: bytesRootDescriptorSchema,
  utf16Units: insightArtifactUnsignedSchema,
});

const slotIdentityDescriptorSchema = v.strictObject({
  profileId: textRootDescriptorSchema,
  reviewId: textRootDescriptorSchema,
  type: v.picklist(["analysis", "walkthrough", "brief", "guide"]),
});

const wrappedSlotIdentityDescriptorSchema = v.strictObject({
  format: v.literal(2),
  schema: v.literal("SlotIdentity"),
  value: slotIdentityDescriptorSchema,
});

/** Descriptor metadata only; referenced text, decoded domain IDs and their equality remain unvalidated. */
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
