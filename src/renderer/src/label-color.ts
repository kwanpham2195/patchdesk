/**
 * Picks the more-readable of pure black or pure white text for a GitHub
 * label's background color, using the actual WCAG contrast ratio against
 * each — not a single guessed brightness threshold. Defensive against a
 * malformed hex string (falls back to black text, the safer default against
 * an unexpectedly light/invalid background).
 */
export function labelForeground(hexColor: string): "#000000" | "#ffffff" {
  const rgb = parseHex(hexColor);
  if (rgb === undefined) return "#000000";
  const bgLuminance = relativeLuminance(rgb);
  const contrastWithBlack = contrastRatio(bgLuminance, 0);
  const contrastWithWhite = contrastRatio(bgLuminance, 1);
  return contrastWithWhite > contrastWithBlack ? "#ffffff" : "#000000";
}

function parseHex(
  input: string,
): { readonly r: number; readonly g: number; readonly b: number } | undefined {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(input.trim());
  if (match?.[1] === undefined) return undefined;
  const value = match[1];
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function relativeLuminance(rgb: {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}): number {
  const linearize = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * linearize(rgb.r) +
    0.7152 * linearize(rgb.g) +
    0.0722 * linearize(rgb.b)
  );
}

function contrastRatio(luminanceA: number, luminanceB: number): number {
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}
