import { useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Check, GitBranch } from "lucide-react";

import { contextualMessage } from "../api-client";
import type { BaseBranchListResponse } from "../base-branch-contracts";
import type { BaseBranchChangeOutcome } from "../flows/use-review-metadata-actions";
import {
  forbiddenCopy,
  rateLimitedCopy,
  signInCopy,
  WRITE_PERMISSION_UNCONFIRMED,
} from "../github-read-failure-copy";
import {
  useBaseBranchCandidates,
  type BaseBranchReadState,
} from "../hooks/use-base-branch-candidates";
import { BASE_BRANCH_MESSAGES } from "../review-copy";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineError } from "@/components/ui/inline-error";
import { Spinner } from "@/components/ui/spinner";

/**
 * What the base-branch change needs from the workbench. It lives with the
 * draft toggle in PR overview rather than in the metadata rail (ADR 0029)
 * because a new base changes commits, the diff, checks, and merge readiness.
 */
export type ChangeBaseBranchActions = {
  readonly fetchBaseBranches: (
    query?: string,
  ) => Promise<BaseBranchListResponse | undefined>;
  readonly setBaseBranch: (branch: string) => Promise<BaseBranchChangeOutcome>;
  readonly refresh: () => Promise<void>;
};

/** The Merge readiness button that opens the base-branch dialog and owns its read. */
export function ChangeBaseBranchCommand({
  repository,
  actions,
}: {
  readonly repository: string;
  readonly actions: ChangeBaseBranchActions;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const { query, setQuery, readState } = useBaseBranchCandidates({
    open,
    fetchBaseBranches: actions.fetchBaseBranches,
  });
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => setOpen(true)}
      >
        <GitBranch data-icon="inline-start" />
        Change base branch
      </Button>
      <ChangeBaseBranchDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
        repository={repository}
        query={query}
        onQueryChange={setQuery}
        readState={readState}
        onConfirm={actions.setBaseBranch}
        onRefresh={actions.refresh}
      />
    </>
  );
}

/** Picks a branch of the base repository, explains the consequences, and confirms the change. */
export function ChangeBaseBranchDialog({
  open,
  onOpenChange,
  repository,
  query,
  onQueryChange,
  readState,
  onConfirm,
  onRefresh,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly repository: string;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly readState: BaseBranchReadState;
  readonly onConfirm: (branch: string) => Promise<BaseBranchChangeOutcome>;
  readonly onRefresh: () => Promise<void>;
}): React.JSX.Element {
  const [selected, setSelected] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string>();
  const [unrefreshedBranch, setUnrefreshedBranch] = useState<string>();

  const ready = readState._tag === "ready" ? readState : undefined;
  const current = ready?.current;
  const denied = ready?.permission === "denied";
  const canConfirm =
    ready !== undefined &&
    !denied &&
    !busy &&
    selected !== undefined &&
    selected !== current;

  const changeOpen = (next: boolean): void => {
    if (busy) return;
    if (!next) {
      setSelected(undefined);
      setWriteError(undefined);
      setUnrefreshedBranch(undefined);
    }
    onOpenChange(next);
  };

  const confirm = (branch: string): void => {
    setBusy(true);
    setWriteError(undefined);
    onConfirm(branch)
      .then((outcome) => {
        setConfirming(false);
        if (outcome._tag === "RefreshFailed") {
          setUnrefreshedBranch(outcome.branch);
          return;
        }
        setSelected(undefined);
        onOpenChange(false);
      })
      .catch((cause: unknown) => {
        setConfirming(false);
        setWriteError(contextualMessage(cause, BASE_BRANCH_MESSAGES));
      })
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change base branch</DialogTitle>
          <DialogDescription>
            A new base can change this pull request&apos;s commits, files,
            checks, and merge conflicts.
          </DialogDescription>
        </DialogHeader>
        {unrefreshedBranch === undefined ? (
          <div className="flex min-w-0 flex-col gap-2">
            <BranchCombobox
              query={query}
              onQueryChange={onQueryChange}
              branches={ready?.branches ?? []}
              current={current}
              selected={selected}
              onSelect={setSelected}
              disabled={busy}
            />
            <ReadNotice readState={readState} />
            {denied ? (
              <Alert variant="destructive">
                <AlertDescription>
                  No write access to {repository}.
                </AlertDescription>
              </Alert>
            ) : null}
            {ready?.permission === "unknown" ? (
              <Alert variant="warning">
                <AlertDescription>
                  {WRITE_PERMISSION_UNCONFIRMED}
                </AlertDescription>
              </Alert>
            ) : null}
            {writeError === undefined ? null : (
              <InlineError className="text-xs">{writeError}</InlineError>
            )}
          </div>
        ) : (
          <Alert variant="warning">
            <AlertTitle>Base changed to {unrefreshedBranch}</AlertTitle>
            <AlertDescription>
              GitHub accepted the change, but this Review could not be refreshed
              and still shows the previous base. Refresh to rebuild it.
            </AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>
            {unrefreshedBranch === undefined ? "Cancel" : "Close"}
          </DialogClose>
          {unrefreshedBranch === undefined ? (
            <Button disabled={!canConfirm} onClick={() => setConfirming(true)}>
              Change base branch
            </Button>
          ) : (
            <Button
              onClick={() => {
                void onRefresh().then(() => changeOpen(false));
              }}
            >
              Refresh
            </Button>
          )}
        </DialogFooter>
        <AlertDialog
          open={confirming}
          onOpenChange={(next) => {
            if (!busy) setConfirming(next);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Change the base to {selected}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Retargets {current ?? "its current base"} &rarr; {selected}.
                Existing Insights are marked outdated.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy || selected === undefined}
                onClick={() => {
                  if (selected !== undefined) confirm(selected);
                }}
              >
                {busy ? <Spinner data-icon="inline-start" /> : null}
                Change base
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

/** Server-filtered branch list; the current base is shown but cannot be picked. */
function BranchCombobox({
  query,
  onQueryChange,
  branches,
  current,
  selected,
  onSelect,
  disabled,
}: {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly branches: ReadonlyArray<string>;
  readonly current: string | undefined;
  readonly selected: string | undefined;
  readonly onSelect: (branch: string | undefined) => void;
  readonly disabled: boolean;
}): React.JSX.Element {
  return (
    <Combobox.Root
      inline
      open
      items={branches}
      value={selected ?? null}
      onValueChange={(next: string | null) => onSelect(next ?? undefined)}
      inputValue={query}
      onInputValueChange={(next, details) => {
        // Picking a row must not rewrite the search that produced the list.
        if (
          details.reason === "input-change" ||
          details.reason === "input-clear"
        )
          onQueryChange(next);
      }}
      filter={null}
      disabled={disabled}
    >
      <Combobox.Input
        aria-label="Search branches"
        placeholder="Search branches"
        className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      />
      <Combobox.List className="max-h-60 overflow-y-auto overscroll-contain rounded-lg border p-1 outline-none empty:hidden">
        {(branch: string) => (
          <Combobox.Item
            key={branch}
            value={branch}
            disabled={branch === current}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-disabled:opacity-60 data-highlighted:bg-accent data-highlighted:text-accent-foreground"
          >
            <Combobox.ItemIndicator className="flex size-4 shrink-0 items-center justify-center">
              <Check className="size-4" aria-hidden="true" />
            </Combobox.ItemIndicator>
            <span className="min-w-0 truncate">{branch}</span>
            {branch === current ? (
              <Badge variant="secondary" className="ml-auto">
                Current
              </Badge>
            ) : null}
          </Combobox.Item>
        )}
      </Combobox.List>
    </Combobox.Root>
  );
}

function ReadNotice({
  readState,
}: {
  readonly readState: BaseBranchReadState;
}): React.JSX.Element | null {
  switch (readState._tag) {
    case "loading":
      return (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner />
          Loading branches…
        </p>
      );
    case "ready":
      if (readState.branches.length === 0)
        return (
          <p className="text-xs text-muted-foreground">No branches match.</p>
        );
      return readState.totalCount > readState.branches.length ? (
        <p className="text-xs text-muted-foreground">
          Showing {readState.branches.length} of {readState.totalCount}{" "}
          branches. Search to narrow the list.
        </p>
      ) : null;
    case "github_auth":
      return (
        <InlineError className="text-xs">{signInCopy("branches")}</InlineError>
      );
    case "github_read":
      return (
        <InlineError className="text-xs">
          Patchdesk could not load this repository&apos;s branches. Reopen this
          dialog to retry.
        </InlineError>
      );
    case "github_rate_limited":
      return (
        <InlineError className="text-xs">
          {rateLimitedCopy(readState.resumeAt)}
        </InlineError>
      );
    case "github_forbidden":
      return (
        <InlineError className="text-xs">
          {forbiddenCopy(readState.reason)}
        </InlineError>
      );
  }
}
