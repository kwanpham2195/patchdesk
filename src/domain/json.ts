import * as v from "valibot";

/**
 * A value that arrived across a JSON I/O boundary and has not yet been
 * parsed into a domain type. This is deliberately the JSON value grammar —
 * not `unknown` — so a boundary parser can name what it actually receives
 * before running its own schema/field parsing against it.
 */
export type RawJsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<RawJsonValue>
  | { readonly [key: string]: RawJsonValue };

/**
 * Parses the JSON value grammar itself. Use it where a schema has to accept a
 * caller-shaped payload whose keys are not known ahead of time but which must
 * still survive a JSON round trip — `unknown` would accept values that cannot.
 */
export const rawJsonValueSchema: v.GenericSchema<RawJsonValue> = v.lazy(() =>
  v.union([
    v.string(),
    v.number(),
    v.boolean(),
    v.null(),
    v.array(rawJsonValueSchema),
    v.record(v.string(), rawJsonValueSchema),
  ]),
);
