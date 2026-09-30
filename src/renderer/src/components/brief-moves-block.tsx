import type { BriefMoves } from "../brief-contracts";
import {
  displayDirectory,
  moreMovedDirectories,
} from "../../../domain/brief-moves";

/** The Moves block: directories the patch moved, from git's rename pairs. */
export function MovesBlock({
  moves,
}: {
  readonly moves: BriefMoves;
}): React.JSX.Element {
  return (
    <section aria-label="Moves" className="flex min-w-0 flex-col gap-2">
      <h3 className="flex items-baseline gap-2 text-sm font-medium">
        Moves
        <span className="text-xs font-normal text-muted-foreground">
          {moves.movedFiles} files changed directory
          {(moves.referenceUpdates ?? 0) > 0
            ? ` · ${String(moves.referenceUpdates)} more only update references to them`
            : null}
        </span>
      </h3>
      <div className="grid min-w-0 grid-cols-[minmax(0,auto)_auto_minmax(0,auto)_1fr] items-baseline gap-x-3 gap-y-1 rounded-md border p-3 font-mono text-xs">
        {moves.rows.map((row) => (
          <div key={`${row.from}\n${row.to}`} className="contents">
            <span className="truncate" title={row.from}>
              {displayDirectory(row.from)}
            </span>
            <span className="text-muted-foreground">→</span>
            <span className="truncate" title={row.to}>
              {displayDirectory(row.to)}
            </span>
            <span className="font-sans text-muted-foreground">
              {moveRowDetail(row)}
            </span>
          </div>
        ))}
        {moves.hiddenRows === 0 ? null : (
          <span className="col-span-4 text-muted-foreground">
            … {moreMovedDirectories(moves.hiddenRows)}
          </span>
        )}
      </div>
    </section>
  );
}

function moveRowDetail(row: BriefMoves["rows"][number]): string {
  const parts = [`${row.files} ${row.files === 1 ? "file" : "files"}`];
  if (row.names > 1) parts.push(`${row.names} names`);
  parts.push(
    row.editedFiles === 0 ? "unchanged" : `${row.editedFiles} also edited`,
  );
  return parts.join(" · ");
}
