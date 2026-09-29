import * as v from "valibot";
import {
  toJsonSchema,
  type JsonSchema,
  type OverrideSchemaContext,
} from "@valibot/to-json-schema";

import { briefOutputSchema } from "../domain/brief";
import type { RawJsonValue } from "../domain/json";
import { modelReviewResultSchema } from "../domain/review-result";
import { walkthroughOutputSchema } from "./walkthrough-operation";

/**
 * Codex sends `turn/start` output schemas to the Responses API in strict mode:
 * every object must be closed and require every property, a `const` needs a
 * `type`, and `not` is unsupported. An optional Valibot field becomes a
 * required nullable one here, and `parseCodexStrictResult` turns its `null`
 * back into an absent key.
 */
function codexOutputSchema(schema: v.GenericSchema): JsonSchema {
  return toJsonSchema(schema, {
    // Checks JSON Schema cannot carry, such as the Walkthrough's aggregate
    // section limit, stay with Patchdesk's own validation after the turn.
    errorMode: "ignore",
    overrideSchema: strictCodexNode,
  });
}

function strictCodexNode({
  valibotSchema,
  jsonSchema,
}: OverrideSchemaContext): JsonSchema | undefined {
  // Valibot emits only { const: 2 } for a literal.
  if (valibotSchema.type === "literal" && jsonSchema.const === 2)
    return { type: "integer", enum: [2] };
  // An array of `v.never()` can only be empty; Valibot emits { not: {} } items.
  if (
    jsonSchema.type === "array" &&
    v.is(v.object({ not: v.object({}) }), jsonSchema.items)
  )
    return { ...jsonSchema, items: { type: "null" }, maxItems: 0 };
  if (jsonSchema.type === "object" && jsonSchema.properties !== undefined) {
    const required = new Set(jsonSchema.required);
    const properties = Object.fromEntries(
      Object.entries(jsonSchema.properties).map(([key, property]) => [
        key,
        required.has(key)
          ? property
          : { anyOf: [property, { type: "null" as const }] },
      ]),
    );
    return { ...jsonSchema, properties, required: Object.keys(properties) };
  }
  return undefined;
}

/** Codex's constraint for a Brief turn, derived from `briefOutputSchema`. */
export const briefCodexOutputSchema = codexOutputSchema(briefOutputSchema);

/** Codex's constraint for an Analysis turn, derived from `modelReviewResultSchema`. */
export const analysisCodexOutputSchema = codexOutputSchema(
  modelReviewResultSchema,
);

/** Codex's constraint for a Walkthrough turn; Patchdesk still checks the aggregate section rule after the turn. */
export const walkthroughCodexOutputSchema = codexOutputSchema(
  walkthroughOutputSchema,
);

const codexStrictResultSchema: v.GenericSchema<RawJsonValue> = v.lazy(() =>
  v.union([
    v.string(),
    v.number(),
    v.boolean(),
    v.null(),
    v.array(codexStrictResultSchema),
    v.pipe(
      v.record(v.string(), codexStrictResultSchema),
      v.transform((fields) =>
        Object.fromEntries(
          Object.entries(fields).filter(([, field]) => field !== null),
        ),
      ),
    ),
  ]),
);

/**
 * Drops every `null` object field from a Codex result produced under a strict
 * output schema, so an optional field the model left empty is absent again
 * before Patchdesk's own schema validates it. Array items are kept as sent.
 */
export function parseCodexStrictResult(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the Codex turn result's own I/O boundary; the next statement parses it as JSON before anything reads it.
  input: unknown,
): RawJsonValue | undefined {
  const parsed = v.safeParse(codexStrictResultSchema, input);
  return parsed.success ? parsed.output : undefined;
}
