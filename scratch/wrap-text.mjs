/**
 * Wraps text to a maximum line width, breaking only at spaces.
 * A word longer than the width is kept whole on its own line.
 */
export function wrapText(text, width) {
  if (!Number.isInteger(width) || width < 1) {
    throw new RangeError("width must be a positive integer");
  }
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(" ").filter((w) => w.length > 0)) {
      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length <= width) {
        current += " " + word;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines.join("\n");
}

/** Returns the length of the longest line in the wrapped text. */
export function longestLine(text) {
  return Math.max(...text.split("\n").map((line) => line.length));
}
