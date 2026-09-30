/** Heading text on one line: a newline in model text would end the heading and spill the rest into the body. */
export function markdownHeadingText(text: string): string {
  const line = stripHeadingMarkers(text.replace(/\s+/g, " ").trim());
  return line === "" ? "Untitled" : line;
}

/** Leading `#` markers would nest a second heading inside the first. */
function stripHeadingMarkers(line: string): string {
  return line.replace(/^#+\s*/, "");
}
