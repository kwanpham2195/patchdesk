import * as v from "valibot";

import { type CommandRunner } from "./command-runner";

/**
 * A GitHub CLI account this machine can authenticate as, as reported by
 * `gh auth status --json hosts`. Deliberately excludes `scopes` and
 * `tokenSource` — the raw gh entry carries a token's scope list and either
 * `"keyring"` or a real filesystem path in the latter, and AGENTS.md forbids
 * availability descriptions from carrying credential values or paths. Both
 * are dropped here, at the adapter boundary, so they never exist in the
 * object that flows toward the renderer. `state` is dropped too: this list
 * only ever contains entries this module already filtered to
 * `state === "success"`, so a per-entry `state` field would be redundant.
 */
export type GitHubAuthAccount = {
  readonly host: string;
  readonly login: string;
  readonly active: boolean;
};

/**
 * Loose on purpose (see `restErrorBodySchema` in `command-runner.ts` for the
 * same convention): validates only the fields this module reads from one
 * `gh auth status --json hosts` account entry. Being loose, it PRESERVES
 * unlisted keys such as `scopes` and `tokenSource` on the parsed value —
 * they are excluded from the exported account by building it field by field
 * below, never by spreading a parsed entry. Keep it that way: spreading
 * would leak a token's scope list and a credential file path.
 */
const authStatusAccountSchema = v.looseObject({
  login: v.string(),
  host: v.string(),
  active: v.boolean(),
  state: v.string(),
});

const authStatusOutputSchema = v.looseObject({
  hosts: v.record(v.string(), v.array(authStatusAccountSchema)),
});

/**
 * Lists the GitHub accounts `gh` reports as authenticated on this machine,
 * across every host it knows about. Runs main-process-only, through the
 * shared `CommandRunner` seam.
 *
 * Degrades to an empty list — never throws — for every failure mode: `gh`
 * missing, the probe timing out, a nonzero exit, or output that fails to
 * parse as JSON or does not match the expected shape. Callers that want to
 * distinguish "no accounts" from "gh unavailable" already have that signal
 * from the sibling `gh auth status` probe in the same route; this function
 * only answers "which accounts, if any, can I offer".
 *
 * `gh auth status --json hosts` exits zero even when some listed accounts
 * have auth problems, so exit code is not used as the authentication
 * signal — each entry's own `state` field is. Only entries with
 * `state === "success"` are included.
 */
export async function listAuthenticatedGitHubAccounts(
  commands: CommandRunner,
  timeoutMs: number,
): Promise<ReadonlyArray<GitHubAuthAccount>> {
  const result = await commands.runJson({
    argv: ["gh", "auth", "status", "--json", "hosts"],
    timeoutMs,
  });
  if (result._tag === "err") return [];

  const parsed = v.safeParse(authStatusOutputSchema, result.value);
  if (!parsed.success) return [];

  const accounts: Array<GitHubAuthAccount> = [];
  for (const entries of Object.values(parsed.output.hosts)) {
    for (const entry of entries) {
      if (entry.state !== "success") continue;
      accounts.push({
        host: entry.host,
        login: entry.login,
        active: entry.active,
      });
    }
  }
  return accounts;
}
