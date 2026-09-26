/** Heading text on one line: a newline in model text would end the heading and spill the rest into the body. */
export function markdownHeadingText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
