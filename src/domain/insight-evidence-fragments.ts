import {
  EVIDENCE_RECORD_BYTES,
  type EvidenceFragment,
  type EvidenceSite,
} from "./insight-evidence";

/** Splits at Unicode code point boundaries after measuring the escaped JSON record. */
export function fragmentEvidenceText(input: {
  readonly sourceId: string;
  readonly text: string;
  readonly byteStart: number;
  readonly site: EvidenceSite;
}): ReadonlyArray<EvidenceFragment> {
  const fragments: Array<EvidenceFragment> = [];
  let text = "";
  let byteStart = input.byteStart;
  const record = (value: string, continued: boolean): EvidenceFragment => ({
    kind: "fragment",
    sourceId: input.sourceId,
    ...input.site,
    byteStart,
    byteEnd: byteStart + new TextEncoder().encode(value).length,
    fragmentIndex: fragments.length,
    continued,
    text: value,
  });
  for (const character of input.text) {
    const candidate = record(text + character, true);
    if (
      new TextEncoder().encode(JSON.stringify(candidate) + "\n").length >
      EVIDENCE_RECORD_BYTES
    ) {
      if (text.length === 0)
        throw new Error("Evidence fragment metadata exceeds record bound");
      const completed = record(text, true);
      fragments.push(completed);
      byteStart = completed.byteEnd;
      text = character;
    } else text += character;
  }
  if (text.length > 0 || input.text.length === 0)
    fragments.push(record(text, false));
  return fragments;
}

/** Retains physical source lines and exact LF/CRLF/final-newline bytes before fragmenting. */
export function fragmentEvidenceLines(input: {
  readonly sourceId: string;
  readonly text: string;
  readonly site: EvidenceSite;
}): ReadonlyArray<EvidenceFragment> {
  let byteStart = 0;
  const lines = input.text.split("\n");
  return lines.flatMap((line, index) => {
    const text = line + (index < lines.length - 1 ? "\n" : "");
    const fragments = fragmentEvidenceText({
      sourceId: input.sourceId,
      text,
      byteStart,
      site: { ...input.site, sourceLine: index + 1 },
    });
    byteStart += new TextEncoder().encode(text).length;
    return fragments;
  });
}
