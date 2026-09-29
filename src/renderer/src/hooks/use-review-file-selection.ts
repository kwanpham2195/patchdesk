import { useMemo } from "react";

import { parseUnifiedPatch } from "../../../domain/patch";

/** Resolves one file in the displayed patch for both the diff and navigator. */
export function useReviewFileSelection({
  patch,
  ready,
  visiblePaths,
  selectedPath,
  activePath,
  preferSelectedPath,
}: {
  readonly patch: string | undefined;
  readonly ready: boolean;
  readonly visiblePaths: ReadonlySet<string> | undefined;
  readonly selectedPath: string | undefined;
  readonly activePath: string | undefined;
  /** A commit slice and Selected mode highlight the file shown by the pane. */
  readonly preferSelectedPath: boolean;
}) {
  const paths = useMemo(
    () =>
      patch === undefined || !ready
        ? []
        : parseUnifiedPatch(patch).flatMap((file) =>
            visiblePaths === undefined || visiblePaths.has(file.newPath)
              ? [file.newPath]
              : [],
          ),
    [patch, ready, visiblePaths],
  );
  const chosen = selectedPath !== undefined && paths.includes(selectedPath);
  const resolvedPath =
    !ready || patch === undefined
      ? undefined
      : chosen
        ? selectedPath
        : activePath !== undefined && paths.includes(activePath)
          ? activePath
          : paths[0];
  return {
    selectedPath: resolvedPath,
    /** No file was chosen, so the selection is whichever file the diff reports active. */
    selectionFollowsActive: !chosen,
    activePath:
      !preferSelectedPath &&
      activePath !== undefined &&
      paths.includes(activePath)
        ? activePath
        : resolvedPath,
  };
}
