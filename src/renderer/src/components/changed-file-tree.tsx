import { FileTree, useFileTree } from "@pierre/trees/react";

/** App-owned file tree: explicit buttons own Patchdesk navigation while Pierre renders the full tree model. */
export function ChangedFileTree({ paths, selectedPath, onSelect }: { readonly paths: ReadonlyArray<string>; readonly selectedPath?: string; readonly onSelect: (path: string) => void }): React.JSX.Element {
  const { model } = useFileTree({ paths: [...paths], initialExpansion: "open", search: true });
  return <aside aria-label="Changed files"><div className="sr-only"><FileTree model={model} /></div>{paths.map((path) => <button key={path} aria-pressed={selectedPath === path} onClick={() => onSelect(path)}>{path}</button>)}</aside>;
}
