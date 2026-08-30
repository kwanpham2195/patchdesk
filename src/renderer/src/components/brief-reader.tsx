import { FileDiffIcon, GitCommitHorizontalIcon, QuoteIcon } from "lucide-react";

import {
  briefCitationChipLabel,
  briefCitationStatusLine,
  type BriefCitation,
  type BriefInsight,
} from "../brief-contracts";
import type { ChangeScope } from "../../../domain/change-scope";
import { ScopeGauge } from "./scope-gauge";
import { Button } from "./ui/button";

type RetainedBrief = NonNullable<BriefInsight["retained"]>;

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
}: {
  readonly retained: RetainedBrief;
  /** Absent when the represented patch bytes were unreadable; see `ReviewWorkbenchProjection.scope`. */
  readonly scope?: ChangeScope;
  readonly onRegenerate: () => void;
  readonly regenerateDisabled?: boolean;
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
                {item.text}{" "}
                {item.citations.map((citation) => (
                  <CitationChip key={citation.alias} citation={citation} />
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
                  <span>{assumption.text}</span>
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
                  >
                    <q className="text-muted-foreground">{item.quote}</q>{" "}
                    {item.note}
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
                  >
                    {item.text}
                  </DriftItem>
                ))}
              </DriftColumn>
            </div>
          </section>
        )}
        <p className="text-xs text-muted-foreground">
          Citations: {briefCitationStatusLine(brief)}
        </p>
      </div>
      <div className="flex flex-col gap-3">
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
  children,
}: {
  readonly mark: string;
  readonly markClassName: string;
  readonly citations: ReadonlyArray<BriefCitation>;
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
          <CitationChip key={citation.alias} citation={citation} />
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

/**
 * One resolved citation. The kind is carried by an icon rather than a color:
 * hunk, description, and commit are evidence kinds, not statuses, so they never
 * take a status hue.
 */
function CitationChip({
  citation,
}: {
  readonly citation: BriefCitation;
}): React.JSX.Element {
  const Icon = CITATION_ICONS[citation.kind];
  return (
    <span
      title={`${citation.kind}: ${citation.label}`}
      className="mx-0.5 inline-flex items-center gap-1 rounded border bg-accent px-1.5 align-baseline font-mono text-[10px] text-muted-foreground"
    >
      <Icon aria-hidden="true" className="size-3" />
      {briefCitationChipLabel(citation)}
    </span>
  );
}
