import { useMemo, useState } from "react";
import { CheckCircle2, CircleDashed, CircleX, ExternalLink, MinusCircle } from "lucide-react";

import type { CheckRunSummary, CheckSummary } from "../../../domain/github-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export function ReviewChecks({
  checks,
  freshness,
  defaultOpen = true,
}: {
  readonly checks: CheckSummary;
  readonly freshness?: "fresh" | "stale" | "unavailable";
  readonly defaultOpen?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const grouped = useMemo(() => groupChecks(checks.checks), [checks.checks]);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b">
      <div className="flex items-center justify-between gap-3 py-2">
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" aria-label={`${open ? "Collapse" : "Expand"} checks`} />}>
          Checks
        </CollapsibleTrigger>
        <Badge variant={checks.overall === "passing" ? "secondary" : "outline"}>{overallLabel(checks.overall)}</Badge>
      </div>
      <CollapsibleContent>
        <p className="pb-2 text-xs text-muted-foreground">
          {freshness === "fresh" ? "Read-only checks from the reviewed head." : "Checks may be incomplete until GitHub state is refreshed."}
        </p>
        {grouped.length === 0 ? <p className="pb-3 text-sm text-muted-foreground">No check details are available.</p> : (
          <ul className="divide-y border-t" aria-label="Pull request checks">
            {grouped.map((check) => <CheckRow key={check.key} check={check} />)}
          </ul>
        )}
      </CollapsibleContent>
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
  return [...grouped.values()];
}

function CheckRow({ check }: { readonly check: GroupedCheck }): React.JSX.Element {
  const result = resultFor(check);
  const Icon = result.kind === "passed" ? CheckCircle2 : result.kind === "failed" ? CircleX : result.kind === "pending" ? CircleDashed : MinusCircle;
  return (
    <li className="flex min-w-0 items-center gap-2 py-2 text-sm">
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate" title={check.name}>{check.name}</span>
      <span className="hidden text-xs text-muted-foreground min-[480px]:inline">{requirementLabel(check.required)}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{result.label}</span>
      {check.count > 1 ? <Badge variant="outline">×{check.count}</Badge> : null}
      {check.url === undefined ? null : <Button variant="ghost" size="icon-xs" nativeButton={false} render={<a href={check.url} target="_blank" rel="noreferrer" aria-label={`Open ${check.name} in GitHub`} />}><ExternalLink /></Button>}
    </li>
  );
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

function overallLabel(overall: CheckSummary["overall"]): string {
  return overall === "passing" ? "Passing" : overall === "failing" ? "Failing" : overall === "pending" ? "In progress" : overall === "skipped" ? "Skipped" : "Unknown";
}
