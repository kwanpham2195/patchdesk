import type { WorkbenchResponse } from "./renderer-contracts";

type AnalysisFinding = NonNullable<
  WorkbenchResponse["insights"]["analysis"]["retained"]
>["value"]["findings"][number];

export type FindingSeverity = AnalysisFinding["severity"];

/** How many mapped findings cite one file, and the most severe of them. */
export type FileFindingCount = {
  readonly count: number;
  readonly highest: FindingSeverity;
};

// P0 is the most severe, so the smallest rank wins when picking `highest`.
const SEVERITY_RANK = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
} as const satisfies Record<FindingSeverity, number>;

/** Per-path finding totals for the Browse tree and file headers; unmapped findings are ignored. */
export function countFindingsByPath(
  findings: ReadonlyArray<
    Pick<AnalysisFinding, "file" | "severity" | "mappingStatus">
  >,
): ReadonlyMap<string, FileFindingCount> {
  const counts = new Map<string, FileFindingCount>();
  for (const finding of findings) {
    if (finding.mappingStatus !== "mapped" || finding.file === undefined)
      continue;
    const current = counts.get(finding.file);
    counts.set(finding.file, {
      count: (current?.count ?? 0) + 1,
      highest:
        current === undefined ||
        SEVERITY_RANK[finding.severity] < SEVERITY_RANK[current.highest]
          ? finding.severity
          : current.highest,
    });
  }
  return counts;
}

/** The accessible name for a file's finding badge, e.g. "2 findings, highest P1". */
export function describeFileFindingCount(value: FileFindingCount): string {
  return `${value.count} ${value.count === 1 ? "finding" : "findings"}, highest ${value.highest}`;
}
