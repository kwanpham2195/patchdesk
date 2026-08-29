import { useEffect, useRef, useState, type SetStateAction } from "react";
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
import type { ProfileDraft } from "./settings-workspace-profile-draft";

type ReviewingAsProbeHook = {
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
  updateProfileDraft: (update: SetStateAction<ProfileDraft>) => void,
): ReviewingAsProbeHook {
  const [reviewingAsAttempt, setReviewingAsAttempt] = useState(0);
  const reviewingAsDefaultApplied = useRef(false);
  const reviewingAs = useEnvironmentCheck(reviewingAsAttempt);

  // Defaults the account selection the first time authenticated accounts
  // load, but only when the draft has no account yet — a one-time
  // derivation, guarded so it never overwrites a value the user typed or a
  // loaded profile already carried. With exactly one authenticated account,
  // that account is the adoption target; with several, it's the one `gh`
  // marks `active`.
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
    updateProfileDraft((current) => ({
      ...current,
      ghAccount: target.login,
      githubHost: target.host,
    }));
    // `updateProfileDraft` is a `useCallback` in `useWorkspaceProfileDraft`,
    // so listing it here doesn't make this effect re-run on every render;
    // the `reviewingAsDefaultApplied` ref guard above additionally makes the
    // body a no-op after its first application regardless.
  }, [reviewingAs, ghAccount, updateProfileDraft]);

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
  profileDraft: ProfileDraft,
): boolean {
  if (profileDraft.ghAccount === "") return false;
  return !accounts.some(
    (account) =>
      account.login === profileDraft.ghAccount &&
      account.host === profileDraft.githubHost,
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
  profileDraft,
  updateProfileDraft,
  onRecheck,
}: {
  readonly state: ApiProbeState<EnvironmentCheckResponse>;
  readonly profileDraft: ProfileDraft;
  readonly updateProfileDraft: (update: SetStateAction<ProfileDraft>) => void;
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
    isConfiguredAccountUnauthenticated(configuredAccounts, profileDraft);
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
          <AccountDisclosure
            profileDraft={profileDraft}
            updateProfileDraft={updateProfileDraft}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <AccountSelect
            accounts={view.accounts}
            profileDraft={profileDraft}
            updateProfileDraft={updateProfileDraft}
          />
          <AccountDisclosure
            profileDraft={profileDraft}
            updateProfileDraft={updateProfileDraft}
          />
        </div>
      )}
      {configuredAccountUnauthenticated ? (
        <Alert variant="destructive">
          <AlertTitle>Configured account not authenticated</AlertTitle>
          <AlertDescription>
            This profile is set to review as{" "}
            <strong>{profileDraft.ghAccount}</strong> on{" "}
            <em>{profileDraft.githubHost}</em>, but the GitHub CLI does not
            report that account as authenticated. Choose one of the
            authenticated accounts above, or authenticate that account and
            re-check.
          </AlertDescription>
        </Alert>
      ) : null}
      {view.kind === "checking" || view.kind === "error" ? (
        <ManualAccountFields
          profileDraft={profileDraft}
          updateProfileDraft={updateProfileDraft}
        />
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
  profileDraft,
  updateProfileDraft,
}: {
  readonly accounts: ReadonlyArray<GithubAuthAccount>;
  readonly profileDraft: ProfileDraft;
  readonly updateProfileDraft: (update: SetStateAction<ProfileDraft>) => void;
}): React.JSX.Element {
  const selected = accounts.find(
    (account) =>
      account.login === profileDraft.ghAccount &&
      account.host === profileDraft.githubHost,
  );
  return (
    <Field>
      <FieldLabel htmlFor="reviewing-as-account">Account</FieldLabel>
      <Select
        value={selected === undefined ? null : accountKey(selected)}
        items={accounts.map((account) => ({
          label: `${account.login} · ${account.host}`,
          value: accountKey(account),
        }))}
        onValueChange={(value) => {
          const chosen = accounts.find(
            (account) => accountKey(account) === value,
          );
          if (chosen === undefined) return;
          updateProfileDraft((current) => ({
            ...current,
            ghAccount: chosen.login,
            githubHost: chosen.host,
          }));
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
            {accounts.map((account) => (
              <SelectItem key={accountKey(account)} value={accountKey(account)}>
                {`${account.login} · ${account.host}`}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

function AccountDisclosure({
  profileDraft,
  updateProfileDraft,
}: {
  readonly profileDraft: ProfileDraft;
  readonly updateProfileDraft: (update: SetStateAction<ProfileDraft>) => void;
}): React.JSX.Element {
  return (
    <Collapsible>
      <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>
        Use a different account
        <ChevronDown data-icon="inline-end" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent motion="disclosure" className="pt-3">
        <ManualAccountFields
          profileDraft={profileDraft}
          updateProfileDraft={updateProfileDraft}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

function ManualAccountFields({
  profileDraft,
  updateProfileDraft,
}: {
  readonly profileDraft: ProfileDraft;
  readonly updateProfileDraft: (update: SetStateAction<ProfileDraft>) => void;
}): React.JSX.Element {
  return (
    <FieldGroup className="grid gap-4 sm:grid-cols-2">
      <Field>
        <FieldLabel htmlFor="profile-gh-account">GitHub account</FieldLabel>
        <Input
          id="profile-gh-account"
          aria-label="GitHub account"
          value={profileDraft.ghAccount}
          onChange={(event) =>
            updateProfileDraft((current) => ({
              ...current,
              ghAccount: event.target.value,
            }))
          }
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="profile-github-host">GitHub host</FieldLabel>
        <Input
          id="profile-github-host"
          aria-label="GitHub host"
          value={profileDraft.githubHost}
          onChange={(event) =>
            updateProfileDraft((current) => ({
              ...current,
              githubHost: event.target.value,
            }))
          }
        />
      </Field>
    </FieldGroup>
  );
}
