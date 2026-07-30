import { useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, CircleDashed, CircleX, ExternalLink, MinusCircle } from "lucide-react";

import type { CheckRunSummary, CheckSummary } from "../../../domain/github-context";
import type { PullRequestRef } from "../../../domain/pull-request";
import { openPullRequestExternalUrl, resolvePullRequestExternalUrl } from "@/external-links";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

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
  const visible = grouped.filter((check) => resultFor(check).kind !== "passed");
  const passing = grouped.filter((check) => resultFor(check).kind === "passed");
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
  const result = resultFor(check);
  const externalUrl =
    check.url === undefined
      ? undefined
      : resolvePullRequestExternalUrl(check.url, pullRequest);
  const Icon = result.kind === "passed" ? CheckCircle2 : result.kind === "failed" ? CircleX : result.kind === "pending" ? CircleDashed : MinusCircle;
  return (
    <li className="flex min-w-0 items-center gap-2 py-1.5 text-sm">
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate" title={check.name}>{check.name}</span>
      <span className="sr-only">{requirementLabel(check.required)}</span>
      <span className="shrink-0 text-sm text-muted-foreground">{result.label}</span>
      {check.count > 1 ? <Badge variant="outline">×{check.count}</Badge> : null}
      {externalUrl === undefined ? null : <Button variant="ghost" size="icon-xs" aria-label={`Open ${check.name} in GitHub`} onClick={() => void openPullRequestExternalUrl(externalUrl, pullRequest)}><ExternalLink /></Button>}
    </li>
  );
}

function checkPriority(check: CheckRunSummary): number {
  const result = resultFor(check);
  if (result.kind === "failed" && check.required === true) return 0;
  if (result.kind === "failed") return 1;
  if (result.kind === "pending") return 2;
  if (check.required === true) return 3;
  return 4;
}

function requirementLabel(required: CheckRunSummary["required"]): string {
  return required === true ? "Required" : required === false ? "Optional" : "No requirement metadata";
}

function resultFor(check: CheckRunSummary): { readonly kind: "passed" | "failed" | "pending" | "other"; readonly label: string } {
  if (check.conclusion === "success") return { kind: "passed", label: "Passed" };
  if (check.conclusion === "failure" || check.conclusion === "cancelled" || check.conclusion === "timed_out") return { kind: "failed", label: "Failed" };
  if (check.status === "queued" || check.status === "in_progress") return { kind: "pending", label: "In progress" };
  if (check.conclusion === "skipped" || check.conclusion === "neutral") return { kind: "other", label: "Skipped" };
  return { kind: "other", label: "Unknown" };
}

function overallLabel(
  overall: CheckSummary["overall"],
  freshness?: "fresh" | "stale" | "unavailable" | "not_refreshed",
): string {
  if (freshness === "not_refreshed") return "Not refreshed";
  if (freshness === "unavailable") return "Unavailable";
  return overall === "passing" ? "Passing" : overall === "failing" ? "Failing" : overall === "pending" ? "In progress" : overall === "skipped" ? "Skipped" : "Unknown";
}
