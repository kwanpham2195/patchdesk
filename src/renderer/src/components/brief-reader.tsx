import { FileDiffIcon, GitCommitHorizontalIcon, QuoteIcon } from "lucide-react";
import { useMemo } from "react";

import {
  DEFAULT_REVIEW_VIEW_PREFERENCES,
  type ReviewViewPreferences,
} from "@/review-view-preferences";
import { parseReviewDiff } from "@/review-diff-data";
import {
  BRIEF_REACH_UNAVAILABLE_LABELS,
  briefCitationChipLabel,
  briefCitationChipTitle,
  briefCitationStatusLine,
  briefOwnershipTree,
  type BriefCitation,
  type BriefInsight,
  type BriefOwnership,
  type BriefOwnershipContract,
  type BriefOwnershipRow,
  type BriefStartHere,
} from "../brief-contracts";
import type { ChangeScope } from "../../../domain/change-scope";
import { ReachBlock } from "./brief-reach-block";
import { GeneratedMarkdownInline } from "./generated-markdown";
import { ReviewDiffView } from "./review-diff-view";
import { ScopeGauge } from "./scope-gauge";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

type RetainedBrief = NonNullable<BriefInsight["retained"]>;

/**
 * The glyph and hue each status carries in the tree. The hues are the ones the
 * app already spends on added and removed lines; `renamed` gets the changed
 * glyph in plain text, because a rename is a move rather than an edit.
 */
const OWNERSHIP_STATUS_MARKS = {
  added: { glyph: "+", className: "text-emerald-700 dark:text-emerald-400" },
  removed: { glyph: "−", className: "text-rose-700 dark:text-rose-400" },
  modified: { glyph: "~", className: "text-amber-600 dark:text-amber-400" },
  renamed: { glyph: "~", className: "text-muted-foreground" },
} as const satisfies Record<
  BriefOwnershipRow["status"],
  { readonly glyph: string; readonly className: string }
>;

const contractPreferences: ReviewViewPreferences = {
  ...DEFAULT_REVIEW_VIEW_PREFERENCES,
  fileMode: "all",
};

const CITATION_ICONS = {
  hunk: FileDiffIcon,
  description: QuoteIcon,
  commit: GitCommitHorizontalIcon,
} as const satisfies Record<BriefCitation["kind"], React.ElementType>;

const generatedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const PROVIDER_LABELS = {
  pi: "Pi",
  "codex-cli-account": "Codex CLI account",
} as const;

/**
 * The read side of one retained Brief: what the pull request is for, in cited
 * prose, with everything it could not cite written as an assumption. It states
 * no verdict and no finding; those stay in Analysis.
 */
export function BriefReader({
  retained,
  scope,
  onRegenerate,
  regenerateDisabled = false,
  walkthroughStatus,
  onOpenWalkthrough,
}: {
  readonly retained: RetainedBrief;
  /** Absent when the represented patch bytes were unreadable; see `ReviewWorkbenchProjection.scope`. */
  readonly scope?: ChangeScope;
  readonly onRegenerate: () => void;
  readonly regenerateDisabled?: boolean;
  /** The workbench's Walkthrough status; decides whether the card offers to open one or to generate one. */
  readonly walkthroughStatus: BriefInsight["status"];
  readonly onOpenWalkthrough: () => void;
}): React.JSX.Element {
  const brief = retained.value;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="flex min-w-0 flex-col gap-5">
        <section aria-label="Goal" className="flex flex-col gap-2">
          <h3 className="flex items-baseline gap-2 text-sm font-medium">
            Goal
            <span className="text-xs font-normal text-muted-foreground">
              every claim carries its evidence
            </span>
          </h3>
          <div className="flex max-w-[66ch] flex-col gap-2 text-sm">
            {brief.goal.map((item) => (
              <p key={item.text}>
                <GeneratedMarkdownInline markdown={item.text} />{" "}
                {item.citations.map((citation) => (
                  <CitationChip
                    key={citation.alias}
                    citation={citation}
                    raw={brief.citedHunks?.[citation.alias]}
                  />
                ))}
              </p>
            ))}
          </div>
        </section>
        {brief.assumptions.length === 0 ? null : (
          <section aria-label="Assumptions" className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Assumptions</h3>
            <ul className="flex max-w-[66ch] flex-col gap-2">
              {brief.assumptions.map((assumption) => (
                <li
                  key={assumption.text}
                  className="flex flex-col gap-0.5 border-l-2 border-[var(--status-warning)] py-0.5 pl-3 text-sm"
                >
                  <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--status-warning)]">
                    {assumption.demoted
                      ? "Assumption · uncited claim"
                      : "Assumption"}
                  </span>
                  <span>
                    <GeneratedMarkdownInline markdown={assumption.text} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {brief.descriptionDrift === undefined ? null : (
          <section
            aria-label="Description vs diff"
            className="flex flex-col gap-2"
          >
            <h3 className="text-sm font-medium">Description vs diff</h3>
            <div className="grid gap-3 md:grid-cols-2">
              <DriftColumn
                label="Claimed, not in the diff"
                count={brief.descriptionDrift.claimed.length}
                hint="Model judgment: nothing can prove absence."
              >
                {brief.descriptionDrift.claimed.map((item) => (
                  <DriftItem
                    key={item.quote}
                    mark="!"
                    markClassName="bg-status-warning/15 text-status-warning"
                    citations={item.citations}
                    citedHunks={brief.citedHunks}
                  >
                    <q className="text-muted-foreground">
                      <GeneratedMarkdownInline markdown={item.quote} />
                    </q>{" "}
                    <GeneratedMarkdownInline markdown={item.note} />
                  </DriftItem>
                ))}
              </DriftColumn>
              <DriftColumn
                label="In the diff, not described"
                count={brief.descriptionDrift.undescribed.length}
              >
                {brief.descriptionDrift.undescribed.map((item) => (
                  <DriftItem
                    key={item.text}
                    mark="+"
                    markClassName="bg-status-info/15 text-status-info"
                    citations={item.citations}
                    citedHunks={brief.citedHunks}
                  >
                    <GeneratedMarkdownInline markdown={item.text} />
                  </DriftItem>
                ))}
              </DriftColumn>
            </div>
          </section>
        )}
        {brief.ownership === undefined ? null : (
          <OwnershipBlock ownership={brief.ownership} />
        )}
        {brief.reach === undefined ? (
          brief.reachUnavailable === undefined ? null : (
            <p className="text-xs text-muted-foreground">
              Reach was not counted:{" "}
              {BRIEF_REACH_UNAVAILABLE_LABELS[brief.reachUnavailable]}.
            </p>
          )
        ) : (
          <ReachBlock reach={brief.reach} headSha={retained.headSha} />
        )}
        <p className="text-xs text-muted-foreground">
          Citations: {briefCitationStatusLine(brief)}
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {brief.startHere === undefined ? null : (
          <StartHereCard
            startHere={brief.startHere}
            walkthroughStatus={walkthroughStatus}
            onOpenWalkthrough={onOpenWalkthrough}
          />
        )}
        {scope === undefined ? null : <ScopeGauge scope={scope} size="card" />}
        <section
          aria-label="Provenance"
          className="flex flex-col gap-3 rounded-md border p-3"
        >
          <h3 className="text-sm font-medium">Provenance</h3>
          <dl className="flex flex-col gap-1 text-xs text-muted-foreground">
            <ProvenanceRow label="Revision">
              <span className="font-mono">{retained.headSha.slice(0, 7)}</span>
            </ProvenanceRow>
            <ProvenanceRow label="Generated">
              {generatedAtFormatter.format(Date.parse(retained.generatedAt))}
            </ProvenanceRow>
            {retained.provenance === undefined ? null : (
              <ProvenanceRow label="Provider">
                {PROVIDER_LABELS[retained.provenance.provider]} ·{" "}
                {retained.provenance.model}
              </ProvenanceRow>
            )}
            <ProvenanceRow label="Citations">
              {briefCitationStatusLine(brief)}
            </ProvenanceRow>
          </dl>
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={onRegenerate}
            disabled={regenerateDisabled}
          >
            Regenerate
          </Button>
        </section>
      </div>
    </div>
  );
}

/**
 * Where to start reading. The list is an `<ol>` because the order is the whole
 * point of the card, and the walkthrough sits under it: the Brief says where to
 * begin, the Walkthrough is the long way through.
 */
function StartHereCard({
  startHere,
  walkthroughStatus,
  onOpenWalkthrough,
}: {
  readonly startHere: BriefStartHere;
  readonly walkthroughStatus: BriefInsight["status"];
  readonly onOpenWalkthrough: () => void;
}): React.JSX.Element {
  return (
    <section
      aria-label="Start here"
      className="flex flex-col gap-3 rounded-md border border-primary/40 p-3"
    >
      <h3 className="text-sm font-medium">Start here</h3>
      <p className="text-xs">
        <GeneratedMarkdownInline markdown={startHere.lead} />
      </p>
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-xs text-muted-foreground">
        {startHere.order.map((entry) => (
          <li key={entry.path} className="min-w-0">
            <span className="break-all font-mono text-foreground">
              {entry.path}
            </span>
            {entry.why === undefined ? null : (
              <>
                {" "}
                — <GeneratedMarkdownInline markdown={entry.why} />
              </>
            )}
          </li>
        ))}
      </ol>
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        onClick={onOpenWalkthrough}
      >
        {walkthroughStatus === "current"
          ? "Open walkthrough"
          : "Generate walkthrough"}
      </Button>
    </section>
  );
}

/**
 * The Ownership block: a shallow file tree saying who owns what after the change,
 * then the one hunk that explains the rest of the patch.
 */
function OwnershipBlock({
  ownership,
}: {
  readonly ownership: BriefOwnership;
}): React.JSX.Element {
  const tree = useMemo(() => briefOwnershipTree(ownership), [ownership]);
  return (
    <section aria-label="Shape" className="flex min-w-0 flex-col gap-2">
      <h3 className="flex items-baseline gap-2 text-sm font-medium">
        Shape
        <span className="text-xs font-normal text-muted-foreground">
          who owns what after the change
        </span>
      </h3>
      <div className="flex min-w-0 flex-col gap-2 rounded-md border p-3 font-mono text-xs">
        {tree.map((group) => (
          <div key={group.directory} className="flex min-w-0 flex-col">
            <span className="text-muted-foreground">
              {group.directory === "" ? "./" : group.directory}
            </span>
            {group.files.map((row) => (
              <OwnershipRow key={row.path} row={row} />
            ))}
            {group.hidden === 0 ? null : (
              <span className="pl-4 text-muted-foreground">
                … {group.hidden} more files
              </span>
            )}
          </div>
        ))}
      </div>
      {ownership.contract === undefined ? null : (
        <OwnershipContract contract={ownership.contract} />
      )}
    </section>
  );
}

/** One file of the tree. The glyph carries the status; the title spells it out. */
function OwnershipRow({
  row,
}: {
  readonly row: BriefOwnershipRow;
}): React.JSX.Element {
  const mark = OWNERSHIP_STATUS_MARKS[row.status];
  return (
    <span
      title={`${row.status} ${row.path}`}
      className="flex min-w-0 items-baseline gap-2 pl-4"
    >
      <span className={mark.className}>{mark.glyph}</span>
      <span className="shrink-0">{row.name}</span>
      {row.note === undefined ? null : (
        <span className="min-w-0 truncate font-sans text-muted-foreground">
          {row.note}
        </span>
      )}
    </span>
  );
}

/**
 * The contract hunk, drawn by the one diff renderer. `raw` is a complete
 * one-hunk unified patch the main process cut from the session patch, so this
 * reparses app-owned bytes rather than anything the model wrote.
 */
function OwnershipContract({
  contract,
}: {
  readonly contract: BriefOwnershipContract;
}): React.JSX.Element | null {
  const parsed = useMemo(() => parseReviewDiff(contract.raw), [contract.raw]);
  if (parsed.files.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-md border">
      <p className="border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-mono">{contract.path}</span> ·{" "}
        <GeneratedMarkdownInline markdown={contract.caption} />
      </p>
      <HunkDiff raw={contract.raw} path={contract.path} />
    </div>
  );
}

/**
 * The one place that renders a complete one-hunk unified patch: the Shape
 * card's contract hunk and a clicked hunk-citation popover both mount this,
 * rather than each carrying its own `<ReviewDiffView>`. `raw` is app-owned
 * bytes cut by the main process, never anything the model wrote.
 */
function HunkDiff({
  raw,
  path,
}: {
  readonly raw: string;
  readonly path?: string | undefined;
}): React.JSX.Element | null {
  const parsed = useMemo(() => parseReviewDiff(raw), [raw]);
  if (parsed.files.length === 0) return null;
  return (
    // 396px = 36px header + 18 rows * 20px, so the last visible row is whole.
    <div className="max-h-[396px] overflow-auto">
      <ReviewDiffView
        patch={raw}
        parsedFiles={parsed.files}
        fileStatsByPath={parsed.statsByPath}
        selectedPath={path}
        preferences={contractPreferences}
        collapsedPaths={new Set()}
        onPreferencesChange={() => undefined}
        onCollapsedPathsChange={() => undefined}
        virtualized={false}
      />
    </div>
  );
}

/** One side of the drift block: its own labelled region, with its own count. */
function DriftColumn({
  label,
  count,
  hint,
  children,
}: {
  readonly label: string;
  readonly count: number;
  readonly hint?: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      aria-label={label}
      className="flex min-w-0 flex-col gap-2 rounded-md border p-3"
    >
      <h4 className="flex items-baseline justify-between gap-2 text-xs font-medium">
        {label}
        <span className="font-mono text-[11px] font-normal tabular-nums text-muted-foreground">
          {count}
        </span>
      </h4>
      {hint === undefined ? null : (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      )}
      {count === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing found.</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">{children}</ul>
      )}
    </section>
  );
}

/**
 * One drift item. The mark is decorative: the column's own label already says
 * which direction the drift runs, so the hue repeats it rather than carrying it.
 */
function DriftItem({
  mark,
  markClassName,
  citations,
  citedHunks,
  children,
}: {
  readonly mark: string;
  readonly markClassName: string;
  readonly citations: ReadonlyArray<BriefCitation>;
  readonly citedHunks?: Readonly<Record<string, string>> | undefined;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <li className="flex items-start gap-2">
      <span
        aria-hidden="true"
        className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded font-mono text-[11px] ${markClassName}`}
      >
        {mark}
      </span>
      <span className="min-w-0">
        {children}{" "}
        {citations.map((citation) => (
          <CitationChip
            key={citation.alias}
            citation={citation}
            raw={citedHunks?.[citation.alias]}
          />
        ))}
      </span>
    </li>
  );
}

function ProvenanceRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt>{label}</dt>
      <dd className="text-right text-foreground">{children}</dd>
    </div>
  );
}

const CITATION_CHIP_CLASS_NAME =
  "mx-0.5 inline-flex items-center gap-1 rounded border bg-accent px-1.5 align-baseline font-mono text-[10px] text-muted-foreground";

/**
 * One resolved citation. The kind is carried by an icon rather than a color:
 * hunk, description, and commit are evidence kinds, not statuses, so they never
 * take a status hue. `raw` is the one-hunk patch this citation's alias cut out
 * of the session patch (only ever present for a `kind === "hunk"` citation);
 * when it is present the chip becomes a button that opens the hunk in a
 * popover, and when it is absent the chip stays the plain, non-interactive
 * span it always was.
 */
function CitationChip({
  citation,
  raw,
}: {
  readonly citation: BriefCitation;
  readonly raw?: string | undefined;
}): React.JSX.Element {
  const Icon = CITATION_ICONS[citation.kind];
  const chipLabel = briefCitationChipLabel(citation);
  if (raw === undefined) {
    return (
      <span
        title={briefCitationChipTitle(citation)}
        className={CITATION_CHIP_CLASS_NAME}
      >
        <Icon aria-hidden="true" className="size-3" />
        {chipLabel}
      </span>
    );
  }
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            title={briefCitationChipTitle(citation)}
            aria-label={`Show hunk ${chipLabel}`}
            className={`${CITATION_CHIP_CLASS_NAME} hover:bg-accent/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring`}
          />
        }
      >
        <Icon aria-hidden="true" className="size-3" />
        {chipLabel}
      </PopoverTrigger>
      <PopoverContent className="w-[min(48rem,90vw)] gap-0 p-0 overflow-hidden">
        <p className="border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {citation.path === undefined ? null : (
            <>
              <span className="font-mono">{citation.path}</span> ·{" "}
            </>
          )}
          {citation.label}
        </p>
        <HunkDiff raw={raw} path={citation.path} />
      </PopoverContent>
    </Popover>
  );
}
