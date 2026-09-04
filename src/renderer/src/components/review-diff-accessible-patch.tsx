import { useEffect, useMemo, useRef } from "react";

import { definedProps } from "../../../domain/defined-props";
import { tokenizeUnifiedPatch } from "../../../domain/unified-patch";
import type {
  LocalCommentAuthoring,
  SelectedDiffRange,
} from "./review-diff-view";

type AccessibleLine = {
  /** Stable source-line identity within one parsed patch. */
  readonly key: string;
  readonly content: string;
  readonly kind: "Added" | "Deleted" | "Hunk" | "Context";
  readonly path?: string;
  readonly oldLine?: number;
  readonly newLine?: number;
};

export function AccessiblePatch({
  patch,
  selectedRange,
  virtualized,
  localCommentAuthoring,
  onAuthorLine,
}: {
  readonly patch: string;
  readonly selectedRange?: SelectedDiffRange;
  readonly virtualized: boolean;
  readonly localCommentAuthoring?: LocalCommentAuthoring;
  readonly onAuthorLine?: (
    path: string,
    line: number,
    side: "additions" | "deletions",
  ) => void;
}): React.JSX.Element {
  const lines = useMemo(() => parseAccessibleLines(patch), [patch]);
  const selectedRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
    selectedRef.current?.focus({ preventScroll: true });
  }, [patch, selectedRange]);
  return (
    <div
      className={
        virtualized
          ? "max-h-[calc(100vh-12rem)] min-h-0 overflow-auto p-3 font-mono text-[13px] leading-5"
          : "min-h-0 overflow-x-auto p-3 font-mono text-[13px] leading-5"
      }
      role="region"
      aria-label="Plain text diff"
      tabIndex={0}
    >
      <ol className="min-w-max space-y-0">
        {lines.map((line) => {
          const lineNumber =
            selectedRange?.side === "old" ? line.oldLine : line.newLine;
          const selected =
            selectedRange !== undefined &&
            lineNumber !== undefined &&
            lineNumber >= selectedRange.start &&
            lineNumber <= selectedRange.end;
          const firstSelected = selected && lineNumber === selectedRange?.start;
          return (
            <li
              key={line.key}
              ref={firstSelected ? selectedRef : undefined}
              className={`grid grid-cols-[3.5rem_3.5rem_1fr] gap-2 rounded-sm px-1 ${selected ? "bg-primary/20 ring-1 ring-inset ring-primary/50" : ""}`}
              data-selected-line={selected ? "true" : undefined}
              data-line-type={
                line.kind === "Added"
                  ? "change-addition"
                  : line.kind === "Deleted"
                    ? "change-deletion"
                    : undefined
              }
              data-line-number={lineNumber}
              data-diff-side={selectedRange?.side}
              tabIndex={firstSelected ? -1 : undefined}
              aria-label={
                selected
                  ? `Selected ${selectedRange.side} line ${lineNumber}`
                  : undefined
              }
            >
              <span className="select-none text-muted-foreground">
                {line.kind}
              </span>
              <span className="select-none text-right text-muted-foreground">
                {line.oldLine === undefined && line.newLine === undefined
                  ? ""
                  : `${line.oldLine ?? ""}${line.oldLine !== undefined && line.newLine !== undefined ? "/" : ""}${line.newLine ?? ""}`}
              </span>
              <code className="whitespace-pre">{line.content || " "}</code>
              {localCommentAuthoring?.enabled === true &&
              line.path !== undefined &&
              (line.kind === "Added" || line.kind === "Deleted")
                ? (() => {
                    const path = line.path;
                    const side =
                      line.kind === "Added"
                        ? ("additions" as const)
                        : ("deletions" as const);
                    const lineNumber =
                      side === "additions" ? line.newLine : line.oldLine;
                    if (
                      lineNumber === undefined ||
                      localCommentAuthoring.canAuthor?.({
                        path,
                        startLine: lineNumber,
                        line: lineNumber,
                        side: side === "additions" ? "new" : "old",
                      }) === false
                    )
                      return null;
                    return (
                      <button
                        type="button"
                        className="inline-flex size-5 items-center justify-center rounded border border-border/60 bg-card text-sm font-medium leading-none text-muted-foreground shadow-sm transition-colors hover:border-primary/50 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`Add comment on ${path}`}
                        title={`Add comment on ${path} line ${lineNumber}`}
                        onClick={() => onAuthorLine?.(path, lineNumber, side)}
                      >
                        +
                      </button>
                    );
                  })()
                : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function parseAccessibleLines(patch: string): ReadonlyArray<AccessibleLine> {
  let path: string | undefined;
  return tokenizeUnifiedPatch(patch).map((token) => {
    const base = { key: `source-line-${token.index}`, content: token.raw };
    if (token.kind === "file_header") {
      path = token.newPath;
      return { ...base, kind: "Context" as const, ...definedProps({ path }) };
    }
    const withPath = { ...base, ...definedProps({ path }) };
    if (token.kind === "hunk_header")
      return { ...withPath, kind: "Hunk" as const };
    if (token.kind !== "body" || token.marker === "no_newline")
      return { ...withPath, kind: "Context" as const };
    if (token.marker === "added")
      return {
        ...withPath,
        kind: "Added" as const,
        ...definedProps({ newLine: token.newLine }),
      };
    if (token.marker === "removed")
      return {
        ...withPath,
        kind: "Deleted" as const,
        ...definedProps({ oldLine: token.oldLine }),
      };
    return {
      ...withPath,
      kind: "Context" as const,
      ...definedProps({ oldLine: token.oldLine, newLine: token.newLine }),
    };
  });
}
