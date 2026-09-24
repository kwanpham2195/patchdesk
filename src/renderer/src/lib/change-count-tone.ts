/** The text class for a `+n` or `-n` change count: a zero stays muted so "-0" does not read as a removal. */
export function changeCountToneClass(
  count: number,
  nonZeroClass: string,
): string {
  return count === 0 ? "text-muted-foreground" : nonZeroClass;
}
