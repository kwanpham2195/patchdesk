import { useEffect, useMemo, useState } from "react";
import { Tag } from "lucide-react";

import type { RepositoryLabel } from "../../../domain/github-context";
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

/**
 * Whether a label write on this repository will succeed. No permission
 * signal reaches the renderer for label management (unlike e.g. `canEdit`
 * on a published comment), so every mount starts `"unknown"` rather than
 * guessing: a write is offered, but honestly caveated as unconfirmed.
 * `"denied"` is learned only once GitHub actually refuses a write — from
 * then on further attempts are withheld, the exact defect plan 009 fixed.
 * A first successful write instead confirms `"permitted"`.
 */
type LabelWritePermission = "unknown" | "denied" | "permitted";

type ReadState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "github_read" }
  | { readonly _tag: "github_auth" }
  | {
      readonly _tag: "ready";
      readonly labels: ReadonlyArray<RepositoryLabel>;
      readonly totalCount: number;
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
 * Assigns and removes labels on the pull request under review, rendered
 * next to the read-only chips `LabelChip` already draws in the workbench
 * header — this component reuses `LabelChip` for its own rows rather than
 * drawing a second chip renderer.
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
 * same way other write-only workbench actions withhold themselves.
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
  const [permission, setPermission] = useState<LabelWritePermission>("unknown");
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
      .then(() => setPermission("permitted"))
      .catch((cause: unknown) => {
        // The optimistic guess did not hold: revert it.
        if (nextAttached)
          setPendingAdds((current) => withoutName(current, label.name));
        else setPendingRemoves((current) => withoutName(current, label.name));
        if (cause instanceof PatchdeskApiError && cause.kind === "github_rejected") {
          setPermission("denied");
        } else {
          setWriteError(
            nextAttached
              ? `Patchdesk could not add "${label.name}".`
              : `Patchdesk could not remove "${label.name}".`,
          );
        }
      })
      .finally(() => {
        setBusyNames((current) => withoutName(current, label.name));
      });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" size="xs">
            <Tag /> Labels
          </Button>
        }
      />
      <PopoverContent align="start">
        <PopoverHeader>
          <PopoverTitle>Labels</PopoverTitle>
        </PopoverHeader>
        {permission === "denied" ? (
          <p role="alert" className="text-xs text-destructive">
            You don&apos;t have permission to manage labels on this
            repository.
          </p>
        ) : permission === "unknown" ? (
          <p className="text-xs text-muted-foreground">
            Patchdesk hasn&apos;t confirmed you can manage labels here — a
            change may be refused.
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
