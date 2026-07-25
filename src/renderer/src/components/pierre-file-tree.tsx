import { useEffect, useRef } from "react";
import type { GitStatus } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";

import type { FileChangeStats } from "@/review-diff-data";

export type PierreFileTreeItem = {
  readonly path: string;
  readonly stats: FileChangeStats;
  readonly gitStatus: GitStatus | undefined;
};

type PierreFileTreeProps = {
  readonly files: ReadonlyArray<PierreFileTreeItem>;
  readonly selectedPath?: string;
  readonly activePath?: string;
  readonly onSelect: (path: string) => void;
};

/** Pierre owns tree focus and scrolling; selection only reveals the matching diff file. */
export function PierreFileTree(props: PierreFileTreeProps): React.JSX.Element {
  // @pierre/trees beta exposes selection mutation on its controller but not
  // through the public React model type. The keyed fallback applies the same
  // initial selection through the public API when that method is absent; the
  // key changes once per active file, not per scroll event.
  return <PierreFileTreeModel key={props.activePath ?? "no-active-path"} {...props} />;
}

function PierreFileTreeModel({ files, selectedPath, activePath, onSelect }: PierreFileTreeProps): React.JSX.Element {
  const applyingPassivePath = useRef(false);
  const { model } = useFileTree({ paths: files.map((file) => file.path), gitStatus: files.flatMap((file) => file.gitStatus === undefined ? [] : [{ path: file.path, status: file.gitStatus }]), ...(activePath === undefined ? {} : { initialSelectedPaths: [activePath] }), initialExpansion: "open", search: files.length >= 500, onSelectionChange: (paths) => { const path = paths[0]; if (path !== undefined && !applyingPassivePath.current) onSelect(path); } });
  useEffect(() => { if (selectedPath !== undefined) model.scrollToPath(selectedPath, { focus: false }); }, [model, selectedPath]);
  useEffect(() => {
    if (activePath === undefined) return;
    applyingPassivePath.current = true;
    try {
      const selectableModel = model as typeof model & {
        selectOnlyPath?: (path: string) => void;
      };
      selectableModel.selectOnlyPath?.(activePath);
    } finally {
      applyingPassivePath.current = false;
    }
    model.scrollToPath(activePath, { focus: false, offset: "nearest" });
  }, [activePath, model]);
  return <FileTree model={model} aria-label="Changed files" data-active-path={activePath} style={{ height: "100%", minHeight: 0, "--trees-git-added-color-override": "light-dark(#007a5e, #5eead4)", "--trees-git-deleted-color-override": "light-dark(#be123c, #ff8580)", "--trees-git-ignored-color-override": "light-dark(#64748b, #a8a8ae)", "--trees-git-modified-color-override": "light-dark(#006f93, #68cdf2)", "--trees-git-renamed-color-override": "light-dark(#806000, #ffe38a)", "--trees-git-untracked-color-override": "light-dark(#007a5e, #5eead4)" } as React.CSSProperties} />;
}
