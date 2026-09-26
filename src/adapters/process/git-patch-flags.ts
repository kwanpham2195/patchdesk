/**
 * `git diff` flags for every patch Patchdesk parses or anchors: a/ and b/ paths from the repository root,
 * raw content, no escape codes, and three context lines, whatever the maintainer's git config says (#494).
 * Note carry reads a file boundary from missing context, so the width cannot follow `diff.context` (#521).
 */
export const canonicalPatchFlags = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--no-relative",
  "--unified=3",
] as const;
