import { useState } from "react";

import { useEnvironmentCheck } from "../hooks/use-api-probe";
import type { GithubAuthAccount } from "../renderer-contracts";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Field, FieldError, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { createWorkspaceProfile } from "./settings-workspace-create-profile";
import { AccountSelect, accountKey } from "./settings-workspace-reviewing-as";
import { scalarError } from "./settings-workspace-profile-values";

const EMPTY_ACCOUNTS: ReadonlyArray<GithubAuthAccount> = [];
const EMPTY_PATHS: ReadonlyArray<string> = [];

/**
 * Creates one workspace from a name and an account. The id is derived by the
 * service (`POST /v1/profiles` without an `id`), so nothing here asks the user
 * to invent one. Mounted only while open, so cancelling unmounts it and no
 * draft survives.
 */
export function CreateWorkspaceDialog({
  onOpenChange,
  onCreated,
}: {
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: () => Promise<void>;
}): React.JSX.Element {
  const probe = useEnvironmentCheck(0);
  const checking = probe.kind === "checking";
  const accounts =
    probe.kind === "loaded" ? probe.value.githubAccounts : EMPTY_ACCOUNTS;
  const [name, setName] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [manualAccount, setManualAccount] = useState("");
  const [manualHost, setManualHost] = useState("github.com");
  const [errors, setErrors] = useState<CreateWorkspaceFieldErrors>({});
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  // The account `gh` marks active is the offered default, derived rather than
  // set by an effect that would then have to avoid fighting a later choice.
  const chosen =
    accounts.find((account) => accountKey(account) === selectedKey) ??
    accounts.find((account) => account.active) ??
    accounts[0];

  const create = async (): Promise<void> => {
    const label = name.trim();
    const account =
      chosen === undefined
        ? { login: manualAccount.trim(), host: manualHost.trim() }
        : { login: chosen.login, host: chosen.host };
    const found = validateCreateWorkspace(label, account);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setError(undefined);
    setPending(true);
    try {
      await createWorkspaceProfile({
        id: "",
        label,
        githubHost: account.host,
        ghAccount: account.login,
        workspaceRoots: EMPTY_PATHS,
        rulePaths: EMPTY_PATHS,
      });
      await onCreated();
      onOpenChange(false);
    } catch (cause: unknown) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Patchdesk could not create the workspace.",
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
      <DialogContent
        data-testid="create-workspace-dialog"
        showCloseButton={!pending}
      >
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>
            A workspace is one GitHub account and the folders Patchdesk scans
            for it.
          </DialogDescription>
        </DialogHeader>
        {error === undefined ? null : (
          <Alert variant="destructive">
            <AlertTitle>Workspace not created</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-4">
          <CreateWorkspaceField
            id="create-workspace-name"
            label="Name"
            value={name}
            error={errors.name}
            onChange={setName}
          />
          {checking ? (
            // The probe decides which account control this dialog shows, so
            // it says it is still asking rather than rendering the manual
            // fields and swapping them for the Select a moment later.
            <p className="text-sm text-muted-foreground" role="status">
              Checking GitHub authentication…
            </p>
          ) : chosen === undefined ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <CreateWorkspaceField
                id="create-workspace-gh-account"
                label="GitHub account"
                value={manualAccount}
                error={errors.ghAccount}
                onChange={setManualAccount}
              />
              <CreateWorkspaceField
                id="create-workspace-github-host"
                label="GitHub host"
                value={manualHost}
                error={errors.githubHost}
                onChange={setManualHost}
              />
            </div>
          ) : (
            <AccountSelect
              id="create-workspace-account"
              name="Account"
              accounts={accounts}
              selectedKey={accountKey(chosen)}
              onSelect={(account) => setSelectedKey(accountKey(account))}
            />
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={pending || checking}
            onClick={() => {
              void create();
            }}
          >
            {pending ? "Creating workspace…" : "Create workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type CreateWorkspaceFieldErrors = Readonly<
  Partial<Record<"name" | "ghAccount" | "githubHost", string>>
>;

// The same client-side reasons the Workspace editor reports beside its own
// account, host, and name fields.
function validateCreateWorkspace(
  label: string,
  account: { readonly login: string; readonly host: string },
) {
  const found: {
    -readonly [Name in keyof CreateWorkspaceFieldErrors]?: string;
  } = {};
  const name = scalarError("label", label);
  if (name !== undefined) found.name = name;
  const ghAccount = scalarError("ghAccount", account.login);
  if (ghAccount !== undefined) found.ghAccount = ghAccount;
  const githubHost = scalarError("githubHost", account.host);
  if (githubHost !== undefined) found.githubHost = githubHost;
  return found;
}

function CreateWorkspaceField({
  id,
  label,
  value,
  error,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly error: string | undefined;
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  const invalid = error === undefined ? undefined : true;
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        aria-label={label}
        value={value}
        aria-invalid={invalid}
        aria-describedby={error === undefined ? undefined : `${id}-error`}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </Field>
  );
}
