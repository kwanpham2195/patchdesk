import { FileDiffIcon, GitCommitHorizontalIcon, QuoteIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_REVIEW_VIEW_PREFERENCES,
  type ReviewViewPreferences,
} from "@/review-view-preferences";
import { parseReviewDiff } from "@/review-diff-data";
import {
  briefFlowAsDiffText,
  briefFlowKindLabel,
  flowRows,
} from "../brief-flow-text";
import {
  BRIEF_REACH_UNAVAILABLE_LABELS,
  briefCitationChipLabel,
  briefCitationChipTitle,
  briefCitationStatusLine,
  briefOwnershipTree,
  type BriefCitation,
  type BriefFlow,
  type BriefFlowNode,
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

/**
 * The glyph, text hue, and row tint each Flow row's change carries. The text
 * hues are the exact ones `OWNERSHIP_STATUS_MARKS` above spends on added and
 * removed files, per ADR 0039: Flow draws with "the same diff colors used
 * elsewhere in Patchdesk." The row tint would ideally reuse the diff view's
 * own added/removed background, but that lives inside `@pierre/diffs`'s
 * shadow DOM as `--diffs-bg-addition-override`/`--diffs-bg-deletion-override`
 * custom properties the web component consumes internally -- nothing outside
 * it can read or reapply them -- so this falls back to a plain Tailwind tint
 * at the same hue. `unchanged` carries no glyph and no tint -- it is the
 * dimmed spine, not a claim. Each changed kind also carries an `uncited*`
 * variant, a dimmer version of its own hue for a changed step the model
 * could not cite a hunk for -- see `FlowRowView`.
 */
const FLOW_CHANGE_MARKS = {
  added: {
    glyph: "+",
    className: "text-emerald-700 dark:text-emerald-400",
    rowClassName: "bg-emerald-500/10",
    // An uncited changed step is a claim without evidence: the missing chip
    // and this muted marker are the signal, not an error state.
    uncitedClassName: "text-emerald-700/60 dark:text-emerald-400/60",
    uncitedRowClassName: "bg-emerald-500/5",
  },
  removed: {
    glyph: "−",
    className: "text-rose-700 dark:text-rose-400",
    rowClassName: "bg-rose-500/10",
    // Same reasoning as `added` above: no surviving hunk citation, so the row
    // draws as a dimmer version of itself rather than losing its glyph.
    uncitedClassName: "text-rose-700/60 dark:text-rose-400/60",
    uncitedRowClassName: "bg-rose-500/5",
  },
  unchanged: {
    glyph: "",
    className: "text-muted-foreground",
    rowClassName: "",
    uncitedClassName: "text-muted-foreground",
    uncitedRowClassName: "",
  },
} as const satisfies Record<
  BriefFlowNode["change"],
  {
    readonly glyph: string;
    readonly className: string;
    readonly rowClassName: string;
    readonly uncitedClassName: string;
    readonly uncitedRowClassName: string;
  }
>;

/** A small mono badge like the citation chip's, but with no evidence-kind hue -- it only names a Flow view's kind. */
const FLOW_KIND_BADGE_CLASS_NAME =
  "inline-flex shrink-0 items-center rounded border bg-accent px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground";

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
 * The read side of one retained Brief: the change's structure -- Flow, Shape,
 * Start here, and Reach -- rather than prose about it (ADR 0040). It states
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
        {brief.flow === undefined ? null : (
          <FlowBlock flow={brief.flow} citedHunks={brief.citedHunks} />
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
 * The Flow block: one bordered view per tree, each with its own kind badge,
 * title, and "Copy as diff" action that writes that tree back out as fenced
 * `+`/`-` text (ADR 0039). Absent whenever the Brief carries no `flow`,
 * including every Brief retained before this block existed.
 */
function FlowBlock({
  flow,
  citedHunks,
}: {
  readonly flow: BriefFlow;
  readonly citedHunks?: Readonly<Record<string, string>> | undefined;
}): React.JSX.Element {
  return (
    <section aria-label="Flow" className="flex min-w-0 flex-col gap-2">
      <h3 className="flex items-baseline gap-2 text-sm font-medium">
        Flow
        <span className="text-xs font-normal text-muted-foreground">
          how the sequence changed
        </span>
      </h3>
      <div className="flex min-w-0 flex-col gap-3">
        {flow.trees.map((tree) => (
          // `normalizeBriefFlow` guarantees at most one tree per kind, so
          // `tree.kind` is a stable, unique key without needing the array
          // index.
          <FlowView key={tree.kind} tree={tree} citedHunks={citedHunks} />
        ))}
      </div>
    </section>
  );
}

/**
 * One Flow view: a Shape-card-like bordered container with a header row (kind
 * badge, title, per-view copy button) and a body of monospace rows, one per
 * node, flattened by `flowRows` -- the same flattening `briefFlowAsDiffText`
 * walks, so the drawn rows and the copied text can never disagree about
 * order. No ARIA tree roles: the tree is static (no expand/collapse, no
 * roving focus), so it stays plain `div`s rather than claiming the ARIA tree
 * widget.
 */
function FlowView({
  tree,
  citedHunks,
}: {
  readonly tree: BriefFlow["trees"][number];
  readonly citedHunks?: Readonly<Record<string, string>> | undefined;
}): React.JSX.Element {
  const rows = useMemo(() => flowRows(tree.nodes), [tree.nodes]);
  const diffText = useMemo(
    () => briefFlowAsDiffText({ trees: [tree] }),
    [tree],
  );
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className={FLOW_KIND_BADGE_CLASS_NAME}>
            {briefFlowKindLabel(tree.kind)}
          </span>
          <p className="min-w-0 truncate text-xs font-medium text-foreground">
            {tree.title}
          </p>
        </div>
        <CopyFlowButton diffText={diffText} />
      </div>
      <div className="flex min-w-0 flex-col">
        {rows.map((row, index) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- `rows` is a fixed flattening of one immutable Brief value's tree; `BriefFlowNode` carries no id (ADR 0039's "deterministic bookkeeping, no numbers" rule), and sibling labels are not guaranteed unique, so `${depth}:${index}:${label}` disambiguates rather than tracking a reorder that never happens.
          <FlowRowView
            key={`${String(row.depth)}:${String(index)}:${row.label}`}
            row={row}
            citedHunks={citedHunks}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One flattened Flow row: a fixed-width marker column carrying the change
 * (blank for `unchanged`, the same +/− the Ownership tree uses), the label
 * indented by its depth, and its citation chips -- a hunk citation opens the
 * same popover any other chip in Brief does. Added and removed rows get the
 * diff-hue tint from `FLOW_CHANGE_MARKS`; unchanged rows are dimmed and
 * untinted, so the changed steps stand out.
 *
 * Hunk citations on a changed step are best effort: the model keeps a step it
 * added or removed even when it could not place it in the diff. Such a row
 * has zero citations, so it draws with the dimmer `uncited*` variant of its
 * hue and no chip -- a claim the Brief could not verify, shown honestly
 * rather than dropped.
 */
function FlowRowView({
  row,
  citedHunks,
}: {
  readonly row: ReturnType<typeof flowRows>[number];
  readonly citedHunks?: Readonly<Record<string, string>> | undefined;
}): React.JSX.Element {
  const mark = FLOW_CHANGE_MARKS[row.change];
  const uncited = row.change !== "unchanged" && row.citations.length === 0;
  return (
    <div
      className={`flex items-baseline gap-2 rounded px-1 py-0.5 font-mono text-xs ${uncited ? mark.uncitedRowClassName : mark.rowClassName}`}
    >
      <span
        aria-hidden="true"
        title={uncited ? "No hunk cited for this step" : undefined}
        className={`w-3 shrink-0 text-center ${uncited ? mark.uncitedClassName : mark.className}`}
      >
        {mark.glyph}
      </span>
      <span
        className={`min-w-0 [overflow-wrap:anywhere] ${row.change === "unchanged" ? "text-muted-foreground" : "text-foreground"}`}
        style={{ paddingLeft: `${String(row.depth)}rem` }}
      >
        {row.label}{" "}
        {row.citations.map((citation) => (
          <CitationChip
            key={citation.alias}
            citation={citation}
            raw={citedHunks?.[citation.alias]}
          />
        ))}
      </span>
    </div>
  );
}

/**
 * One Flow view's "Copy as diff" button: its own "Copied" state and cleanup
 * timer, so copying one view never flips the label on another. Same honest
 * `.then`/`.catch` behaviour as every other copy action in Brief -- the label
 * only flips once the write actually resolves, and a rejection leaves it as
 * "Copy as diff" rather than claiming success.
 */
function CopyFlowButton({
  diffText,
}: {
  readonly diffText: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(
    () => () => {
      clearTimeout(copiedTimer.current);
    },
    [],
  );
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        navigator.clipboard
          .writeText(diffText)
          .then(() => {
            setCopied(true);
            clearTimeout(copiedTimer.current);
            copiedTimer.current = setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? "Copied" : "Copy as diff"}
    </Button>
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
