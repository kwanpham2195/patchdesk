import { useState } from "react";
import { FolderGit2 } from "lucide-react";

import type { LocalReviewSourceInput } from "../flows/use-inbox-review-opening";
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
  onOpen,
}: {
  readonly repositoryLabel: string;
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
  onOpen,
  onOpenChange,
}: {
  readonly repositoryLabel: string;
  readonly onOpen: (source: LocalReviewSourceInput) => Promise<void>;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const [kind, setKind] = useState<SourceKind>("working_tree");
  const [branch, setBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [commit, setCommit] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const source = sourceInput(kind, { branch, baseBranch, commit });

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
            <p className="text-sm text-muted-foreground">
              Staged, unstaged, and untracked changes against HEAD.
            </p>
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
  },
): LocalReviewSourceInput | undefined {
  const branch = fields.branch.trim();
  const baseBranch = fields.baseBranch.trim();
  const commit = fields.commit.trim().toLowerCase();
  switch (kind) {
    case "working_tree":
      return { kind };
    case "branch":
      return branch === "" || baseBranch === ""
        ? undefined
        : { kind, branch, baseBranch };
    case "commit":
      return /^[0-9a-f]{4,64}$/.test(commit) ? { kind, commit } : undefined;
  }
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
