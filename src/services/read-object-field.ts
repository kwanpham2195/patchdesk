/**
 * Reads one own property from an unknown boundary object. Callers must still
 * parse the returned value into their domain input before using it.
 */
export function readObjectField(value: unknown, name: string): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.hasOwn(value, name)
  ) {
    return undefined;
  }
  return (value as Record<string, unknown>)[name];
}
