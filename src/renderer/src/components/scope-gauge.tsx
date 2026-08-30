import {
  changeScopeSegments,
  type ChangeScope,
  type ChangeScopeBucket,
} from "../../../domain/change-scope";
import { cn } from "@/lib/utils";

const BUCKET_LABELS = {
  core: "Core",
  tests: "Tests",
  generated: "Generated",
  docs: "Docs",
  config: "Config",
} satisfies Record<ChangeScopeBucket, string>;

/**
 * Each bucket's fill class, written out in full because Tailwind reads class
 * names as literal source text; a composed `bg-[var(--scope-${bucket})]`
 * would never be generated. `generated` is a diagonal hatch (see
 * `.scope-gauge-hatch` in `styles.css`) so its share reads as "not
 * hand-written" without spending a sixth hue on it.
 */
const BUCKET_FILLS = {
  core: "bg-[var(--scope-core)]",
  tests: "bg-[var(--scope-tests)]",
  generated: "scope-gauge-hatch",
  docs: "bg-[var(--scope-docs)]",
  config: "bg-[var(--scope-config)]",
} satisfies Record<ChangeScopeBucket, string>;

/**
 * The card legend's row order. `ChangeScope.buckets` omits a bucket with no
 * file, but the card still names all five: an em dash beside `Generated` says
 * this diff has no generated lines, where a missing row would only say the
 * gauge did not mention them.
 */
const LEGEND_BUCKETS: ReadonlyArray<ChangeScopeBucket> = [
  "core",
  "tests",
  "generated",
  "docs",
  "config",
];

/**
 * The Scope gauge: one bar whose segments are the changed lines per bucket.
 * `bar` is the inbox row, whose Changes cell already prints the totals; `mini`
 * is the workbench header chip, which has no other place to show them; `card`
 * is the Scope card in the Insights tab. Bucket colors are categorical
 * (`--scope-*`) and never the status hues, so a large generated diff never
 * reads as a failure.
 */
export function ScopeGauge({
  scope,
  size,
  className,
}: {
  readonly scope: ChangeScope;
  readonly size: "bar" | "mini" | "card";
  readonly className?: string;
}): React.JSX.Element {
  const label = scopeGaugeLabel(scope);
  if (size === "bar")
    return (
      <span className={cn("inline-flex", className)} title={label}>
        <ScopeBar scope={scope} label={label} className="h-1.5 w-14" />
      </span>
    );
  if (size === "mini")
    return (
      <span
        className={cn("inline-flex items-center gap-1.5", className)}
        title={label}
      >
        <ScopeBar scope={scope} label={label} className="h-1.5 w-14" />
        <ScopeCounts
          additions={scope.total.additions}
          deletions={scope.total.deletions}
        />
      </span>
    );
  const counted = new Map(
    scope.buckets.map((bucket) => [bucket.bucket, bucket]),
  );
  return (
    <div className={cn("flex flex-col gap-2 rounded-md border p-3", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">Scope</h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {scope.total.files} {scope.total.files === 1 ? "file" : "files"}
        </span>
      </div>
      <ScopeBar scope={scope} label={label} className="h-2.5 w-full" />
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {LEGEND_BUCKETS.map((bucket) => {
          const totals = counted.get(bucket);
          return (
            <li
              key={bucket}
              className={cn(
                "flex items-center gap-1.5 text-xs",
                totals === undefined
                  ? "text-muted-foreground/60"
                  : "text-muted-foreground",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 shrink-0 rounded-[2px]",
                  BUCKET_FILLS[bucket],
                  totals === undefined ? "opacity-50" : undefined,
                )}
              />
              <span>{BUCKET_LABELS[bucket]}</span>
              {totals === undefined ? (
                <span className="font-mono text-[11px] tabular-nums">—</span>
              ) : (
                <ScopeCounts
                  additions={totals.additions}
                  deletions={totals.deletions}
                />
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        Buckets come from this repository&rsquo;s path rules. No model involved.
      </p>
    </div>
  );
}

function ScopeBar({
  scope,
  label,
  className,
}: {
  readonly scope: ChangeScope;
  readonly label: string;
  readonly className: string;
}): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        "flex shrink-0 overflow-hidden rounded-full bg-muted",
        className,
      )}
    >
      {changeScopeSegments(scope).map((segment) => (
        <span
          key={segment.bucket}
          className={BUCKET_FILLS[segment.bucket]}
          style={{ flex: `0 0 ${segment.percent}%` }}
        />
      ))}
    </span>
  );
}

function ScopeCounts({
  additions,
  deletions,
}: {
  readonly additions: number;
  readonly deletions: number;
}): React.JSX.Element {
  return (
    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
      +{additions} −{deletions}
    </span>
  );
}

/** The gauge's one sentence, used as both the accessible name and the hover title. */
function scopeGaugeLabel(scope: ChangeScope): string {
  if (scope.buckets.length === 0) return "Scope: no changed files";
  const parts = scope.buckets.map(
    (bucket) =>
      `${BUCKET_LABELS[bucket.bucket]} +${bucket.additions} −${bucket.deletions}`,
  );
  return `Scope: ${parts.join(", ")}`;
}
