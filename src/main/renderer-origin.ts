/** Returns the renderer origin or the fail-closed opaque origin. */
export function rendererOrigin(value: string | undefined): string {
  if (value === undefined || !URL.canParse(value)) return "null";
  return new URL(value).origin;
}
