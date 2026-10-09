import {
  guideOthers,
  type GuideInventoryEntry,
  type RetainedGuide,
} from "#src/domain/guide";
import { GeneratedMarkdown } from "./generated-markdown";

/** Continuous overview resolves memberships only from its retained inventory. */
export function GuideReader({
  guide,
}: {
  readonly guide: RetainedGuide;
}): React.JSX.Element {
  const files = new Map(guide.inventory.map((file) => [file.id, file]));
  const others = guideOthers(guide);
  return (
    <div aria-label="Guide" className="@container min-w-0">
      <ol className="m-0 list-none divide-y border-y p-0">
        {guide.groups.map((group, index) => (
          <li
            key={group.id}
            className="grid min-w-0 gap-5 py-6 @min-[48rem]:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]"
          >
            <section
              aria-labelledby={`guide-${group.id}`}
              className="min-w-0 space-y-3"
            >
              <p className="font-mono text-xs text-muted-foreground">
                {String(index + 1).padStart(2, "0")} /{" "}
                {String(guide.groups.length).padStart(2, "0")}
              </p>
              <h3 id={`guide-${group.id}`} className="text-base font-semibold">
                {group.title}
              </h3>
              <GeneratedMarkdown
                markdown={group.explanation}
                className="break-words text-sm"
              />
            </section>
            <ul
              aria-label={`${group.title} files`}
              className="min-w-0 space-y-2"
            >
              {group.files.map((membership) => {
                const file = files.get(membership.fileId);
                return file === undefined ? null : (
                  <GuideFileRow
                    key={membership.fileId}
                    file={file}
                    relevance={membership.relevance}
                  />
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
      <section
        aria-labelledby="guide-others"
        className="grid min-w-0 gap-5 py-6 @min-[48rem]:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]"
      >
        <div className="min-w-0 space-y-2">
          <h3 id="guide-others" className="text-base font-semibold">
            Others · {others.length} {others.length === 1 ? "file" : "files"}
          </h3>
          <p className="text-sm text-muted-foreground">
            Files outside every Guide group. Their changes still need review.
          </p>
        </div>
        {others.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Every changed file appears in a group.
          </p>
        ) : (
          <ul aria-label="Others files" className="min-w-0 space-y-2">
            {others.map((file) => (
              <GuideFileRow key={file.id} file={file} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function GuideFileRow({
  file,
  relevance,
}: {
  readonly file: GuideInventoryEntry;
  readonly relevance?: string;
}): React.JSX.Element {
  const path = file.status === "removed" ? file.oldPath : file.newPath;
  const cut = path.lastIndexOf("/");
  return (
    <li className="min-w-0 rounded-md border bg-card px-3 py-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 break-all font-mono text-xs">
          <span className="text-muted-foreground">
            {path.slice(0, cut + 1)}
          </span>
          <strong className="font-semibold">{path.slice(cut + 1)}</strong>
        </p>
        <p className="shrink-0 text-xs text-muted-foreground">
          {file.status} ·{" "}
          <span className="text-green-500">+{file.additions}</span>{" "}
          <span className="text-red-400">−{file.deletions}</span>
        </p>
      </div>
      {file.status === "renamed" ? (
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
          From {file.oldPath}
        </p>
      ) : null}
      {file.evidence === "text" ? null : (
        <p className="mt-1 text-xs text-muted-foreground">
          {file.evidence === "metadata"
            ? "Metadata only"
            : file.evidence === "binary"
              ? "Binary file"
              : file.evidence === "submodule"
                ? "Submodule change"
                : "Diff omitted"}
        </p>
      )}
      {relevance === undefined ? null : (
        <p className="mt-2 break-words text-sm text-muted-foreground">
          {relevance}
        </p>
      )}
    </li>
  );
}
