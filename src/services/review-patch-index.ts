import { parseUnifiedPatch, type ParsedPatchFile } from "../domain/patch";

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
    const starts = Array.from(source.matchAll(/^diff --git /gm)).map((match) => match.index ?? 0);
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
    return entry === undefined ? undefined : this.source.slice(entry.start, entry.end);
  }
}
