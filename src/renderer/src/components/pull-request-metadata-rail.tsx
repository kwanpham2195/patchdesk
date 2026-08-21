import type { GitHubLabel } from "../../../domain/github-context";
import { freshnessCopy, type RevisionFreshness } from "../rail-freshness";
import { LabelChip } from "./label-chip";
import { LabelPicker, type LabelPickerActions } from "./label-picker";

/**
 * One topic section inside `PullRequestMetadataRail` (Labels today;
 * Assignees and Reviewers in later slices). Exported so those later slices
 * only need to add another `<RailSection>` rather than rebuild the header
 * row, freshness line, and settings-control slot.
 */
export function RailSection({
  title,
  freshness,
  settings,
  children,
}: {
  readonly title: string;
  readonly freshness: RevisionFreshness;
  readonly settings?: React.ReactNode;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      aria-label={title}
      className="border-b py-3 first:pt-0 last:border-b-0"
    >
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {title}
          </h2>
          <p className="text-[10px] text-muted-foreground">
            {freshnessCopy(freshness)}
          </p>
        </div>
        {settings}
      </div>
      {children}
    </section>
  );
}

/**
 * The sticky right-hand rail on the Conversation tab, holding one
 * `RailSection` per pull-request metadata topic. `ReviewWorkbench` builds
 * this element (it holds the model) and passes it to `Conversation` as a
 * plain `rail` prop, which keeps the rail off the Diff and Insights tabs by
 * construction — `Conversation` only ever renders what it's given.
 *
 * Under `terminal` (the Review is no longer open), every section renders
 * read-only: `settings` is withheld entirely rather than left to
 * `LabelPicker`'s own "no actions wired" fallback, so a later section that
 * always has actions wired still goes read-only under Terminal.
 */
export function PullRequestMetadataRail({
  labels,
  freshness,
  terminal,
  labelActions,
}: {
  readonly labels: ReadonlyArray<GitHubLabel>;
  readonly freshness: RevisionFreshness;
  readonly terminal: boolean;
  readonly labelActions?: LabelPickerActions;
}): React.JSX.Element {
  return (
    <aside
      aria-label="Pull request metadata"
      className="w-full min-[1100px]:sticky min-[1100px]:top-0 min-[1100px]:w-[272px] min-[1100px]:shrink-0"
    >
      <RailSection
        title="Labels"
        freshness={freshness}
        {...(terminal
          ? {}
          : {
              settings: (
                <LabelPicker
                  attachedLabels={labels}
                  {...(labelActions === undefined
                    ? {}
                    : { actions: labelActions })}
                />
              ),
            })}
      >
        {labels.length === 0 ? (
          <p className="text-xs text-muted-foreground">No labels.</p>
        ) : (
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Pull request labels"
          >
            {labels.map((label) => (
              <LabelChip key={label.name} label={label} />
            ))}
          </div>
        )}
      </RailSection>
    </aside>
  );
}
