import type { FileDiffMetadata } from "@pierre/diffs";

/** Identifies a non-deleted Markdown file whose complete verified head text is available. */
export function canPreviewMarkdownFile(
  file: Pick<FileDiffMetadata, "name" | "type">,
  verifiedHeadText: string | undefined,
): verifiedHeadText is string {
  return (
    file.type !== "deleted" &&
    /\.(?:md|markdown)$/i.test(file.name) &&
    verifiedHeadText !== undefined
  );
}
