import { useEffect, useState, useRef } from "react";
import type { FileTreeOptions, GitStatus } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";

import type { FileChangeStats } from "@/review-diff-data";
import { buildActivePathTreeStyle } from "./pierre-file-tree-active-style";

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

// Our own marker attribute for the <style> element we inject into the tree's
// shadow root (see below). Deliberately NOT `FILE_TREE_UNSAFE_CSS_ATTRIBUTE`:
// @pierre/trees' internal `#syncUnsafeCSS` adopts and removes any element
// carrying that attribute, which would delete ours out from under it.
const ACTIVE_PATH_STYLE_ATTRIBUTE = "data-patchdesk-active-path-style";

/** Pierre owns tree focus and scrolling; selection only reveals the matching diff file. */
export function PierreFileTree(props: PierreFileTreeProps): React.JSX.Element {
  // Keyed on the file SET (paths + git status), not the active file: the
  // underlying `useFileTree` call captures its `paths`/`gitStatus` options
  // once at construction and never re-reads them, so a changed revision
  // needs a fresh model. A changed active file does not -- see the
  // shadow-root style injection below for how that highlight is drawn
  // instead, without a remount.
  return <PierreFileTreeModel key={filesKey(props.files)} {...props} />;
}

/**
 * A key that changes whenever the file set (paths or git status) changes,
 * and stays stable across active-file changes. NUL/SOH separate fields and
 * entries so two different file lists can't collide onto the same key.
 */
function filesKey(files: ReadonlyArray<PierreFileTreeItem>): string {
  return files
    .map((file) => `${file.path}\0${file.gitStatus ?? ""}`)
    .join("\u0001");
}

function PierreFileTreeModel({
  files,
  selectedPath,
  activePath,
  onSelect,
}: PierreFileTreeProps): React.JSX.Element {
  const activePathStyleRef = useRef<HTMLStyleElement | null>(null);
  const [appearance, setAppearance] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.appearance === "light" ? "light" : "dark",
  );
  const fileTreeOptions: FileTreeOptions = {
    paths: files.map((file) => file.path),
    gitStatus: files.flatMap((file) =>
      file.gitStatus === undefined
        ? []
        : [{ path: file.path, status: file.gitStatus }],
    ),
    initialExpansion: "open",
    search: files.length >= 500,
    onSelectionChange: (paths) => {
      const path = paths[0];
      if (path !== undefined) onSelect(path);
    },
  };
  if (activePath !== undefined)
    fileTreeOptions.initialSelectedPaths = [activePath];
  const { model } = useFileTree(fileTreeOptions);
  useEffect(() => {
    if (selectedPath !== undefined)
      model.scrollToPath(selectedPath, { focus: false });
  }, [model, selectedPath]);
  useEffect(() => {
    if (activePath === undefined) return;
    model.scrollToPath(activePath, { focus: false, offset: "nearest" });
  }, [activePath, model]);
  // @pierre/trees exposes no public selection setter (`selectOnlyPath` lives
  // only on its internal controller/view types, never on the `FileTree`
  // model returned by `useFileTree`), so the active file cannot be selected
  // through the library's own API. Instead, draw the highlight directly:
  // inject a small stylesheet into the tree's shadow root that targets the
  // active row by its `data-item-path` and reuses the same
  // `--trees-selected-*` custom properties the library's own selection style
  // uses, so it matches the existing look exactly. This is a plain
  // (unlayered) rule; the library's own row styles live in `@layer base`, so
  // ours wins the cascade without any specificity games.
  useEffect(() => {
    const shadowRoot = model.getFileTreeContainer()?.shadowRoot;
    if (shadowRoot == null) return;
    let styleElement = activePathStyleRef.current;
    if (styleElement === null || styleElement.getRootNode() !== shadowRoot) {
      styleElement = document.createElement("style");
      styleElement.setAttribute(ACTIVE_PATH_STYLE_ATTRIBUTE, "");
      shadowRoot.appendChild(styleElement);
      activePathStyleRef.current = styleElement;
    }
    styleElement.textContent =
      activePath === undefined ? "" : buildActivePathTreeStyle(activePath);
  }, [activePath, model]);
  useEffect(() => {
    const onAppearance = (event: Event): void => {
      // SAFETY: only `window.dispatchEvent(new CustomEvent("patchdesk:appearance", ...))`
      // ever fires this listener; the `if` below still validates the detail
      // before trusting it as a real "light" | "dark" value.
      const value = (event as CustomEvent<"light" | "dark">).detail;
      if (value === "light" || value === "dark") setAppearance(value);
    };
    window.addEventListener("patchdesk:appearance", onAppearance);
    return () =>
      window.removeEventListener("patchdesk:appearance", onAppearance);
  }, []);
  return (
    <FileTree
      model={model}
      aria-label="Changed files"
      data-active-path={activePath}
      data-theme={appearance}
      style={
        // SAFETY: "--trees-git-*-color-override" are custom properties;
        // CSSProperties doesn't declare custom-property keys, but any
        // `--name: string` entry is valid inline-style CSS. @pierre/trees
        // reads them from the host element's computed style.
        {
          colorScheme: appearance,
          height: "100%",
          minHeight: 0,
          "--trees-git-added-color-override": "light-dark(#007a5e, #5eead4)",
          "--trees-git-deleted-color-override": "light-dark(#be123c, #ff8580)",
          "--trees-git-ignored-color-override": "light-dark(#64748b, #a8a8ae)",
          "--trees-git-modified-color-override": "light-dark(#006f93, #68cdf2)",
          "--trees-git-renamed-color-override": "light-dark(#806000, #ffe38a)",
          "--trees-git-untracked-color-override":
            "light-dark(#007a5e, #5eead4)",
        } as React.CSSProperties
      }
    />
  );
}
