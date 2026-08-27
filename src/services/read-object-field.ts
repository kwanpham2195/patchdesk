import type { RawJsonValue } from "../domain/json";

/**
 * Reads one own property from a parsed JSON object that arrived at an I/O
 * boundary. Callers must still parse the returned value into their domain
 * input before using it; this only names the grammar it is already in.
 */
export function readObjectField(
  value: unknown,
  name: string,
): RawJsonValue | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.hasOwn(value, name)
  ) {
    return undefined;
  }
  // SAFETY: the guard above established that `value` is a non-null object
  // carrying its own `name` property, so the read finds a real own field
  // rather than walking the prototype chain or returning `undefined` for a
  // key that is absent. The ELEMENT type is not checked here and cannot be:
  // `RawJsonValue` restates this function's documented contract -- callers
  // hand it a value already inside the JSON grammar -- and the field is
  // returned unparsed for the caller to narrow.
  return (value as { readonly [key: string]: RawJsonValue })[name];
}
