import {
  EVIDENCE_PAGE_BYTES,
  EVIDENCE_PAGE_LINES,
  EVIDENCE_RECORD_BYTES,
  parseEvidencePageId,
  type EvidencePageId,
  type EvidenceRecord,
} from "./insight-evidence";

/** Packs final records with reserved header and continuation space. */
export class InsightEvidencePages {
  private next = 1;
  private readonly output: Array<{
    readonly id: EvidencePageId;
    readonly text: string;
    readonly records: ReadonlyArray<EvidenceRecord>;
  }> = [];
  constructor(private readonly bundleId: string) {}

  /** A chain always has at least one page, including an intentionally empty source. */
  add(records: ReadonlyArray<EvidenceRecord>): EvidencePageId {
    const groups: Array<Array<EvidenceRecord>> = [[]];
    let bytes = 0;
    for (const record of records) {
      const size = new TextEncoder().encode(
        JSON.stringify(record) + "\n",
      ).length;
      if (size > EVIDENCE_RECORD_BYTES)
        throw new Error("Evidence record exceeds bound");
      let group = groups.at(-1);
      if (group === undefined) throw new Error("Evidence page group missing");
      // Two records are reserved for the header and continuation; their combined encoding fits 512 bytes.
      if (
        bytes + size > EVIDENCE_PAGE_BYTES - 512 ||
        group.length >= EVIDENCE_PAGE_LINES - 2
      ) {
        group = [];
        groups.push(group);
        bytes = 0;
      }
      group.push(record);
      bytes += size;
    }
    const ids = groups.map(() => {
      const id = parseEvidencePageId(`${this.bundleId}-p${this.next++}`);
      if (id === undefined) throw new Error("Evidence page identifier invalid");
      return id;
    });
    for (const [index, group] of groups.entries()) {
      const id = ids[index];
      if (id === undefined) throw new Error("Evidence page identifier missing");
      const text = [
        JSON.stringify({ kind: "page", bundleId: this.bundleId, pageId: id }),
        ...group.map((record) => JSON.stringify(record)),
        JSON.stringify({
          kind: "continuation",
          pageId: ids[index + 1] ?? null,
        }),
        "",
      ].join("\n");
      if (
        new TextEncoder().encode(text).length > EVIDENCE_PAGE_BYTES ||
        text.split("\n").length - 1 > EVIDENCE_PAGE_LINES
      )
        throw new Error("Evidence page exceeds bound");
      this.output.push({ id, text, records: group });
    }
    const first = ids[0];
    if (first === undefined) throw new Error("Evidence chain missing");
    return first;
  }

  /** Returns final encoded pages; callers attach parent-held digests before storage. */
  pages(): ReadonlyArray<{
    readonly id: EvidencePageId;
    readonly text: string;
    readonly records: ReadonlyArray<EvidenceRecord>;
  }> {
    return this.output;
  }
}
