import { useEffect } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";

import type { FileChangeStats } from "@/review-diff-data";

export type PierreFileTreeItem = { readonly path: string; readonly stats: FileChangeStats };

/** Pierre owns tree focus and scrolling; selection only reveals the matching diff file. */
export function PierreFileTree({ files, selectedPath, onSelect }: { readonly files: ReadonlyArray<PierreFileTreeItem>; readonly selectedPath?: string; readonly onSelect: (path: string) => void }): React.JSX.Element {
  const { model } = useFileTree({ paths: files.map((file) => file.path), initialExpansion: "open", search: true, onSelectionChange: (paths) => { const path = paths[0]; if (path !== undefined) onSelect(path); } });
  useEffect(() => { if (selectedPath !== undefined) model.scrollToPath(selectedPath, { focus: false }); }, [model, selectedPath]);
  return <FileTree model={model} aria-label="Changed files" style={{ height: "100%", minHeight: 0 }} />;
}
