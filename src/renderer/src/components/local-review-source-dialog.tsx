import { useState } from "react";
import { FolderGit2 } from "lucide-react";

import type { LocalReviewSourceInput } from "../flows/use-inbox-review-opening";
import { useApiProbe } from "../hooks/use-api-probe";
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
import { Field, FieldLabel } from "./ui/field";
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

type SourceKind = LocalReviewSourceInput["kind"];

/**
 * The Pull requests screen's entry to a local Review (ADR 0050): a button for
 * the Selected repository that opens a picker for the working tree, a branch
 * against a base branch, or one commit. Shown only for a repository with a
 * local checkout.
 */
export function OpenLocalReviewAction({
  repositoryLabel,
  checkoutsPath,
  onOpen,
}: {
  readonly repositoryLabel: string;
  /** Where the repository's checkouts are listed; a working tree can be read from any of them (#489). */
  readonly checkoutsPath: string;
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
          onOpen={onOpen}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}

/** Mounted only while open, so cancelling drops the draft. */
function LocalReviewSourceDialog({
  repositoryLabel,
  checkoutsPath,
  onOpen,
  onOpenChange,
}: {
  readonly repositoryLabel: string;
  readonly checkoutsPath: string;
  readonly onOpen: (source: LocalReviewSourceInput) => Promise<void>;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const [kind, setKind] = useState<SourceKind>("working_tree");
  const [branch, setBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [commit, setCommit] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const checkouts = useApiProbe(
    { path: checkoutsPath, restartKey: checkoutsPath },
    parseLocalCheckouts,
  );
  // Undefined reads the configured checkout; a listing that failed offers only that one.
  const [checkout, setCheckout] = useState<string>();
  const listedCheckouts =
    checkouts.kind === "loaded" ? checkouts.value : ([] as const);
  const source = sourceInput(kind, { branch, baseBranch, commit, checkout });

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
              <TabsTrigger value="working_tree">Working tree</TabsTrigger>
              <TabsTrigger value="branch">Branch</TabsTrigger>
              <TabsTrigger value="commit">Commit</TabsTrigger>
            </TabsList>
          </Tabs>
          {kind === "working_tree" ? (
            <>
              {listedCheckouts.length > 1 ? (
                <CheckoutSelect
                  checkouts={listedCheckouts}
                  value={checkout}
                  onChange={setCheckout}
                />
              ) : null}
              <p className="text-sm text-muted-foreground">
                Staged, unstaged, and untracked changes against HEAD.
              </p>
            </>
          ) : kind === "branch" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <SourceField
                id="local-review-branch"
                label="Branch"
                value={branch}
                onChange={setBranch}
              />
              <SourceField
                id="local-review-base-branch"
                label="Base branch"
                value={baseBranch}
                onChange={setBaseBranch}
              />
            </div>
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

function sourceInput(
  kind: SourceKind,
  fields: {
    readonly branch: string;
    readonly baseBranch: string;
    readonly commit: string;
    readonly checkout: string | undefined;
  },
): LocalReviewSourceInput | undefined {
  const branch = fields.branch.trim();
  const baseBranch = fields.baseBranch.trim();
  const commit = fields.commit.trim().toLowerCase();
  switch (kind) {
    case "working_tree":
      return fields.checkout === undefined
        ? { kind }
        : { kind, checkout: fields.checkout };
    case "branch":
      return branch === "" || baseBranch === ""
        ? undefined
        : { kind, branch, baseBranch };
    case "commit":
      return /^[0-9a-f]{4,64}$/.test(commit) ? { kind, commit } : undefined;
  }
}

/** Picks the checkout the working tree is read from; the configured one is the default and sends no path. */
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
