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
