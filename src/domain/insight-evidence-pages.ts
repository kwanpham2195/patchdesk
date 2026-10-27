/** Measures a text evidence result after API JSON escaping. */
export function encodedEvidenceResponseBytes(text: string): number {
  return new TextEncoder().encode(
    JSON.stringify({ content: [{ type: "text", text }] }),
  ).length;
}
