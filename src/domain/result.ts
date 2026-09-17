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

/**
 * Compiles only when `T` is `never`, so an exported alias over a set
 * difference fails the build, naming that alias, when the difference is not
 * empty.
 *
 * @template T The set difference that must be empty.
 */
export type AssertNever<T extends never> = T;

/**
 * Ends a switch over a closed union: adding a variant fails to compile at the
 * call site, and reaching it at runtime is a defect, so it throws. The message
 * names only the value's `_tag`, when it has one.
 */
export function casesHandled(unexpected: never): never {
  const value: unknown = unexpected;
  const tag =
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- picks a defect message's label, not decoding input against a contract.
    typeof value === "object" && value !== null && "_tag" in value
      ? String(value._tag)
      : String(value);
  throw new Error(`Unhandled case: ${tag}`);
}
