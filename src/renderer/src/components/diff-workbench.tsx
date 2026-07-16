import { useMemo, useState } from "react";
import { mapFindingLocation, parseUnifiedPatch, type FindingLocationInput } from "../../../domain/patch";
import { ChangedFileTree } from "./changed-file-tree";
import { ReviewDiffView } from "./review-diff-view";

/** Read-only diff workbench with deterministic file search and finding navigation. */
export function DiffWorkbench({ patch, finding }: { readonly patch: string; readonly finding?: FindingLocationInput }): React.JSX.Element {
  const files = useMemo(() => parseUnifiedPatch(patch), [patch]);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | undefined>(files[0]?.newPath);
  const visiblePaths = files.map((file) => file.newPath).filter((path) => path.toLowerCase().includes(query.toLowerCase()));
  const mapped = finding === undefined ? undefined : mapFindingLocation(files, finding);
  return <section aria-label="Diff workbench"><label>Search changed files<input value={query} onChange={(event) => setQuery(event.target.value)} /></label><ChangedFileTree paths={visiblePaths} {...(selectedPath === undefined ? {} : { selectedPath })} onSelect={setSelectedPath} />{mapped?.mappingStatus === "mapped" && mapped.path !== undefined ? <button onClick={() => setSelectedPath(mapped.path)}>Go to finding</button> : null}<p>Selected file: {selectedPath ?? "none"}</p><ReviewDiffView patch={patch} {...(selectedPath === undefined ? {} : { selectedPath })} /></section>;
}
