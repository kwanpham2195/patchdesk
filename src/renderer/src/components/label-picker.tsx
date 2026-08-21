import { useEffect, useMemo, useState } from "react";
import { Settings2 } from "lucide-react";

import type {
  RepositoryLabel,
  RepositoryLabelPermission,
} from "../../../domain/github-context";
import { PatchdeskApiError } from "../api-client";
import type { RepositoryLabelListResponse } from "../renderer-contracts";
import { LabelChip } from "./label-chip";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./ui/popover";
import { Spinner } from "./ui/spinner";

export type LabelPickerActions = {
  readonly fetchLabels: () => Promise<RepositoryLabelListResponse | undefined>;
  readonly addLabels: (
    labels: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  ) => Promise<void>;
  readonly removeLabels: (
    labels: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  ) => Promise<void>;
};

type ReadState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "github_read" }
  | { readonly _tag: "github_auth" }
  | {
      readonly _tag: "ready";
      readonly labels: ReadonlyArray<RepositoryLabel>;
      readonly totalCount: number;
      /**
       * The service's real, GitHub-evidenced answer for whether this
       * account can write labels here (`LabelListOutcome.ready.permission`
       * in `src/services/label-service.ts`). Never inferred client-side —
       * `"unknown"` means evidence was genuinely unavailable, not that a
       * write hasn't been tried yet.
       */
      readonly permission: RepositoryLabelPermission;
    }
  | { readonly _tag: "github_rate_limited"; readonly resumeAt?: string }
  | {
      readonly _tag: "github_forbidden";
      readonly reason?:
        | "ip_allow_list"
        | "saml"
        | "insufficient_scopes"
        | "unknown";
    };

function withoutName<T extends string>(
  set: ReadonlySet<T>,
  name: T,
): ReadonlySet<T> {
  if (!set.has(name)) return set;
  const next = new Set(set);
  next.delete(name);
  return next;
}

/**
 * Assigns and removes labels on the pull request under review. Rendered as
 * the Labels section's settings control in `PullRequestMetadataRail`, next
 * to the read-only chips `LabelChip` already draws there — this component
 * reuses `LabelChip` for its own rows rather than drawing a second chip
 * renderer. It has exactly one trigger style (a gear-icon button); the rail
 * is its only mount point now that the workbench header no longer renders a
 * labels row.
 *
 * Mirrors `ConversationThreadCard`'s resolve/unresolve override: toggling a
 * label applies to local state immediately, is dropped once the
 * authoritative `attachedLabels` prop catches up with it (an explicit
 * refresh or reload re-baselines the projection), and a failed write
 * reverts the optimistic guess with a visible error rather than silently
 * reverting.
 *
 * `actions` is `undefined` when the Review can no longer accept label
 * writes (e.g. closed/merged); the picker renders nothing in that case, the
 * same way other write-only workbench actions withhold themselves. Under
 * Terminal, `PullRequestMetadataRail` withholds this component entirely
 * (rather than relying on `actions` being undefined), so every rail section
 * goes read-only the same way regardless of whether its actions happen to be
 * wired.
 */
export function LabelPicker({
  attachedLabels,
  actions,
}: {
  readonly attachedLabels: ReadonlyArray<{
    readonly name: string;
    readonly color: string;
  }>;
  readonly actions?: LabelPickerActions;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [readState, setReadState] = useState<ReadState>({ _tag: "loading" });
  const permission: RepositoryLabelPermission =
    readState._tag === "ready" ? readState.permission : "unknown";
  const [pendingAdds, setPendingAdds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingRemoves, setPendingRemoves] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [busyNames, setBusyNames] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [writeError, setWriteError] = useState<string>();
  // Tracks the last `attachedLabels` prop identity rendered, so a change to
  // it can be adjusted for during rendering (the pattern React recommends
  // over an effect for "adjusting state when a prop changes":
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const [prevAttachedLabels, setPrevAttachedLabels] = useState(attachedLabels);

  const attachedNames = useMemo(
    () => new Set(attachedLabels.map((label) => label.name)),
    [attachedLabels],
  );
  // Drop each optimistic override once the authoritative attached-label set
  // catches up with it, so a stale local guess never outlives real data.
  if (prevAttachedLabels !== attachedLabels) {
    setPrevAttachedLabels(attachedLabels);
    setPendingAdds((current) => {
      const next = new Set(
        [...current].filter((name) => !attachedNames.has(name)),
      );
      return next.size === current.size ? current : next;
    });
    setPendingRemoves((current) => {
      const next = new Set(
        [...current].filter((name) => attachedNames.has(name)),
      );
      return next.size === current.size ? current : next;
    });
  }

  useEffect(() => {
    if (!open || actions === undefined) return;
    let cancelled = false;
    setReadState({ _tag: "loading" });
    actions
      .fetchLabels()
      .then((response) => {
        if (cancelled) return;
        setReadState(projectReadState(response));
      })
      .catch(() => {
        if (!cancelled) setReadState({ _tag: "github_read" });
      });
    return () => {
      cancelled = true;
    };
  }, [open, actions]);

  if (actions === undefined) return null;

  const toggle = (label: RepositoryLabel, nextAttached: boolean): void => {
    if (busyNames.has(label.name) || permission === "denied") return;
    setWriteError(undefined);
    setBusyNames((current) => new Set(current).add(label.name));
    if (nextAttached) {
      setPendingAdds((current) => new Set(current).add(label.name));
      setPendingRemoves((current) => withoutName(current, label.name));
    } else {
      setPendingRemoves((current) => new Set(current).add(label.name));
      setPendingAdds((current) => withoutName(current, label.name));
    }
    const ref = { id: label.id, name: label.name };
    const write = nextAttached
      ? actions.addLabels([ref])
      : actions.removeLabels([ref]);
    write
      .catch((cause: unknown) => {
        // The optimistic guess did not hold: revert it.
        if (nextAttached)
          setPendingAdds((current) => withoutName(current, label.name));
        else setPendingRemoves((current) => withoutName(current, label.name));
        // Permission state is never inferred from this: it already comes
        // from the read path (`readState.permission`), evidenced by
        // `getRepositoryPermission`. A rejected write here still gets a
        // specific reason surfaced — a permitted user can still hit e.g. an
        // IP allow list — but it does not change what the picker believes
        // about this account's standing.
        const reason =
          cause instanceof PatchdeskApiError ? ` ${cause.message}` : "";
        setWriteError(
          nextAttached
            ? `Patchdesk could not add "${label.name}".${reason}`
            : `Patchdesk could not remove "${label.name}".${reason}`,
        );
      })
      .finally(() => {
        setBusyNames((current) => withoutName(current, label.name));
      });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon-xs" aria-label="Manage labels" />
        }
      >
        <Settings2 />
      </PopoverTrigger>
      <PopoverContent align="start">
        <PopoverHeader>
          <PopoverTitle>Labels</PopoverTitle>
        </PopoverHeader>
        {readState._tag === "ready" && permission === "denied" ? (
          <p role="alert" className="text-xs text-destructive">
            This account cannot manage labels on this repository.
          </p>
        ) : readState._tag === "ready" && permission === "unknown" ? (
          <p className="text-xs text-muted-foreground">
            Patchdesk could not confirm you can manage labels here — a change
            may be refused.
          </p>
        ) : null}
        {writeError === undefined ? null : (
          <p role="alert" className="text-xs text-destructive">
            {writeError}
          </p>
        )}
        <LabelPickerList
          readState={readState}
          attachedNames={attachedNames}
          pendingAdds={pendingAdds}
          pendingRemoves={pendingRemoves}
          busyNames={busyNames}
          disabled={permission === "denied"}
          onToggle={toggle}
        />
      </PopoverContent>
    </Popover>
  );
}

function projectReadState(
  response: RepositoryLabelListResponse | undefined,
): ReadState {
  if (response === undefined) return { _tag: "github_read" };
  if (response.state === "ready") {
    const labels = response.labels ?? [];
    return {
      _tag: "ready",
      labels,
      totalCount: response.totalCount ?? labels.length,
      // Fails closed to `"unknown"` (never `"permitted"`) if the field is
      // ever missing — an unconfirmed state, not an authorized one.
      permission: response.permission ?? "unknown",
    };
  }
  if (response.state === "github_rate_limited") {
    const resumeAtField =
      response.resumeAt === undefined ? {} : { resumeAt: response.resumeAt };
    return { _tag: "github_rate_limited", ...resumeAtField };
  }
  if (response.state === "github_forbidden") {
    const reasonField =
      response.forbiddenReason === undefined
        ? {}
        : { reason: response.forbiddenReason };
    return { _tag: "github_forbidden", ...reasonField };
  }
  return { _tag: response.state };
}

/** The picker's body: the read state's message, or its list of toggleable repository labels. */
function LabelPickerList({
  readState,
  attachedNames,
  pendingAdds,
  pendingRemoves,
  busyNames,
  disabled,
  onToggle,
}: {
  readonly readState: ReadState;
  readonly attachedNames: ReadonlySet<string>;
  readonly pendingAdds: ReadonlySet<string>;
  readonly pendingRemoves: ReadonlySet<string>;
  readonly busyNames: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onToggle: (label: RepositoryLabel, nextAttached: boolean) => void;
}): React.JSX.Element {
  if (readState._tag === "loading")
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Spinner className="size-3" /> Loading labels…
      </p>
    );
  if (readState._tag === "github_auth")
    return (
      <p role="alert" className="text-xs text-destructive">
        GitHub authentication is required before Patchdesk can list this
        repository&apos;s labels.
      </p>
    );
  if (readState._tag === "github_read")
    return (
      <p role="alert" className="text-xs text-destructive">
        Patchdesk could not load this repository&apos;s labels. Reopen this
        menu to retry.
      </p>
    );
  if (readState._tag === "github_rate_limited")
    return (
      <p role="alert" className="text-xs text-destructive">
        {rateLimitedCopy(readState.resumeAt)}
      </p>
    );
  if (readState._tag === "github_forbidden")
    return (
      <p role="alert" className="text-xs text-destructive">
        {forbiddenCopy(readState.reason)}
      </p>
    );
  return (
    <div className="max-h-64 overflow-y-auto">
      <ul className="flex flex-col gap-0.5" aria-label="Repository labels">
        {readState.labels.map((label) => {
          const attached =
            pendingAdds.has(label.name) ||
            (attachedNames.has(label.name) && !pendingRemoves.has(label.name));
          const busy = busyNames.has(label.name);
          return (
            <li key={label.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/50">
                <Checkbox
                  checked={attached}
                  disabled={disabled || busy}
                  onCheckedChange={() => onToggle(label, !attached)}
                />
                <LabelChip label={{ name: label.name, color: label.color }} />
              </label>
            </li>
          );
        })}
      </ul>
      {readState.totalCount > readState.labels.length ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Showing {readState.labels.length} of {readState.totalCount} labels.
          Some repository labels aren&apos;t shown.
        </p>
      ) : null}
    </div>
  );
}

function rateLimitedCopy(resumeAt: string | undefined): string {
  const resumeAtMs = resumeAt === undefined ? Number.NaN : Date.parse(resumeAt);
  if (Number.isNaN(resumeAtMs))
    return "GitHub rate-limited this account. Try again once the limit clears.";
  const formatted = new Date(resumeAtMs).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `GitHub rate-limited this account. Try again at ${formatted}.`;
}

function forbiddenCopy(
  reason: "ip_allow_list" | "saml" | "insufficient_scopes" | "unknown" | undefined,
): string {
  switch (reason) {
    case "ip_allow_list":
      return "GitHub blocked this read: an IP allow list is enabled and this network is not on it.";
    case "saml":
      return "GitHub blocked this read: this account's token needs SAML single sign-on authorization.";
    case "insufficient_scopes":
      return "GitHub blocked this read: this account's token lacks the scopes this repository requires.";
    default:
      return "GitHub blocked this read and did not say why.";
  }
}
