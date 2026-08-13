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

/** Read-only Conversation data that can cross into an Insight without GitHub capabilities. */
export type ReadOnlyConversationAnnotation = {
  readonly id: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly side: "new" | "old";
  readonly state: "open" | "resolved";
  readonly complete?: boolean;
  readonly comments: ReadonlyArray<{
    readonly id: string;
    readonly author: string;
    readonly body: string;
    readonly createdAt: string;
    readonly updatedAt?: string | undefined;
  }>;
};

export type CitedHunkRelation = "exact" | "partial";

/** Maps only current, fully represented GitHub thread ranges into the active Diff. */
export function mapConversationThread(
  files: ReadonlyArray<ParsedPatchFile>,
  thread: {
    readonly state: "open" | "resolved" | "outdated" | "unknown";
    readonly location?:
      | {
          readonly path: string;
          readonly line?: number | undefined;
          readonly lineEnd?: number | undefined;
          readonly diffSide?: "new" | "old" | undefined;
        }
      | undefined;
  },
): MappedConversationThread | ExcludedConversationThread {
  if (thread.state === "outdated")
    return { _tag: "Excluded", reason: "outdated" };
  const location = thread.location;
  if (location?.line === undefined || location.diffSide === undefined)
    return { _tag: "Excluded", reason: "unanchored" };

  const start = location.line;
  const end = location.lineEnd ?? location.line;
  if (start > end) return { _tag: "Excluded", reason: "unmapped" };
  const file = files.find(
    (candidate) =>
      candidate.newPath === location.path ||
      candidate.oldPath === location.path,
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

/** Projects mapped Conversation data without mutation callbacks or authoring capability. */
export function projectReadOnlyConversationAnnotations(
  files: ReadonlyArray<ParsedPatchFile>,
  threads: ReadonlyArray<{
    readonly id: string;
    readonly state: "open" | "resolved" | "outdated" | "unknown";
    readonly complete?: boolean | undefined;
    readonly comments: ReadOnlyConversationAnnotation["comments"];
    readonly location?:
      | {
          readonly path: string;
          readonly line?: number | undefined;
          readonly lineEnd?: number | undefined;
          readonly diffSide?: "new" | "old" | undefined;
        }
      | undefined;
  }>,
): ReadonlyArray<ReadOnlyConversationAnnotation> {
  return threads.flatMap((thread) => {
    const mapped = mapConversationThread(files, thread);
    if (
      mapped._tag !== "Mapped" ||
      (thread.state !== "open" && thread.state !== "resolved")
    )
      return [];
    return [
      {
        id: thread.id,
        path: mapped.path,
        start: mapped.start,
        end: mapped.end,
        side: mapped.side,
        state: thread.state,
        ...(thread.complete === undefined ? {} : { complete: thread.complete }),
        comments: thread.comments,
      },
    ];
  });
}

/** Finds a same-side cited hunk that intersects the inclusive mapped thread range. */
export function citedHunkRelation(
  annotation: Pick<
    ReadOnlyConversationAnnotation,
    "path" | "start" | "end" | "side"
  >,
  hunk: {
    readonly path: string;
    readonly oldStart: number;
    readonly oldLines: number;
    readonly newStart: number;
    readonly newLines: number;
  },
): CitedHunkRelation | undefined {
  if (annotation.path !== hunk.path) return undefined;
  const start = annotation.side === "new" ? hunk.newStart : hunk.oldStart;
  const count = annotation.side === "new" ? hunk.newLines : hunk.oldLines;
  const end = start + count - 1;
  if (count <= 0 || annotation.end < start || annotation.start > end)
    return undefined;
  return annotation.start >= start && annotation.end <= end
    ? "exact"
    : "partial";
}
