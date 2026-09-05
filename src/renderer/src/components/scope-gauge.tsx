import {
  changeScopeSegments,
  type ChangeScope,
  type ChangeScopeBucket,
} from "../../../domain/change-scope";
import { SCOPE_BUCKET_FILLS, SCOPE_BUCKET_LABELS } from "./scope-gauge-buckets";
import { cn } from "@/lib/utils";

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
 * is the Scope card in the Insights tab; `legend` is the inspector's Scope
 * cell, which sits inside a `<dl>` that already carries the heading and so
 * only wants the bar and the buckets that actually have files. Bucket colors
 * are categorical (`--scope-*`) and never the status hues, so a large
 * generated diff never reads as a failure.
 */
export function ScopeGauge({
  scope,
  size,
  className,
  activeBucket,
  onBucketSelect,
}: {
  readonly scope: ChangeScope;
  readonly size: "bar" | "mini" | "card" | "legend";
  readonly className?: string;
  /** The bucket the Diff is currently filtered by, highlighted on the card. */
  readonly activeBucket?: ChangeScopeBucket | undefined;
  /** Given only where a bucket can filter the Diff; without it the card stays read-only. */
  readonly onBucketSelect?: ((bucket: ChangeScopeBucket) => void) | undefined;
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
  if (size === "legend")
    return (
      <div className={cn("flex flex-col gap-1.5", className)}>
        <ScopeBar scope={scope} label={label} className="h-1.5 w-full" />
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {LEGEND_BUCKETS.map((bucket) => counted.get(bucket)).map((totals) =>
            totals === undefined ? null : (
              <li
                key={totals.bucket}
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2 shrink-0 rounded-[2px]",
                    SCOPE_BUCKET_FILLS[totals.bucket],
                  )}
                />
                <span>{SCOPE_BUCKET_LABELS[totals.bucket]}</span>
                <span className="font-mono tabular-nums text-foreground">
                  {totals.files}
                </span>
              </li>
            ),
          )}
        </ul>
      </div>
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
          const row = (
            <>
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 shrink-0 rounded-[2px]",
                  SCOPE_BUCKET_FILLS[bucket],
                  totals === undefined ? "opacity-50" : undefined,
                )}
              />
              <span>{SCOPE_BUCKET_LABELS[bucket]}</span>
              {totals === undefined ? (
                <span className="font-mono text-[11px] tabular-nums">—</span>
              ) : (
                <ScopeCounts
                  additions={totals.additions}
                  deletions={totals.deletions}
                />
              )}
            </>
          );
          const rowClassName = cn(
            "flex items-center gap-1.5 text-xs",
            totals === undefined
              ? "text-muted-foreground/60"
              : "text-muted-foreground",
          );
          // An empty bucket has no files to filter to, so it stays plain text.
          return (
            <li key={bucket}>
              {onBucketSelect === undefined || totals === undefined ? (
                <span className={rowClassName}>{row}</span>
              ) : (
                <button
                  type="button"
                  aria-pressed={activeBucket === bucket}
                  onClick={() => onBucketSelect(bucket)}
                  className={cn(
                    rowClassName,
                    "-mx-1 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground",
                  )}
                >
                  {row}
                </button>
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
          className={SCOPE_BUCKET_FILLS[segment.bucket]}
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
      `${SCOPE_BUCKET_LABELS[bucket.bucket]} +${bucket.additions} −${bucket.deletions}`,
  );
  return `Scope: ${parts.join(", ")}`;
}
