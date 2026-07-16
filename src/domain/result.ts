/** A typed success or expected failure returned by pure Patchdesk domain modules. */
export type Result<T, E> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly error: E };

/** Construct a successful domain result. */
export function ok<T>(value: T): Result<T, never> {
  return { _tag: "ok", value };
}

/** Construct a typed expected domain failure. */
export function err<E>(error: E): Result<never, E> {
  return { _tag: "err", error };
}
