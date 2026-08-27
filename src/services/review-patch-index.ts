import { parseUnifiedPatch, type ParsedPatchFile } from "../domain/patch";
import { tokenizeUnifiedPatchLines } from "../domain/unified-patch";

export type IndexedPatchFile = {
  readonly file: ParsedPatchFile;
  readonly start: number;
  readonly end: number;
};

/** One parse of an immutable patch, with byte-exact file slices and rename aliases. */
export class ReviewPatchIndex {
  private readonly aliases = new Map<string, IndexedPatchFile>();

  private constructor(
    readonly source: string,
    readonly files: ReadonlyArray<IndexedPatchFile>,
  ) {
    for (const entry of files) {
      this.aliases.set(entry.file.oldPath, entry);
      this.aliases.set(entry.file.newPath, entry);
    }
  }

  static create(source: string): ReviewPatchIndex {
    const parsed = parseUnifiedPatch(source);
    // Both lists come from the same file-header grammar, so slice n always
    // belongs to parsed file n even for a header git had to quote.
    const starts = fileHeaderOffsets(source);
    const files = parsed.map((file, index) => ({
      file,
      start: starts[index] ?? source.length,
      end: starts[index + 1] ?? source.length,
    }));
    return new ReviewPatchIndex(source, files);
  }

  get(path: string): IndexedPatchFile | undefined {
    return this.aliases.get(path);
  }

  slice(path: string): string | undefined {
    const entry = this.get(path);
    return entry === undefined
      ? undefined
      : this.source.slice(entry.start, entry.end);
  }
}

/** Byte offset in `source` of every `diff --git` line the tokenizer recognizes. */
function fileHeaderOffsets(source: string): ReadonlyArray<number> {
  const lines = source.split("\n");
  const offsets: Array<number> = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  return tokenizeUnifiedPatchLines(lines).flatMap((token) =>
    token.kind === "file_header" ? [offsets[token.index] ?? 0] : [],
  );
}
