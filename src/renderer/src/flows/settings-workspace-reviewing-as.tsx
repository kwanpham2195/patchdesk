import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type {
  EnvironmentCheckResponse,
  GithubAuthAccount,
} from "../renderer-contracts";
import {
  useEnvironmentCheck,
  type ApiProbeState,
} from "../hooks/use-api-probe";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { Button } from "../components/ui/button";
import { Field, FieldGroup, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useLatestCommitted } from "../hooks/use-latest-committed";
import { FieldSaveStatus } from "./settings-workspace-field-status";
import type { FieldStatus } from "./settings-workspace-profile-editor";

/** The account half of the Workspace editor, as this panel's controls need it. */
export type AccountEditor = {
  readonly ghAccount: string;
  readonly githubHost: string;
  readonly accountStatus: FieldStatus;
  readonly hostStatus: FieldStatus;
  /** Local typing; nothing is sent until the field commits. */
  readonly onEdit: (field: AccountField, value: string) => void;
  /** Commits one manual field — on blur and on Enter. */
  readonly onCommit: (field: AccountField) => void;
  /** Commits the account and its host together, from the Select. */
  readonly onSelectAccount: (login: string, host: string) => void;
};

type AccountField = "ghAccount" | "githubHost";

export type ReviewingAsProbeHook = {
  readonly reviewingAs: ApiProbeState<EnvironmentCheckResponse>;
  readonly recheck: () => void;
};

/**
 * Owns the Reviewing-as `GET /v1/environment` probe and the one-time account
 * adoption that follows it. Extracted out of `WorkspaceProfileSection` purely
 * to keep that component's own body short — it isn't reused anywhere else.
 */
// oxlint-disable-next-line react/only-export-components -- The Reviewing-as probe hook shares this module with the panel that consumes it.
export function useReviewingAsProbe(
  ghAccount: string,
  onAdopt: (login: string, host: string) => void,
): ReviewingAsProbeHook {
  const [reviewingAsAttempt, setReviewingAsAttempt] = useState(0);
  const reviewingAsDefaultApplied = useRef(false);
  const reviewingAs = useEnvironmentCheck(reviewingAsAttempt);
  const onAdoptRef = useLatestCommitted(onAdopt);

  // Defaults the account selection the first time authenticated accounts
  // load, but only when the profile has no account yet — a one-time
  // derivation, guarded so it never overwrites a value the user typed or a
  // loaded profile already carried. With exactly one authenticated account,
  // that account is the adoption target; with several, it's the one `gh`
  // marks `active`. The adoption saves like any other account choice: there
  // is no Save button left that could persist it afterwards.
  useEffect(() => {
    if (reviewingAsDefaultApplied.current) return;
    if (reviewingAs.kind !== "loaded") return;
    const accounts = reviewingAs.value.githubAccounts;
    if (accounts.length === 0) return;
    reviewingAsDefaultApplied.current = true;
    if (ghAccount !== "") return;
    let target: GithubAuthAccount | undefined;
    if (accounts.length === 1) {
      const [account] = accounts;
      target = account;
    } else {
      target = accounts.find((account) => account.active);
    }
    if (target === undefined) return;
    onAdoptRef.current(target.login, target.host);
  }, [reviewingAs, ghAccount, onAdoptRef]);

  return {
    reviewingAs,
    recheck: () => setReviewingAsAttempt((value) => value + 1),
  };
}

/** One resolved shape the Reviewing-as panel renders, derived from the raw fetch state plus what `gh` reported. */
type ReviewingAsView =
  | { readonly kind: "checking" }
  | { readonly kind: "error" }
  | { readonly kind: "failed"; readonly env: EnvironmentCheckResponse }
  | { readonly kind: "single"; readonly account: GithubAuthAccount }
  | {
      readonly kind: "multiple";
      readonly accounts: ReadonlyArray<GithubAuthAccount>;
    };

function reviewingAsView(
  state: ApiProbeState<EnvironmentCheckResponse>,
): ReviewingAsView {
  if (state.kind !== "loaded") return { kind: state.kind };
  const env = state.value;
  const accounts = env.githubAccounts;
  if (
    accounts.length === 0 ||
    env.githubAuth === "authentication_required" ||
    env.githubAuth === "unavailable"
  )
    return { kind: "failed", env };
  if (accounts.length === 1) {
    const [account] = accounts;
    if (account !== undefined) return { kind: "single", account };
  }
  return { kind: "multiple", accounts };
}

function accountKey(account: GithubAuthAccount): string {
  return `${account.host}/${account.login}`;
}

/**
 * True when the profile's configured account is set but `gh` doesn't report
 * it among the authenticated accounts — the profile would fail every GitHub
 * read at review time (see `GitHubCliCredentials.environmentFor`), and this
 * panel needs to say so instead of silently showing a placeholder or a
 * misleading "Reviewing as" statement.
 */
function isConfiguredAccountUnauthenticated(
  accounts: ReadonlyArray<GithubAuthAccount>,
  account: AccountEditor,
): boolean {
  if (account.ghAccount === "") return false;
  return !accounts.some(
    (candidate) =>
      candidate.login === account.ghAccount &&
      candidate.host === account.githubHost,
  );
}

/**
 * Replaces the free-text `GitHub account` field with a resolved fact: the
 * account(s) `gh auth status` actually reports as authenticated, so the
 * offered values are exactly the values that authenticate (see the
 * "Reviewing as" design in the workspace-settings guided-setup spec). Manual
 * entry — the enterprise-host escape hatch — stays available behind a
 * disclosure in the two authenticated states, and directly (unblocked, not
 * gated) whenever the probe itself is still loading or failed to parse.
 */
export function ReviewingAsPanel({
  state,
  account,
  onRecheck,
}: {
  readonly state: ApiProbeState<EnvironmentCheckResponse>;
  readonly account: AccountEditor;
  readonly onRecheck: () => void;
}): React.JSX.Element {
  const view = reviewingAsView(state);
  const configuredAccounts: ReadonlyArray<GithubAuthAccount> =
    view.kind === "single"
      ? [view.account]
      : view.kind === "multiple"
        ? view.accounts
        : [];
  const configuredAccountUnauthenticated =
    (view.kind === "single" || view.kind === "multiple") &&
    isConfiguredAccountUnauthenticated(configuredAccounts, account);
  return (
    <div className="flex flex-col gap-4">
      {view.kind === "checking" ? (
        <p className="text-sm text-muted-foreground">
          Checking GitHub authentication…
        </p>
      ) : view.kind === "error" ? (
        <Alert variant="destructive">
          <AlertTitle>GitHub authentication unavailable</AlertTitle>
          <AlertDescription>
            Could not check GitHub authentication.
          </AlertDescription>
        </Alert>
      ) : view.kind === "failed" ? (
        <Alert variant="destructive">
          <AlertTitle>GitHub authentication required</AlertTitle>
          <AlertDescription>
            {view.env.gh !== "ready" ? (
              "GitHub CLI (gh) is not installed. Install the GitHub CLI, then re-check."
            ) : (
              <>
                Not authenticated. Run <code>gh auth login</code>, then
                re-check.
              </>
            )}
          </AlertDescription>
        </Alert>
      ) : view.kind === "single" ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            Reviewing as <strong>{view.account.login}</strong> on{" "}
            <em>{view.account.host}</em>, from the GitHub CLI.
          </p>
          {/* Adopting this account saves the workspace like any other choice,
              so the statement carries the same status the Select does. A
              failure is left to the manual fields, which the disclosure below
              reveals with the rejected value and this same message. */}
          {account.accountStatus.state === "failed" ? null : (
            <FieldSaveStatus status={account.accountStatus} />
          )}
          <AccountDisclosure account={account} />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <AccountSelect accounts={view.accounts} account={account} />
          <AccountDisclosure account={account} />
        </div>
      )}
      {configuredAccountUnauthenticated ? (
        <Alert variant="destructive">
          <AlertTitle>Configured account not authenticated</AlertTitle>
          <AlertDescription>
            This workspace is set to review as{" "}
            <strong>{account.ghAccount}</strong> on{" "}
            <em>{account.githubHost}</em>, but the GitHub CLI does not report
            that account as authenticated. Choose one of the authenticated
            accounts above, or authenticate that account and re-check.
          </AlertDescription>
        </Alert>
      ) : null}
      {view.kind === "checking" ||
      view.kind === "error" ||
      view.kind === "failed" ? (
        <ManualAccountFields account={account} />
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={onRecheck}
      >
        Re-check
      </Button>
    </div>
  );
}

function AccountSelect({
  accounts,
  account,
}: {
  readonly accounts: ReadonlyArray<GithubAuthAccount>;
  readonly account: AccountEditor;
}): React.JSX.Element {
  const selected = accounts.find(
    (candidate) =>
      candidate.login === account.ghAccount &&
      candidate.host === account.githubHost,
  );
  return (
    <Field>
      <FieldLabel htmlFor="reviewing-as-account">Account</FieldLabel>
      <Select
        value={selected === undefined ? null : accountKey(selected)}
        items={accounts.map((candidate) => ({
          label: `${candidate.login} · ${candidate.host}`,
          value: accountKey(candidate),
        }))}
        onValueChange={(value) => {
          const chosen = accounts.find(
            (candidate) => accountKey(candidate) === value,
          );
          if (chosen === undefined) return;
          account.onSelectAccount(chosen.login, chosen.host);
        }}
      >
        <SelectTrigger
          id="reviewing-as-account"
          aria-label="Reviewing as account"
        >
          <SelectValue placeholder="Select an account" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {accounts.map((candidate) => (
              <SelectItem
                key={accountKey(candidate)}
                value={accountKey(candidate)}
              >
                {`${candidate.login} · ${candidate.host}`}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldSaveStatus status={account.accountStatus} />
    </Field>
  );
}

function AccountDisclosure({
  account,
}: {
  readonly account: AccountEditor;
}): React.JSX.Element {
  // A rejected manual value stays on screen with its reason, so the
  // disclosure cannot hide the field the user still has to fix.
  if (
    account.accountStatus.state === "failed" ||
    account.hostStatus.state === "failed"
  )
    return <ManualAccountFields account={account} />;
  return (
    <Collapsible>
      <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>
        Use a different account
        <ChevronDown data-icon="inline-end" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent motion="disclosure" className="pt-3">
        <ManualAccountFields account={account} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function ManualAccountFields({
  account,
}: {
  readonly account: AccountEditor;
}): React.JSX.Element {
  return (
    <FieldGroup className="grid gap-4 sm:grid-cols-2">
      <ManualAccountField
        id="profile-gh-account"
        label="GitHub account"
        field="ghAccount"
        value={account.ghAccount}
        status={account.accountStatus}
        account={account}
      />
      <ManualAccountField
        id="profile-github-host"
        label="GitHub host"
        field="githubHost"
        value={account.githubHost}
        status={account.hostStatus}
        account={account}
      />
    </FieldGroup>
  );
}

function ManualAccountField({
  id,
  label,
  field,
  value,
  status,
  account,
}: {
  readonly id: string;
  readonly label: string;
  readonly field: AccountField;
  readonly value: string;
  readonly status: FieldStatus;
  readonly account: AccountEditor;
}): React.JSX.Element {
  const failed = status.state === "failed";
  return (
    <Field data-invalid={failed ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        aria-label={label}
        value={value}
        aria-invalid={failed ? true : undefined}
        aria-describedby={failed ? `${id}-status` : undefined}
        onChange={(event) => account.onEdit(field, event.target.value)}
        onBlur={() => account.onCommit(field)}
        onKeyDown={(event) => {
          if (event.key === "Enter") account.onCommit(field);
        }}
      />
      <div id={`${id}-status`}>
        <FieldSaveStatus status={status} />
      </div>
    </Field>
  );
}
