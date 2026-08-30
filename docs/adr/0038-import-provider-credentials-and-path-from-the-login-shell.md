# Import provider credentials and PATH from the login shell

> **Status: Accepted.** Refines ADR 0016, which keeps Codex discovery on
> inherited PATH, and ADR 0018, which narrows what reaches an Insight child.
> Neither is reversed: this decision changes where the main process's own PATH
> and keys come from, not what the child receives.

macOS gives an app started from the Dock or Finder a minimal environment. It
has no `DEEPSEEK_API_KEY`, no `ANTHROPIC_API_KEY`, and a PATH of
`/usr/bin:/bin:/usr/sbin:/sbin`. A maintainer who exported a key in `~/.zshrc`
and then opened Patchdesk from the Dock saw an empty model list and was told to
run `launchctl setenv` or `open -a Patchdesk` from a terminal. Codex had the
same shape of problem for a different reason: it is discovered on PATH alone,
so a Homebrew or npm install at `/opt/homebrew/bin/codex` was invisible while
`gh`, which has hardcoded macOS fallback directories, kept working.

## The decision

On macOS, once at startup and before anything reads a key or a PATH, Patchdesk
runs the maintainer's login shell and adopts a narrow slice of what it prints
(`src/adapters/process/login-shell-environment.ts`). The command is
`$SHELL -ilc "env -0"`, falling back to `/bin/zsh` when the process has no
`SHELL`. `-i` is what loads `~/.zshrc`, where an export usually lives; `-l`
loads the login files; `env -0` separates records with NUL so a multi-line
value survives. Nothing is interpolated into that command, no shell string is
built from any value, stdin and stderr go nowhere, and the whole thing is given
three seconds.

**The allowlist.** Two things are imported and nothing else:

- Every environment name any built-in Pi provider reads —
  `providerCredentialEnvironmentNames()` in
  `src/adapters/pi/pi-provider-catalog.ts`, the union of each provider's keys,
  its required keys, and the ambient AWS and Google names Bedrock and Vertex
  use. That function is the one source of truth: it is the same table the child
  invoker filters per selected provider, so a provider added there becomes
  importable with no second list to update.
- `PATH`.

A name already set in `process.env` is never overwritten. A Patchdesk launched
from a terminal carries the maintainer's own values, and those win over
whatever a fresh login shell would print.

**The PATH rule.** PATH is replaced only when the login shell's PATH is a
strict superset of the current one: every current entry appears in it, and it
adds at least one entry of its own. Nothing is lost and something is gained, or
nothing happens. A Dock or Finder launch has the macOS GUI default, and a login
shell's PATH contains all four of those directories and adds
`/opt/homebrew/bin`, so it is replaced and `codex` becomes discoverable. Any
launch that put a directory of its own on PATH — a `pnpm dev` with
`node_modules/.bin`, a wrapper script, a `launchctl setenv` — keeps its PATH
untouched, and so does one that holds the same directories in a different
order. The rule is stated as a superset test rather than as "looks like the GUI
default" because a hardcoded default is a guess about a string Apple owns.

**Failure imports nothing.** A shell that cannot start, exits nonzero, prints
more than a megabyte, or does not answer within three seconds yields no
variables at all, and startup continues exactly as it did before. There is no
retry and no second strategy.

**Values never leave the main process.** The import returns names and a
PATH-changed flag, and that is what the one log line records — never a value.
Nothing about this reaches the renderer: the provider catalog still projects
`configured`, a source label, and guidance, and an Insight child still receives
only the selected provider's allowlisted names (ADR 0018). Widening the
allowlist widens the main process's environment, which is a security boundary,
so it is a decision and not a convenience.

**Codex stays PATH-only.** ADR 0016's rule is that Codex is found through
inherited PATH and nowhere else. That rule is kept; what changes is that the
inherited PATH is now the maintainer's real one. `discoverPathOnlyExecutable`
is untouched.

### Considered and rejected

- **A key field in Settings.** It would persist a provider key on disk under
  Patchdesk's ownership, which the app deliberately does not do — storage
  fails closed on sensitive values, and the README's "there is no key field in
  the app" is a promise, not an omission. The shell profile is already where
  the maintainer keeps the key.
- **Hardcoded Homebrew fallback directories for `codex`,** the way `gh` has
  them. That would find a `codex` the maintainer's own shell does not resolve
  to, which is the opposite of ADR 0016's intent: Patchdesk runs the Codex the
  maintainer runs.
- **Importing the whole login environment.** Cheaper to write and much wider:
  every proxy setting, credential helper, and injected variable in the profile
  would land in the process that owns every GitHub write.

## Consequences

- `README.md` now says to export the key in the shell profile and restart
  Patchdesk. `launchctl setenv` stays as a one-line fallback for a shell whose
  startup files Patchdesk cannot read.
- Startup is up to three seconds slower in the worst case, and normally about
  the cost of one shell start. The wait sits inside `app.whenReady`, before the
  local API starts, because both the provider catalog and Codex discovery run
  after it.
- The decision is macOS-only, like the app. On another platform the import is
  skipped entirely rather than guessing at a shell.
- A maintainer who changes a key in `~/.zshrc` restarts Patchdesk to pick it
  up. Nothing re-reads the shell while the app runs.
- The merge is a pure function (`mergeLoginShellEnvironment`) with its own
  tests, and the shell run is tested through an injected spawn seam. No test
  starts a real shell.
