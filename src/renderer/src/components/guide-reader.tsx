import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ReviewViewPreferences } from "@/review-view-preferences";
import {
  decomposeGuidePatch,
  type GuideFileEvidence,
} from "./guide-file-evidence";
import { GuideFileDiff } from "./guide-file-diff";
import {
  guideOthers,
  type GuideInventoryEntry,
  type RetainedGuide,
} from "#src/domain/guide";
import { GeneratedMarkdown } from "./generated-markdown";
import { Button } from "./ui/button";
import { InlineError } from "./ui/inline-error";
import type { WalkthroughDiffAuthoring } from "./walkthrough-diff-authoring";

const evidenceLabels = {
  text: "",
  metadata: "Metadata only",
  binary: "Binary file",
  submodule: "Submodule change",
  omitted: "Diff omitted",
} satisfies Readonly<Record<GuideInventoryEntry["evidence"], string>>;

/** Continuous overview resolves memberships only from its retained inventory. */
export function GuideReader({
  guide,
  preferences,
  diffAuthoring,
  disabledReason,
}: {
  readonly guide: RetainedGuide;
  readonly preferences?: ReviewViewPreferences;
  readonly diffAuthoring?: WalkthroughDiffAuthoring;
  readonly disabledReason?: string;
}): React.JSX.Element {
  const files = useMemo(
    () => new Map(guide.inventory.map((file) => [file.id, file])),
    [guide],
  );
  const evidence = useMemo(() => decomposeGuidePatch(guide), [guide]);
  const others = guideOthers(guide);
  return (
    <div aria-label="Guide" className="@container min-w-0">
      {disabledReason === undefined ? null : (
        <p role="note" className="mb-3 text-sm text-muted-foreground">
          {disabledReason}
        </p>
      )}
      {diffAuthoring?.viewedFiles?.saveFailed ? (
        <InlineError>Viewed marks could not be saved.</InlineError>
      ) : null}
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
                const fileEvidence = evidence.get(membership.fileId);
                return file === undefined ||
                  fileEvidence === undefined ? null : (
                  <GuideFileRow
                    key={membership.fileId}
                    file={file}
                    evidence={fileEvidence}
                    {...(preferences === undefined ? {} : { preferences })}
                    relevance={membership.relevance}
                    {...(diffAuthoring === undefined ? {} : { diffAuthoring })}
                    {...(disabledReason === undefined
                      ? {}
                      : { disabledReason })}
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
            {others.map((file) => {
              const fileEvidence = evidence.get(file.id);
              return fileEvidence === undefined ? null : (
                <GuideFileRow
                  key={file.id}
                  file={file}
                  evidence={fileEvidence}
                  {...(preferences === undefined ? {} : { preferences })}
                  {...(diffAuthoring === undefined ? {} : { diffAuthoring })}
                  {...(disabledReason === undefined ? {} : { disabledReason })}
                />
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function GuideFileRow({
  file,
  relevance,
  evidence,
  preferences,
  diffAuthoring,
  disabledReason,
}: {
  readonly diffAuthoring?: WalkthroughDiffAuthoring;
  readonly disabledReason?: string;
  readonly file: GuideInventoryEntry;
  readonly relevance?: string;
  readonly evidence: GuideFileEvidence;
  readonly preferences?: ReviewViewPreferences;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const path = file.status === "removed" ? file.oldPath : file.newPath;
  const cut = path.lastIndexOf("/");
  const viewedFiles =
    disabledReason === undefined ? diffAuthoring?.viewedFiles : undefined;
  const viewedDisabledReason =
    disabledReason ??
    (viewedFiles === undefined
      ? "Viewed marks require the Combined Diff view."
      : undefined);
  return (
    <li className="min-w-0 rounded-md border bg-card px-3 py-3">
      <button
        type="button"
        aria-label={`File ${path}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full min-w-0 flex-wrap items-start justify-between gap-2 text-left"
      >
        <span className="flex min-w-0 items-start gap-2 break-all font-mono text-xs">
          <ChevronRight
            aria-hidden="true"
            className={`size-3.5 shrink-0 ${expanded ? "rotate-90" : ""}`}
          />
          <span>
            <span className="text-muted-foreground">
              {path.slice(0, cut + 1)}
            </span>
            <strong className="font-semibold">{path.slice(cut + 1)}</strong>
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {file.status} ·{" "}
          <span className="text-green-500">+{file.additions}</span>{" "}
          <span className="text-red-400">−{file.deletions}</span>
        </span>
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          aria-label={`Viewed ${path}`}
          aria-pressed={viewedFiles?.paths.has(path) ?? false}
          disabled={viewedDisabledReason !== undefined}
          onClick={() => {
            if (viewedFiles === undefined) return;
            const paths = new Set(viewedFiles.paths);
            if (paths.has(path)) paths.delete(path);
            else paths.add(path);
            viewedFiles.setPaths(paths);
          }}
        >
          Viewed
        </Button>
        {viewedDisabledReason === undefined ? null : (
          <span role="note" className="text-xs text-muted-foreground">
            {viewedDisabledReason}
          </span>
        )}
      </div>
      {file.status === "renamed" ? (
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
          From {file.oldPath}
        </p>
      ) : null}
      {file.evidence === "text" ? null : (
        <p className="mt-1 text-xs text-muted-foreground">
          {evidenceLabels[file.evidence]}
        </p>
      )}
      {relevance === undefined ? null : (
        <p className="mt-2 break-words text-sm text-muted-foreground">
          {relevance}
        </p>
      )}
      {expanded ? (
        <GuideFileDiff
          file={file}
          key={disabledReason ?? "current"}
          evidence={evidence}
          {...(disabledReason === undefined && diffAuthoring !== undefined
            ? { diffAuthoring }
            : {})}
          {...(preferences === undefined ? {} : { preferences })}
        />
      ) : null}
    </li>
  );
}
