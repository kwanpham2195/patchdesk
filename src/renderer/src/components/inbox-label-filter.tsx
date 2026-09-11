import { useEffect, useState } from "react";
import { ListFilter } from "lucide-react";

import type { RepositoryLabelListResponse } from "@/renderer-contracts";
import {
  forbiddenCopy,
  projectRepositoryLabelReadState,
  rateLimitedCopy,
  type RepositoryLabelReadState,
} from "@/github-read-failure-copy";
import { LabelColorDot } from "./label-chip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

function labelFilterTriggerText(selected: ReadonlyArray<string>): string {
  if (selected.length === 0) return "All labels";
  if (selected.length === 1) return selected[0] ?? "All labels";
  return `${selected.length} labels`;
}

/**
 * The Pull requests screen's label filter: fed from the Selected
 * repository's real, repository-wide labels (`GET /v1/inbox/labels`), never
 * from `rows` — a label used only on a pull request off the loaded page is
 * still offered here. Fetches on open, the same lazy-on-demand shape
 * `LabelPicker` uses for the same read (label-picker.tsx), so opening the
 * inbox never pays for a label read nobody asked for.
 */
export function LabelFilterPopover({
  fetchLabels,
  selectedLabels,
  onLabelChange,
  labelFits,
}: {
  readonly fetchLabels: () => Promise<RepositoryLabelListResponse | undefined>;
  readonly selectedLabels: ReadonlyArray<string>;
  readonly onLabelChange: (value: ReadonlyArray<string>) => void;
  readonly labelFits: (name: string) => boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [readState, setReadState] = useState<RepositoryLabelReadState>({
    _tag: "loading",
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setReadState({ _tag: "loading" });
    fetchLabels()
      .then((response) => {
        if (!cancelled) setReadState(projectRepositoryLabelReadState(response));
      })
      .catch(() => {
        if (!cancelled) setReadState({ _tag: "github_read" });
      });
    return () => {
      cancelled = true;
    };
  }, [open, fetchLabels]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="min-w-28 max-w-40 justify-start text-xs"
            aria-label="Filter by label"
          >
            <ListFilter aria-hidden="true" />
            <span className="truncate">
              {labelFilterTriggerText(selectedLabels)}
            </span>
          </Button>
        }
      />
      <PopoverContent align="start">
        {selectedLabels.length > 0 ? (
          <Button
            variant="ghost"
            size="xs"
            className="mb-1 w-full justify-start"
            onClick={() => onLabelChange([])}
          >
            Clear
          </Button>
        ) : null}
        <LabelFilterList
          labelFits={labelFits}
          readState={readState}
          selectedLabels={selectedLabels}
          onLabelChange={onLabelChange}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Renders a GitHub read failure or the ready list; only a successful
 * zero-label read may render the empty-list message. */
function LabelFilterList({
  readState,
  selectedLabels,
  onLabelChange,
  labelFits,
}: {
  readonly readState: RepositoryLabelReadState;
  readonly selectedLabels: ReadonlyArray<string>;
  readonly onLabelChange: (value: ReadonlyArray<string>) => void;
  /** False for a label this filter has no room left for — see `labelFits` in `use-workspace-inbox.ts`. */
  readonly labelFits: (name: string) => boolean;
}): React.JSX.Element {
  if (readState._tag === "loading")
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Spinner className="size-3" /> Loading labels…
      </p>
    );
  const failure =
    readState._tag === "github_auth"
      ? ([
          "destructive",
          "GitHub authentication is required before Patchdesk can list this repository's labels.",
        ] as const)
      : readState._tag === "github_read"
        ? ([
            "destructive",
            "Patchdesk could not load this repository's labels. Reopen this menu to retry.",
          ] as const)
        : readState._tag === "github_rate_limited"
          ? (["warning", rateLimitedCopy(readState.resumeAt)] as const)
          : readState._tag === "github_forbidden"
            ? (["destructive", forbiddenCopy(readState.reason)] as const)
            : undefined;
  if (failure !== undefined)
    return (
      <Alert variant={failure[0]}>
        <AlertDescription className="text-xs">{failure[1]}</AlertDescription>
      </Alert>
    );
  if (readState._tag !== "ready") throw new Error("Unexpected label state");
  if (readState.labels.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        This repository has no labels.
      </p>
    );
  const selectedLabelSet = new Set(selectedLabels);
  const anyRefused = readState.labels.some(
    (label) => !selectedLabelSet.has(label.name) && !labelFits(label.name),
  );
  return (
    <div className="max-h-64 overflow-y-auto">
      <ul className="flex flex-col gap-0.5" aria-label="Labels">
        {readState.labels.map((label) => {
          const checked = selectedLabelSet.has(label.name);
          // Clearing a selected label only shortens the query.
          const fits = checked || labelFits(label.name);
          return (
            <li key={label.name}>
              <label
                className={cn(
                  "flex items-center gap-2 rounded-md px-1 py-1 text-xs",
                  fits
                    ? "cursor-pointer hover:bg-muted/50"
                    : "text-muted-foreground",
                )}
              >
                <Checkbox
                  checked={checked}
                  disabled={!fits}
                  onCheckedChange={() =>
                    onLabelChange(
                      checked
                        ? selectedLabels.filter((name) => name !== label.name)
                        : [...selectedLabels, label.name],
                    )
                  }
                />
                <LabelColorDot color={label.color} />
                {label.name}
              </label>
            </li>
          );
        })}
      </ul>
      {anyRefused ? (
        <p className="mt-1 text-xs text-muted-foreground">
          This filter is full. Clear a selected label to choose another.
        </p>
      ) : null}
      {readState.totalCount > readState.labels.length ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Showing {readState.labels.length} of {readState.totalCount} labels.
          Some repository labels aren&apos;t shown.
        </p>
      ) : null}
    </div>
  );
}
