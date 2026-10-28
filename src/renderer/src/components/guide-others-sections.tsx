import type { ReactNode } from "react";
import type { GuideFileSummary, GuidePage } from "#src/domain/guide-progress";
import { guideOtherSection } from "#src/domain/guide-others";

/** Disclosure state stays local; existing file appearances retain their own controls and reading progress. */
export function GuideOthersSections<T>({
  items,
  counts,
  fileOf,
  renderFile,
}: {
  readonly items: ReadonlyArray<T>;
  readonly counts?: Extract<GuidePage, { kind: "others" }>["counts"];
  readonly fileOf: (item: T) => GuideFileSummary | null;
  readonly renderFile: (item: T) => ReactNode;
}): React.JSX.Element {
  return (
    <div className="min-w-0 space-y-3">
      {(
        [
          ["changed", "Changed code"],
          ["renamed", "Renamed"],
          ["deleted", "Deleted"],
        ] as const
      ).map(([section, label]) => {
        const files = items.filter(
          (item) => guideOtherSection(fileOf(item)) === section,
        );
        const count = counts?.[section] ?? files.length;
        if (count === 0) return null;
        const list = (
          <>
            <ul aria-label={`${label} files`} className="min-w-0 space-y-2">
              {files.map(renderFile)}
            </ul>
            {files.length < count ? (
              <p className="text-xs text-muted-foreground">
                {count - files.length}{" "}
                {count - files.length === 1 ? "file remains" : "files remain"}{" "}
                in later pages. Use Show more files below.
              </p>
            ) : null}
          </>
        );
        return section === "changed" ? (
          <section key={section} aria-label={label} className="space-y-2">
            <h4 className="text-sm font-semibold">
              {label} · {count}
            </h4>
            {list}
          </section>
        ) : (
          <details key={section} className="min-w-0 space-y-2">
            <summary className="cursor-pointer text-sm font-semibold">
              {label} · {count}
            </summary>
            {list}
          </details>
        );
      })}
    </div>
  );
}
