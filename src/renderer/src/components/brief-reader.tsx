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
