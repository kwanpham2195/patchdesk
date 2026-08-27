/**
 * The optional-property view of `T`: every key becomes optional and loses
 * `undefined` from its value type. Under `exactOptionalPropertyTypes` this is
 * exactly what a target with optional properties accepts — an absent key,
 * never a present key holding `undefined`.
 */
export type DefinedProps<T extends object> = {
  [K in keyof T]?: Exclude<T[K], undefined>;
};

/**
 * Copy only the keys whose value is not `undefined`, for
 * `exactOptionalPropertyTypes` targets.
 *
 * Spread the result to add a property only when it is present:
 * `{ ...definedProps({ path, line }) }` replaces the conditional empty-object
 * spreads that hid omission behind a ternary. `null` is a value and is kept;
 * only `undefined` is dropped.
 */
export function definedProps<T extends object>(input: T): DefinedProps<T> {
  // SAFETY: `Object.fromEntries` cannot express that the result keeps `T`'s
  // keys and value types. `Object.entries` reads `T`'s own enumerable
  // string-keyed properties; the filter then removes exactly the entries whose
  // value is `undefined`, so every surviving key `K` still holds a `T[K]` that
  // is not `undefined`, and every dropped key is absent — which is what
  // `DefinedProps<T>` declares. `DefinedProps<T>` is a homomorphic map over
  // `keyof T`, so it also declares symbol keys, and non-enumerable and
  // inherited properties, that `Object.entries` does not copy: the result is
  // the string-keyed own subset of what the type promises. Every call site
  // passes a freshly written object literal with string keys, so the two
  // coincide there.
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as DefinedProps<T>;
}
