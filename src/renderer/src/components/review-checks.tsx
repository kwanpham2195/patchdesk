import { useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, CircleDashed, CircleX, ExternalLink, MinusCircle, type LucideIcon } from "lucide-react";

import type { CheckRunSummary, CheckSummary } from "../../../domain/github-context";
import type { PullRequestRef } from "../../../domain/pull-request";
import { openPullRequestExternalUrl, resolvePullRequestExternalUrl } from "@/external-links";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export type CheckResultKind = "passed" | "failed" | "pending" | "other";

export type CheckResultPresentation = {
  readonly kind: CheckResultKind;
  readonly label: string;
  readonly Icon: LucideIcon;
  /** Semantic token treatment; icons and labels carry meaning independently. */
  readonly treatment: string;
};

/** One renderer rule that classifies a represented check run. */
// oxlint-disable-next-line react/only-export-components -- Shared presentation rule consumed by the sidebar summary.
export function classifyCheck(check: CheckRunSummary): CheckResultKind {
  if (check.conclusion === "success") return "passed";
  if (
    check.conclusion === "failure" ||
    check.conclusion === "cancelled" ||
    check.conclusion === "timed_out"
  )
    return "failed";
  if (check.status === "queued" || check.status === "in_progress")
    return "pending";
  return "other";
}

/** Typed icon, label, and semantic treatment for one check run. */
// oxlint-disable-next-line react/only-export-components -- Shared presentation rule consumed by the sidebar summary.
export function presentCheckResult(
  check: CheckRunSummary,
): CheckResultPresentation {
  const kind = classifyCheck(check);
  switch (kind) {
    case "passed":
      return { kind, label: "Passed", Icon: CheckCircle2, treatment: "text-status-success" };
    case "failed":
      return { kind, label: "Failed", Icon: CircleX, treatment: "text-destructive" };
    case "pending":
      return { kind, label: "In progress", Icon: CircleDashed, treatment: "text-status-warning" };
    default:
      return check.conclusion === "skipped" || check.conclusion === "neutral"
        ? { kind, label: "Skipped", Icon: MinusCircle, treatment: "text-muted-foreground" }
        : { kind, label: "Unknown", Icon: MinusCircle, treatment: "text-muted-foreground" };
  }
}

/** Typed icon, label, and semantic treatment for the aggregate check row. */
// oxlint-disable-next-line react/only-export-components -- Shared presentation rule consumed by the sidebar summary.
export function presentOverallCheckResult(
  overall: CheckSummary["overall"],
  freshness:
    | "fresh"
    | "stale"
    | "updates_available"
    | "unavailable"
    | "not_refreshed"
    | undefined,
): CheckResultPresentation {
  if (freshness === "not_refreshed")
    return { kind: "other", label: "Not refreshed", Icon: MinusCircle, treatment: "text-muted-foreground" };
  if (freshness === "unavailable")
    return { kind: "other", label: "Unavailable", Icon: MinusCircle, treatment: "text-muted-foreground" };
  switch (overall) {
    case "passing":
      return { kind: "passed", label: "Passing", Icon: CheckCircle2, treatment: "text-status-success" };
    case "failing":
      return { kind: "failed", label: "Failing", Icon: CircleX, treatment: "text-destructive" };
    case "pending":
      return { kind: "pending", label: "In progress", Icon: CircleDashed, treatment: "text-status-warning" };
    case "skipped":
      return { kind: "other", label: "Skipped", Icon: MinusCircle, treatment: "text-muted-foreground" };
    default:
      return { kind: "other", label: "Unknown", Icon: MinusCircle, treatment: "text-muted-foreground" };
  }
}

export function ReviewChecks({
  checks,
  freshness,
  pullRequest,
  defaultOpen = true,
  showHeader = true,
}: {
  readonly checks: CheckSummary;
  readonly freshness?: "fresh" | "stale" | "unavailable" | "not_refreshed";
  readonly pullRequest?: PullRequestRef;
  readonly defaultOpen?: boolean;
  readonly showHeader?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const grouped = useMemo(() => groupChecks(checks.checks), [checks.checks]);
  const visible = grouped.filter((check) => classifyCheck(check) !== "passed");
  const passing = grouped.filter((check) => classifyCheck(check) === "passed");
  const [showPassing, setShowPassing] = useState(passing.length <= 5);
  const rows = showPassing ? grouped : visible;
  const content = (
    <>
      <p className="pb-2 text-xs text-muted-foreground">
        {freshness === "fresh" ? "Read-only checks from the reviewed head." : "Checks may be incomplete until GitHub state is refreshed."}
      </p>
      {grouped.length === 0 ? <p className="pb-3 text-sm text-muted-foreground">No check details are available.</p> : (
        <ul className="border-t py-2" aria-label="Pull request checks">
          {rows.map((check) => <CheckRow key={check.key} check={check} {...(pullRequest === undefined ? {} : { pullRequest })} />)}
        </ul>
      )}
      {!showPassing && passing.length > 0 ? (
        <Button variant="ghost" size="sm" className="mb-2" onClick={() => setShowPassing(true)}>
          Show {passing.length} passing check{passing.length === 1 ? "" : "s"}
        </Button>
      ) : null}
      {showPassing && passing.length > 5 ? (
        <Button variant="ghost" size="sm" className="mb-2" onClick={() => setShowPassing(false)}>
          Hide {passing.length} passing checks
        </Button>
      ) : null}
    </>
  );
  if (!showHeader) return <div>{content}</div>;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b">
      <div className="flex items-center justify-between gap-3 py-2">
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" aria-label={`${open ? "Collapse" : "Expand"} checks`} />}>
          Checks
          <ChevronDown data-icon="inline-end" className={open ? undefined : "-rotate-90"} aria-hidden="true" />
        </CollapsibleTrigger>
        <span className="text-xs text-muted-foreground" aria-label={`Checks overall: ${overallLabel(checks.overall, freshness)}`}>
          {overallLabel(checks.overall, freshness)}
        </span>
      </div>
      <CollapsibleContent>{content}</CollapsibleContent>
    </Collapsible>
  );
}

type GroupedCheck = CheckRunSummary & { readonly key: string; readonly count: number };

function groupChecks(checks: ReadonlyArray<CheckRunSummary>): ReadonlyArray<GroupedCheck> {
  const grouped = new Map<string, GroupedCheck>();
  for (const check of checks) {
    const key = [check.name, check.required, check.status, check.conclusion ?? "", check.url ?? ""].join("\u0000");
    const current = grouped.get(key);
    grouped.set(key, current === undefined ? { ...check, key, count: 1 } : { ...current, count: current.count + 1 });
  }
  return [...grouped.values()].sort((left, right) => checkPriority(left) - checkPriority(right) || left.name.localeCompare(right.name));
}

function CheckRow({ check, pullRequest }: { readonly check: GroupedCheck; readonly pullRequest?: PullRequestRef }): React.JSX.Element {
  const result = presentCheckResult(check);
  const Icon = result.Icon;
  const externalUrl =
    check.url === undefined
      ? undefined
      : resolvePullRequestExternalUrl(check.url, pullRequest);
  return (
    <li className="flex min-w-0 items-center gap-2 py-1.5 text-sm">
      <Icon className={cn("size-4 shrink-0", result.treatment)} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate" title={check.name}>{check.name}</span>
      <span className="sr-only">{requirementLabel(check.required)}</span>
      <span className={cn("shrink-0 text-sm", result.treatment)}>{result.label}</span>
      {check.count > 1 ? <Badge variant="outline">×{check.count}</Badge> : null}
      {externalUrl === undefined ? null : <Button variant="ghost" size="icon-xs" aria-label={`Open ${check.name} in GitHub`} onClick={() => void openPullRequestExternalUrl(externalUrl, pullRequest)}><ExternalLink /></Button>}
    </li>
  );
}

function checkPriority(check: CheckRunSummary): number {
  const kind = classifyCheck(check);
  if (kind === "failed" && check.required === true) return 0;
  if (kind === "failed") return 1;
  if (kind === "pending") return 2;
  if (check.required === true) return 3;
  return 4;
}

function requirementLabel(required: CheckRunSummary["required"]): string {
  return required === true ? "Required" : required === false ? "Optional" : "No requirement metadata";
}

function overallLabel(
  overall: CheckSummary["overall"],
  freshness?: "fresh" | "stale" | "unavailable" | "not_refreshed",
): string {
  return presentOverallCheckResult(overall, freshness).label;
}
