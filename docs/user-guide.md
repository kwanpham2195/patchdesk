# Patchdesk user guide

This guide covers everything you do in Patchdesk: installing it, setting up
your workspace, reviewing pull requests, running Insights, and where the app
keeps its files.

## Requirements

- macOS on Apple Silicon (arm64). Patchdesk does not run on Intel Macs,
  Windows, or Linux.
- `git`.
- The GitHub CLI (`gh`), logged in:

  ```bash
  gh auth login
  ```

Patchdesk never stores a GitHub token. It runs `gh auth token` each time it
needs one.

The packaged app does not need a separate Node.js installation. Optional
Insights require an installed Codex CLI or Pi CLI and that CLI's own runtime
and login.

## Install

Install with the shell installer:

```bash
curl -fsSL https://raw.githubusercontent.com/kwanpham2195/patchdesk/main/scripts/install-release.sh | sh
```

You can [read the installer](../scripts/install-release.sh) before running it.
It checks the latest release ZIP against the release's SHA-256 digest, installs
Patchdesk in `/Applications`, and links `patchdesk` in `/usr/local/bin`. It may
request an administrator password. If the downloaded app has a quarantine
flag, it clears that flag because the current release is not notarized.

The installer refuses to replace an existing app or command. To update an app
you installed with it or from the `.dmg`, quit Patchdesk and run:

```bash
curl -fsSL https://raw.githubusercontent.com/kwanpham2195/patchdesk/main/scripts/install-release.sh | sh -s -- --update
```

The update checks the download the same way, replaces the app in
`/Applications`, and puts the previous app back if any step fails. It exits
without a download when the latest release is already installed, and leaves
the `patchdesk` command as it is.

You can also install through Homebrew or download the `.dmg` by hand.

**From the `.dmg`:**

1. Download the `.dmg` from the
   [Releases page](https://github.com/kwanpham2195/patchdesk/releases).
2. Open the `.dmg` and drag Patchdesk into Applications.

The current release is not signed with an Apple Developer ID or notarized, so
macOS reports Patchdesk.app as damaged on the first launch. Clear the
quarantine flag macOS adds to downloads, then open Patchdesk:

```bash
xattr -dr com.apple.quarantine /Applications/Patchdesk.app
```

**With Homebrew:**

```bash
brew install --cask kwanpham2195/patchdesk/patchdesk
```

Installing by the fully qualified cask name trusts only this cask. Before the
first launch, run the same `xattr` command shown above. Later
versions install with `brew upgrade --cask patchdesk`.

**Updating from the app:** Patchdesk shows each new release in the title bar.
**Update now** quits Patchdesk, updates it, and opens it again. A Homebrew
install updates through Homebrew; any other app in `/Applications` updates
through the installer's `--update` mode. When Patchdesk cannot replace the app
itself, for example because `/Applications` needs an administrator password or
the app runs from somewhere else, the title bar shows the command to run in
Terminal instead.

Opening Patchdesk a second time while it is already running quits the new
copy right away; the existing window comes to the front instead.

## First run

The Pull requests screen starts with **Set up your workspace**, and you finish
setup there — no trip to Settings:

1. **Reviewing as** — confirm the GitHub account, taken from `gh`. If several
   are logged in, pick one. If none are, run `gh auth login` in a terminal and
   press Re-check.
2. **Repositories** — type a repository as `owner/repo` and press Add. Add
   as many as you want to review.

Everything saves as you go, and each control says whether it saved. Press
Continue to see the pull request list. Later, the same two cards live in
Settings → Workspace.

Patchdesk never searches your disk for checkouts. A local review needs the
repository's checkout: press Choose checkout on its row in Settings →
Workspace, or press Local review and Patchdesk asks for it the first time.

## Reviewing pull requests

Open the Pull requests screen and pick a Selected repository. Patchdesk
shows one repository's list at a time; GitHub decides what is in it, the
order, and the count.

From a pull request you can read the diff, leave comments, resolve
conversations, submit a Review, and merge without using a model.

Use More filters to filter by Review state or Check status. Active selections
appear as chips and persist with the active profile across reloads. Clear a
chip to remove one selection, or choose Clear all filters in More filters to
clear those selections.

## Insights

An Insight is optional. It can help you understand or evaluate a change, but
it never replaces a Review. Patchdesk offers four: Brief, Guide, Walkthrough,
and Analysis. The Scope gauge also groups changed files by path without a model.

Each run opens a dialog where you choose a native provider, model, reasoning
level, and language. The dialog starts with that Insight's saved choices.
Opening or cancelling it changes no saved preference. Only an accepted start
saves the selected options.

Run Insights starts several selected Insights independently. Shared controls
show mixed values when their options differ. Change a shared control to apply
it to selected editable rows, or open a row's overrides to choose separately.
A row that is already running cannot be edited or started again. A refused
start does not erase successful starts in the same batch.

### Retired API-key integration

New runs use Codex CLI account or pi CLI account. Patchdesk no longer bundles
a separate API-key runtime or model catalog. Configure models and authentication
through the native CLI you choose.

A saved API-key choice stays visibly retired until you explicitly choose a
native provider and model. Patchdesk does not reuse the API model or silently
switch to another paid account. Earlier results keep their original API key
provenance. An interrupted API run cannot start a new generation through a
replacement provider; a native run needs its own confirmation.

### Codex CLI account

This provider uses your existing Codex CLI login. Install Codex and run
`codex login` yourself; Patchdesk never starts a login for you.

Patchdesk finds `codex` by searching your PATH only. It reads PATH from your
login shell, so a Homebrew or npm install is found, and Patchdesk runs the
same `codex` your terminal runs.

If Patchdesk cannot find Codex, the dialog says so directly: "Install Codex
and expose codex on the app launch PATH, then log in externally."

### pi CLI account

This provider runs the `pi` coding agent you have installed, using its own
login, such as a Claude or ChatGPT subscription. Authenticate in Pi yourself;
Patchdesk never starts or refreshes that login.

Patchdesk finds `pi` on the inherited login-shell PATH. Choose pi CLI account
in the run dialog, then Load pi models or Refresh models. The list names models
as `provider/model` and includes reasoning support reported by the native CLI.
The dialog explains a missing executable, unavailable login, or unsupported
version.

Generating work uses a fresh session and the represented Review worktree.
Inherited extensions, MCP, skills, templates, themes, and context files are
disabled. Pi can use Bash for inspection and the bounded Guide or Walkthrough
bridge. Bash is not an enforced read-only shell. Exported provider-key variables
are excluded from the Pi process environment; use Pi's own supported login.

### While an Insight runs

Preparing, Running and Cancelling remain distinct. Previous results stay
readable during a replacement, and failed or cancelled work does not replace
them. Activity expands the available bounded trace. Failure Details show safe
run and cleanup metadata, without native conversation bodies or private paths.

A paused Guide or Walkthrough does not retry uncertain requests automatically.
Start new generation opens a repeat-spend acknowledgment before sending
anything. It starts fresh work and does not recover missing responses. If
cleanup or recovery evidence is insufficient, the action stays disabled and
explains why. Dismissing the confirmation sends nothing.

Native history is retained privately for debugging. It can include prompts,
source and tool output; completeness stays unknown. It does not establish
publication or safe cleanup. See [local storage and privacy](product-description/cross-cutting/local-storage-and-privacy.md#while-the-action-runs)
for permission, credential-home, retention and recovery limits.

## Use Patchdesk from a coding agent (MCP)

A terminal coding agent, such as Claude Code or Codex, can use Patchdesk as
its review desk through the `patchdesk mcp` command. The agent opens a local
Review of its change, asks for Insights, reads the notes you drafted, and
answers each one. You stay the reviewer: an Insight runs only after you press
Run in Patchdesk, the Review moves to the agent's newer changes only when you
press Refresh, and only you resolve a note. Its tools cannot Apply, edit or
resolve your notes, commit, or touch GitHub.
[A coding agent over MCP](product-description/pull-requests/coding-agent-over-mcp.md)
describes the whole loop.

To connect an agent, you install the command, register it with the agent,
check the connection with `patchdesk mcp --check`, and tell the agent when to
use Patchdesk. [Patchdesk MCP server](mcp.md) walks through each step, and
covers other MCP hosts, each tool, and troubleshooting.

## Where Patchdesk keeps its files

- Config: `~/.config/patchdesk`
- Data: `~/.local/share/patchdesk`
- Cache: `~/.cache/patchdesk`
- Logs: `~/.local/share/patchdesk/logs/patchdesk.jsonl`

Patchdesk does not use `~/Library`. A development build (`pnpm dev`) keeps its own copies under the same names with a `-dev` suffix, such as `~/.config/patchdesk-dev`.

## How Patchdesk stays safe

The local API only listens on `127.0.0.1`, and the app window is sandboxed:
it has no direct access to Node.js or your filesystem. The `patchdesk mcp`
command reaches the app through a socket in
`~/.local/share/patchdesk/mcp/`, a folder only your macOS user can open.

A GitHub write only happens from an action you choose, like Add to review.
Finishing an Insight never triggers one. If Patchdesk cannot confirm a write,
it locks further writes until you check GitHub. Patchdesk never retries a write
on its own.

## Known limits

- GitHub rate limits and blocked reads (an IP allow list, SAML, or a missing
  scope) show their cause. There is no retry button because retrying cannot fix
  either one.
- Patchdesk is built for a sighted person using a keyboard and mouse. It has
  no screen reader support.
- The Pull requests screen only refreshes when you ask: opening the screen,
  changing a filter or page, or pressing ⌘R.

## Contributing

To build Patchdesk from source or contribute changes, see
[CONTRIBUTING.md](../CONTRIBUTING.md) and
[docs/architecture.md](architecture.md).
