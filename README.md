<p align="center">
  <img src="resources/branding/patchdesk-logo.svg" width="104" alt="Patchdesk logo">
</p>
<h1 align="center">Patchdesk</h1>
<p align="center">
  <strong>Review pull requests and your coding agent's changes with the diff in view.</strong>
</p>
<p align="center">
  Brief maps changed flows and where to read. Walkthrough pairs each chapter
  with its cited diff. Analysis shows findings at source lines for you to
  inspect, add to a review, or dismiss. You can also leave notes on an agent's
  uncommitted work and review its next revision in the same app.
</p>
<p align="center">
  <a href="#install-patchdesk"><strong>Install for macOS</strong></a>
  ·
  <a href="https://github.com/kwanpham2195/patchdesk/releases/latest">Download</a>
  ·
  <a href="docs/user-guide.md">Read the guide</a>
</p>
<p align="center">
  <a href="https://github.com/kwanpham2195/patchdesk/releases"><img src="https://img.shields.io/github/v/release/kwanpham2195/patchdesk" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-111111" alt="macOS on Apple Silicon">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-6366f1" alt="MIT license"></a>
</p>

![Patchdesk Insights with Brief, Walkthrough, and Analysis](docs/assets/insights.png)

<p align="center"><em>Start with the shape of the change, follow its implementation, then review the evidence.</em></p>

## Install Patchdesk

Patchdesk runs on macOS with Apple Silicon. You need `git` and the GitHub CLI
(`gh`) to review GitHub pull requests. The packaged app does not need Node.js.

### Install with one command

For a fresh install, run:

```bash
curl -fsSL https://raw.githubusercontent.com/kwanpham2195/patchdesk/main/scripts/install-release.sh | sh
```

[Read the installer](scripts/install-release.sh) before running it. It downloads
the latest published Apple Silicon ZIP, checks its SHA-256 digest against the
GitHub release, installs Patchdesk in `/Applications`, and links `patchdesk`
in `/usr/local/bin`. It may request an administrator password for those
folders. It stops if the app or command already exists, so you can choose how
to update or replace it. The current release is not notarized, so the installer
clears the download quarantine flag if macOS added it.

### Install with Homebrew

```bash
brew install --cask kwanpham2195/patchdesk/patchdesk
```

Installing by the fully qualified cask name trusts only this cask, and
Homebrew puts the `patchdesk` command on your PATH. The current release is not
notarized, so clear the quarantine flag before the first launch:

```bash
xattr -dr com.apple.quarantine /Applications/Patchdesk.app
```

### Install from the disk image

1. Download the `.dmg` from the
   [latest release](https://github.com/kwanpham2195/patchdesk/releases/latest).
2. Drag Patchdesk into Applications.
3. The current release is not notarized, so clear the download quarantine
   flag before the first launch:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Patchdesk.app
   ```

To connect a coding agent after a disk-image install, first
[link the `patchdesk` command](docs/mcp.md#install-the-command).

### Build and install from source

Install Node.js 22.19 or later and pnpm 8.8.0, then run:

```bash
git clone https://github.com/kwanpham2195/patchdesk.git
cd patchdesk
pnpm install
pnpm install:mac
```

`pnpm install:mac` builds Patchdesk, replaces the copy in `/Applications` if
one exists, and opens the installed app. Run `pnpm package:mac` if you only
want the package files. See [CONTRIBUTING.md](CONTRIBUTING.md) for development
commands.

### Finish setup

Check that `uname -m` prints `arm64`, `git --version` and `gh --version` work,
and `gh auth status` shows an authenticated account. If it does not, run
`gh auth login`. Open Patchdesk, choose the folder containing your checkouts,
and select the repositories to review. The pull request list appears after you
select the first repository.

If a coding agent is doing the installation, give it this task:

> Install Patchdesk using this README. Check the prerequisites and any existing
> installation first. Verify that the app opens. Tell me when I need to sign in
> with `gh` or select repositories in Patchdesk. Report what you installed.

## Understand the change before you approve it

Patchdesk gives you three AI tools for different stages of a review. Run one or
all three with the provider, model, and reasoning level you choose.

### Brief finds the reading path

Brief shows which calls, states, or exported contracts changed, with links from
changed steps to their diff hunks. It groups files by ownership, finds uses of
changed names outside the patch, and opens its suggested reading path in the
Diff.

![Patchdesk Brief showing the shape and blast radius of a pull request](docs/assets/insight-brief.png)

### Walkthrough explains the implementation

Walkthrough pairs each chapter with the relevant diff hunks and inline
discussion. Move through sections with the keyboard, keep the code in view,
and mark sections reviewed as you go.

![Patchdesk Walkthrough explaining a pull request in chapters](docs/assets/insight-walkthrough.png)

### Analysis reviews the evidence

Analysis checks the patch against the pull request description or the local
Review's Change intent. Each finding points to file and line evidence; some
also show a verified replacement. Inspect the containing hunk, add a finding
to your review, or dismiss it.

![Patchdesk Analysis with a finding and its source evidence](docs/assets/insight-analysis.png)

## Bring your preferred model

Choose the provider, model, reasoning level, and language for every run.
Patchdesk works with supported API-key providers and your existing Codex CLI
login, so you can use the models and account you already have.

Each Insight stays attached to the Review revision it analyzed. Brief,
Walkthrough, and Analysis remain separate results, ready to revisit throughout
the review.

![Choosing a provider, model, reasoning level, and language for an Insight](docs/assets/insight-run-dialog.png)

## Review the whole pull request in one place

AI Insights sit inside a complete GitHub review workflow:

- Triage pull requests by state, labels, review status, checks, author, or base
  branch.
- Browse changes by file, commit, or scope, with a local checkout beside the
  review.
- Read conversations, preview Markdown, and comment on exact diff lines.
- Build a pending review, submit your decision, and merge when the pull request
  is ready.
- Press <kbd>⌘K</kbd> to jump to a pull request from anywhere in the app.

![Browsing a pull request from the file tree](docs/assets/diff-browse.png)

<p align="center"><em>Files, commits, scope, threads, and the rendered diff stay together.</em></p>

## Review your coding agent's work

Patchdesk also reviews changes that are not on GitHub yet, such as the
working tree, a branch, or a commit in your checkout. Claude Code and Codex
can send their work to Patchdesk over MCP:

1. The agent opens a local Review of its change and asks for an Analysis.
2. You press **Run** in Patchdesk. Nothing spends your model account without
   that click.
3. You leave notes on diff lines, then tell the agent "check Patchdesk".
4. The agent reads your notes, fixes the code, and prepares the new revision.
5. You press **Refresh**. Patchdesk moves the Review to the new code and marks
   each note **Unchanged**, **Changed since your note**, or **Needs attention**.

Patchdesk gives the agent no way to apply a suggestion, commit, edit your
notes, or reach GitHub. To set it up, see
[Connect a coding agent](#connect-a-coding-agent).

## Local-first by design

Patchdesk runs on your Mac and connects to GitHub through your authenticated
GitHub CLI account. Insight runs use prepared review context from the current
revision, and you decide which findings become part of the review.

## Connect a coding agent

The shell installer links `patchdesk` in `/usr/local/bin`, and Homebrew links
it in Homebrew's `bin` directory. Make sure that directory is on your PATH.
After a disk-image install, [link it yourself](docs/mcp.md#install-the-command).

1. Register the command with your agent. Run the line for the agent you use:

   ```bash
   claude mcp add patchdesk -- patchdesk mcp
   codex mcp add patchdesk -- patchdesk mcp
   ```

2. With Patchdesk open, check the connection:

   ```bash
   patchdesk mcp --check
   ```

   The command prints your repositories. If it prints `app_not_running`,
   open Patchdesk and run it again.

3. Tell the agent when to use Patchdesk. The agent calls the tools only when
   its instructions say so. Copy this into your project's `CLAUDE.md` or
   `AGENTS.md`:

   ```markdown
   ## Review in Patchdesk

   - When a change is ready for review, call the Patchdesk tool `review_local` with your working directory as `cwd` and the task you were given as `intent`.
   - To get an Analysis, Walkthrough, or Brief, call `run_insight` with the `reviewId` and `sessionId` from `review_local`. It returns `awaiting_approval`: stop, and tell me the request waits for my approval in Patchdesk. Call `get_insight` when I say it ran.
   - When I say "check Patchdesk", call `get_insight` for any Insight you requested, then `get_feedback`; address every Finding and comment, then call `refresh_review` and tell me the changes are ready.
   - Do not commit until I say the review is done.
   ```

Review the change before the agent commits it. After a commit, a working-tree
Review compares against the new `HEAD`, so a clean tree shows an empty diff.
[The MCP server page](docs/mcp.md) covers a disk-image install, other MCP
hosts, each tool, and troubleshooting.

## Learn more

- [User guide](docs/user-guide.md) covers first run, review workflows,
  Insights, providers, coding agents over MCP, storage, and current limits.
- [MCP server](docs/mcp.md) covers connecting a coding agent and lists its
  tools.
- [Product description](docs/product-description/README.md) documents the app
  screen by screen.
- [Architecture](docs/architecture.md) explains the application layers and
  boundaries.
- [Changelog](CHANGELOG.md) lists changes in each release.

Patchdesk is open source under the [MIT license](LICENSE). If it improves your
review workflow, [star the repository](https://github.com/kwanpham2195/patchdesk).
