import { PatchDiff } from "@pierre/diffs/react";

/** App-owned Pierre adapter; callers pass raw unified patch text, never library-specific state. */
export function ReviewDiffView({ patch, selectedPath }: { readonly patch: string; readonly selectedPath?: string }): React.JSX.Element {
  const selectedPatch = selectPatch(patch, selectedPath);
  const browserSupportsPierre = typeof CSSStyleSheet !== "undefined" && "replaceSync" in CSSStyleSheet.prototype;
  return <section aria-label="Review diff" data-selected-path={selectedPath}>{browserSupportsPierre ? <PatchDiff patch={selectedPatch} disableWorkerPool /> : <pre>{selectedPatch}</pre>}</section>;
}

function selectPatch(patch: string, selectedPath: string | undefined): string {
  const files = patch.split(/(?=^diff --git )/m).filter((value) => value.startsWith("diff --git "));
  return files.find((value) => selectedPath !== undefined && value.includes(` b/${selectedPath}`)) ?? files[0] ?? patch;
}
