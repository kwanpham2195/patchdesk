import { guideModelOutputSchema } from "#src/domain/guide";
import * as v from "valibot";
import {
  toJsonSchema,
  type JsonSchema,
  type OverrideSchemaContext,
} from "@valibot/to-json-schema";

import { briefOutputSchema } from "#src/domain/brief";
import type { RawJsonValue } from "#src/domain/json";
import {
  analysisInvocationOutcomeSchema,
  analysisInvocationEnvelopeSchema,
  parseAnalysisInvocationOutcome,
  type AnalysisInvocationOutcome,
} from "#src/domain/analysis-invocation-outcome";
import { err, type Result } from "#src/domain/result";

/**
 * Codex sends `turn/start` output schemas to the Responses API in strict mode:
 * every object must be closed and require every property, a `const` needs a
 * `type`, and `not` is unsupported. An optional Valibot field becomes a
 * required nullable one here, and `parseCodexStrictResult` turns its `null`
 * back into an absent key.
 */
function codexOutputSchema(schema: v.GenericSchema): JsonSchema {
  return toJsonSchema(schema, {
    // Semantic checks that JSON Schema cannot carry stay with validation after the turn.
    errorMode: "ignore",
    overrideSchema: strictCodexNode,
  });
}

function strictCodexNode({
  valibotSchema,
  jsonSchema,
}: OverrideSchemaContext): JsonSchema | undefined {
  // Strict output requires an explicit type for literal values.
  if (valibotSchema.type === "literal" && jsonSchema.const !== undefined)
    return {
      type: v.is(v.string(), jsonSchema.const) ? "string" : "integer",
      enum: [jsonSchema.const],
    };
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

/** Codex requires a closed object root with required nullable terminal payloads. */
export const analysisCodexOutputSchema = codexOutputSchema(
  analysisInvocationOutcomeSchema,
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

/** Guide uses its exact strict model contract for every account turn. */
export const guideCodexOutputSchema = codexOutputSchema(guideModelOutputSchema);

/** Preserve required envelope nulls while decoding optional fields inside its result. */
export function parseCodexAnalysisOutcome(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the native turn is unvalidated JSON; this boundary parses its strict envelope before reading it.
  input: unknown,
): Result<AnalysisInvocationOutcome, "invalid_result"> {
  const envelope = v.safeParse(analysisInvocationEnvelopeSchema, input);
  if (!envelope.success) return err("invalid_result");
  return parseAnalysisInvocationOutcome({
    ...envelope.output,
    result:
      envelope.output.result === null
        ? null
        : parseCodexStrictResult(envelope.output.result),
  });
}
