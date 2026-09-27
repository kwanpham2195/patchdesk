import { useState } from "react";
import { FolderGit2 } from "lucide-react";

import type { LocalReviewSourceInput } from "../flows/use-inbox-review-opening";
import { useApiProbe, type ApiProbeState } from "../hooks/use-api-probe";
import {
  inferredBaseReason,
  parseLocalBranches,
  sharedReviewSource,
  type LocalBranches,
} from "../local-branches";
import { parseLocalCheckouts, type LocalCheckout } from "../local-checkouts";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Field, FieldDescription, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

type SourceKind = "local_branch" | "commit";

/**
 * The Pull requests screen's entry to a local Review (ADR 0050): a button for
 * the Selected repository that opens a picker for the shared Review of the
 * checked-out branch against a base branch (#555), or one commit. Shown only
 * for a repository with a local checkout.
 */
export function OpenLocalReviewAction({
  repositoryLabel,
  checkoutsPath,
  branchesPath,
  onOpen,
}: {
  readonly repositoryLabel: string;
  /** Where the repository's checkouts are listed; a shared Review can be read from any of them (#489). */
  readonly checkoutsPath: string;
  /** Where a checkout's branches and inferred base are listed; `undefined` names the configured checkout. */
  readonly branchesPath: (checkout: string | undefined) => string;
  /** Rejects with the sentence to show; resolves once the Review is open. */
  readonly onOpen: (source: LocalReviewSourceInput) => Promise<void>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <FolderGit2 data-icon="inline-start" /> Local review
      </Button>
      {open ? (
        <LocalReviewSourceDialog
          repositoryLabel={repositoryLabel}
          checkoutsPath={checkoutsPath}
          branchesPath={branchesPath}
          onOpen={onOpen}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}

/**
 * Mounted only while open, so cancelling drops the draft. The sidebar mounts
 * it too, for a checkout whose branch has no shared Review or several (#555).
 */
export function LocalReviewSourceDialog({
  repositoryLabel,
  checkoutsPath,
  branchesPath,
  initialCheckout,
  onOpen,
  onOpenChange,
}: {
  readonly repositoryLabel: string;
  readonly checkoutsPath: string;
  readonly branchesPath: (checkout: string | undefined) => string;
  /** The linked worktree to start on; absent starts on the configured checkout. */
  readonly initialCheckout?: string;
  readonly onOpen: (source: LocalReviewSourceInput) => Promise<void>;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const [kind, setKind] = useState<SourceKind>("local_branch");
  const [commit, setCommit] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const checkouts = useApiProbe(
    { path: checkoutsPath, restartKey: checkoutsPath },
    parseLocalCheckouts,
  );
  // Undefined reads the configured checkout; a listing that failed offers only that one.
  const [checkout, setCheckout] = useState(initialCheckout);
  const listedCheckouts =
    checkouts.kind === "loaded" ? checkouts.value : ([] as const);
  const path = branchesPath(checkout);
  const branches = useApiProbe({ path, restartKey: path }, parseLocalBranches);
  // Undefined takes the inferred base; the maintainer's pick replaces it.
  const [pickedBase, setPickedBase] = useState<string>();
  const listing = branches.kind === "loaded" ? branches.value : undefined;
  const baseBranch = pickedBase ?? listing?.inferred?.baseBranch;
  const source =
    kind === "commit"
      ? commitInput(commit)
      : listing === undefined || baseBranch === undefined
        ? undefined
        : sharedReviewSource(baseBranch, listing.head, checkout);

  const submit = async (): Promise<void> => {
    if (source === undefined) return;
    setError(undefined);
    setPending(true);
    try {
      await onOpen(source);
      onOpenChange(false);
    } catch (cause: unknown) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Patchdesk could not read the local checkout.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!pending) onOpenChange(nextOpen);
      }}
    >
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Open a local review</DialogTitle>
          <DialogDescription>{repositoryLabel}</DialogDescription>
        </DialogHeader>
        {error === undefined ? null : (
          <Alert variant="destructive">
            <AlertTitle>Review not opened</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Tabs
            value={kind}
            onValueChange={(value) => {
              // SAFETY: every TabsTrigger below is keyed by a SourceKind literal.
              setKind(value as SourceKind);
            }}
          >
            <TabsList aria-label="Review source">
              <TabsTrigger value="local_branch">Shared</TabsTrigger>
              <TabsTrigger value="commit">Commit</TabsTrigger>
            </TabsList>
          </Tabs>
          {kind === "local_branch" ? (
            <>
              {listedCheckouts.length > 1 ? (
                <CheckoutSelect
                  checkouts={listedCheckouts}
                  value={checkout}
                  onChange={(next) => {
                    setCheckout(next);
                    setPickedBase(undefined);
                  }}
                />
              ) : null}
              <SharedReviewBase
                branches={branches}
                baseBranch={baseBranch}
                onChange={setPickedBase}
              />
            </>
          ) : (
            <SourceField
              id="local-review-commit"
              label="Commit SHA"
              value={commit}
              onChange={setCommit}
            />
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || source === undefined}>
              {pending ? "Opening…" : "Open review"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function commitInput(value: string): LocalReviewSourceInput | undefined {
  const commit = value.trim().toLowerCase();
  return /^[0-9a-f]{4,64}$/.test(commit)
    ? { kind: "commit", commit }
    : undefined;
}

/**
 * The shared Review's base: the checkout's other local branches with the
 * inferred one preselected and its reason beside it, and the bases this
 * branch already has an open Review against.
 */
function SharedReviewBase({
  branches,
  baseBranch,
  onChange,
}: {
  readonly branches: ApiProbeState<LocalBranches>;
  readonly baseBranch: string | undefined;
  readonly onChange: (baseBranch: string) => void;
}): React.JSX.Element {
  if (branches.kind === "checking")
    return (
      <p className="text-sm text-muted-foreground">Reading the branches…</p>
    );
  if (branches.kind === "error")
    return (
      <p className="text-sm text-muted-foreground">
        Patchdesk could not read the checkout&apos;s branches.
      </p>
    );
  const { head, branches: bases, inferred, reviewedBases } = branches.value;
  const branch = head.kind === "branch" ? head.branch : "detached HEAD";
  if (bases.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        {branch} is the only local branch, so there is no base to compare it
        with. Create the base branch, or open one commit.
      </p>
    );
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Every change on {branch} since it left the base branch, committed or
        not: commits, staged, unstaged, and untracked files.
      </p>
      <Field>
        <FieldLabel htmlFor="local-review-base-branch">Base branch</FieldLabel>
        <Select
          value={baseBranch ?? null}
          items={bases.map((base) => ({ label: base, value: base }))}
          onValueChange={(base) => {
            if (base !== null) onChange(base);
          }}
        >
          <SelectTrigger id="local-review-base-branch" aria-label="Base branch">
            <SelectValue placeholder="Pick a base branch" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {bases.map((base) => (
                <SelectItem key={base} value={base}>
                  {base}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {inferred !== undefined && baseBranch === inferred.baseBranch ? (
          <FieldDescription>{inferredBaseReason(inferred)}</FieldDescription>
        ) : null}
      </Field>
      {reviewedBases.length === 0 ? null : (
        <p className="text-sm text-muted-foreground">
          {branch} has open reviews against {reviewedBases.join(", ")}.
        </p>
      )}
    </>
  );
}

/** Picks the checkout the shared Review is read from; the configured one is the default and sends no path. */
function CheckoutSelect({
  checkouts,
  value,
  onChange,
}: {
  readonly checkouts: ReadonlyArray<LocalCheckout>;
  readonly value: string | undefined;
  readonly onChange: (checkout: string | undefined) => void;
}): React.JSX.Element {
  const selected =
    value ?? checkouts.find((candidate) => candidate.configured)?.path ?? null;
  return (
    <Field>
      <FieldLabel htmlFor="local-review-checkout">Checkout</FieldLabel>
      <Select
        value={selected}
        items={checkouts.map((candidate) => ({
          label: checkoutName(candidate),
          value: candidate.path,
        }))}
        onValueChange={(path) => {
          const chosen = checkouts.find((candidate) => candidate.path === path);
          if (chosen !== undefined)
            onChange(chosen.configured ? undefined : chosen.path);
        }}
      >
        <SelectTrigger id="local-review-checkout" aria-label="Checkout">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {checkouts.map((candidate) => (
              <SelectItem key={candidate.path} value={candidate.path}>
                {checkoutName(candidate)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

function checkoutName(checkout: LocalCheckout): string {
  return `${checkout.name} · ${checkout.head.kind === "branch" ? checkout.head.branch : "detached HEAD"}`;
}

function SourceField({
  id,
  label,
  value,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
