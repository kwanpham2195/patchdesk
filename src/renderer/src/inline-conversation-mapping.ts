import type { ParsedPatchFile } from "../../domain/patch";

export type MappedConversationThread = {
  readonly _tag: "Mapped";
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly side: "new" | "old";
};

export type ExcludedConversationThread = {
  readonly _tag: "Excluded";
  readonly reason: "outdated" | "unanchored" | "unmapped";
};

/** Maps only current, fully represented GitHub thread ranges into the active Diff. */
export function mapConversationThread(
  files: ReadonlyArray<ParsedPatchFile>,
  thread: {
    readonly state: "open" | "resolved" | "outdated" | "unknown";
    readonly location?: {
      readonly path: string;
      readonly line?: number | undefined;
      readonly lineEnd?: number | undefined;
      readonly diffSide?: "new" | "old" | undefined;
    } | undefined;
  },
): MappedConversationThread | ExcludedConversationThread {
  if (thread.state === "outdated") return { _tag: "Excluded", reason: "outdated" };
  const location = thread.location;
  if (
    location?.line === undefined ||
    location.diffSide === undefined
  )
    return { _tag: "Excluded", reason: "unanchored" };

  const start = location.line;
  const end = location.lineEnd ?? location.line;
  if (start > end) return { _tag: "Excluded", reason: "unmapped" };
  const file = files.find(
    (candidate) =>
      candidate.newPath === location.path || candidate.oldPath === location.path,
  );
  if (file === undefined || file.kind === "binary" || file.kind === "omitted")
    return { _tag: "Excluded", reason: "unmapped" };

  const side = location.diffSide;
  const lines = side === "new" ? file.newLines : file.oldLines;
  for (let line = start; line <= end; line += 1) {
    if (!lines.has(line)) return { _tag: "Excluded", reason: "unmapped" };
  }
  return {
    _tag: "Mapped",
    path: side === "new" ? file.newPath : file.oldPath,
    start,
    end,
    side,
  };
}
