# Patchdesk MCP server

`patchdesk mcp` is a Model Context Protocol (MCP) server that lets a coding
agent in your terminal, such as Claude Code or Codex, send its work to
Patchdesk for review. It ships inside the app, and it talks only to the
Patchdesk running on your Mac.

## What it does

The agent opens a local Review of the change it made, asks for Insights, and
reads the notes you drafted. You stay the reviewer. An Insight runs only after
you press **Run** in Patchdesk, and the Review moves to the agent's newer code
only when you press **Refresh**.

From your side, a session looks like this:

- The agent opens the Review of its branch in Patchdesk: every change since
  the branch left its base branch, committed or not. It records the task you
  gave it as the Review's Change intent, so an Analysis checks the patch
  against that task. The agent's commits stay in the diff, so your notes stay
  on their lines after it commits.
- The agent asks for an Analysis, Walkthrough, or Brief. The request waits in
  Patchdesk until you press **Run**, and you pick the provider and model.
- You leave notes on diff lines, then tell the agent "check Patchdesk". It
  finds the Review you have open for its checkout without opening or moving
  one, then reads your notes and the Analysis Findings.
- The agent fixes the code and prepares the new revision. Patchdesk shows
  **Updates available**, and your **Refresh** moves the Review to the new code
  and carries your notes.

[A coding agent over MCP](product-description/pull-requests/coding-agent-over-mcp.md)
describes the whole loop screen by screen.

## How it works

```text
coding agent (Claude Code, Codex)
    |
    |  MCP over stdin and stdout
    v
patchdesk mcp                      started by the agent
    |
    |  one connection per tool call
    v
~/.local/share/patchdesk/mcp/patchdesk.sock
    |
    v
Patchdesk app                      must be running
```

The agent starts `patchdesk mcp` as a child process. For each tool call, the
command connects to a Unix socket that the running app listens on, sends the
call, and passes the app's answer back to the agent. Nothing listens on a
network port. The socket's folder has mode `0700` and the socket `0600`, so
only your macOS user can connect.

The command never starts Patchdesk. A call made while the app is closed
returns `app_not_running`. Every call connects again, so the next call after
you open Patchdesk works without restarting the agent. Each call acts on the
workspace profile that is active when the call arrives.

## Prerequisites

- macOS on Apple Silicon.
- Patchdesk 0.0.12 or later, installed and open.
- A workspace profile. Finishing [first run](user-guide.md#first-run) creates
  one.
- The repository added to that profile with a local checkout. The agent can
  review only checkouts that `list_repositories` returns.

## Install the command

Patchdesk bundles the command at
`Patchdesk.app/Contents/Resources/bin/patchdesk`. It runs on the Node that
ships inside the app, so there is nothing else to install.

The [shell installer](../scripts/install-release.sh) links it as
`/usr/local/bin/patchdesk`. The Homebrew cask links it in
`$(brew --prefix)/bin` (`/opt/homebrew/bin` on Apple Silicon). Make sure that
directory is on your PATH. For a disk-image install, link it yourself:

```bash
ln -s /Applications/Patchdesk.app/Contents/Resources/bin/patchdesk /usr/local/bin/patchdesk
```

If `/usr/local/bin` does not exist or is not on your PATH, link it into
Homebrew's `bin` folder instead:

```bash
ln -s /Applications/Patchdesk.app/Contents/Resources/bin/patchdesk "$(brew --prefix)/bin/patchdesk"
```

Check the link by running `patchdesk` with no arguments. It prints its usage
and exits 0:

```text
Usage: patchdesk mcp [--check]

  patchdesk mcp          Serve Patchdesk's tools to a coding agent over MCP (stdio).
  patchdesk mcp --check  Call list_repositories on the running app and print the result.
```

## Add it to your agent

### Claude Code

```bash
claude mcp add patchdesk -- patchdesk mcp
```

This registers the server for the current project. To register it for every
project, add `--scope user`:

```bash
claude mcp add --scope user patchdesk -- patchdesk mcp
```

### Codex

```bash
codex mcp add patchdesk -- patchdesk mcp
```

Codex registers the server for every project, in `~/.codex/config.toml`:

```toml
[mcp_servers.patchdesk]
command = "patchdesk"
args = ["mcp"]
```

Both clients work with no extra setting. To have them use the 2026-07-28 MCP
revision instead of the 2025 one, set `MCP_PROTOCOL_NEGOTIATION=auto` for
Claude Code, or enable the Codex feature `mcp_2026_07_28` and add
`--env CODEX_MCP_PROTOCOL_VERSION=2026-07-28` to `codex mcp add`.

### Other MCP hosts

The project tests Patchdesk with Claude Code and Codex only. Other hosts that
run local stdio servers should work with this entry, in the common
`mcpServers` format:

```json
{
  "mcpServers": {
    "patchdesk": {
      "command": "patchdesk",
      "args": ["mcp"]
    }
  }
}
```

Each host keeps this entry in its own file and may use a different key, so
check the host's MCP documentation.

A host you open from the Dock or Finder, such as Claude Desktop, Cursor, or VS
Code, may not have `/opt/homebrew/bin` on its PATH. It then fails to start
`patchdesk`. Give `command` an absolute path instead:

- `/opt/homebrew/bin/patchdesk` for a Homebrew install.
- `/Applications/Patchdesk.app/Contents/Resources/bin/patchdesk` for any
  install.

### Check the connection

With Patchdesk open, run:

```bash
patchdesk mcp --check
```

It prints the socket it connects to, then the repositories of your active
workspace profile that have a local checkout, and exits 0:

```text
socket: /Users/you/.local/share/patchdesk/mcp/patchdesk.sock
{
  "profile": {
    "id": "Personal",
    "label": "Personal"
  },
  "repositories": [
    {
      "host": "github.com",
      "owner": "you",
      "repo": "app",
      "localPath": "/Users/you/src/app",
      "checkouts": [
        {
          "path": "/Users/you/src/app",
          "name": "app",
          "head": {
            "kind": "branch",
            "branch": "main"
          },
          "configured": true
        }
      ]
    }
  ]
}
```

With Patchdesk closed, it prints the socket line, then this line on stderr,
and exits 1:

```text
app_not_running: Patchdesk is not running. Start Patchdesk and try again. (ENOENT)
```

## Tell your agent when to use it

The agent calls these tools only when its instructions tell it to. Copy this
into your project's `CLAUDE.md` or `AGENTS.md`:

```markdown
## Review in Patchdesk

- When a change is ready for review, call the Patchdesk tool `review_local` with your working directory as `cwd` and the task you were given as `intent`.
- To get an Analysis, Walkthrough, or Brief, call `run_insight` with the `reviewId` and `sessionId` from `review_local`. It returns `awaiting_approval`: stop, and tell me the request waits for my approval in Patchdesk. Call `get_insight` when I say it ran.
- Before `get_feedback`, call `list_local_reviews` with your working directory as `cwd` to find the Review I am looking at, and use its `reviewId`. If it returns several Reviews for your branch, ask me which base I meant.
- When I say "check Patchdesk", call `get_insight` for any Insight you requested, then `get_feedback`; address every Finding and comment, then call `refresh_review` and tell me the changes are ready.
```

## Example prompts

With the block above in place, short prompts are enough:

- "Implement #12, then get it reviewed in Patchdesk."
- "Open this branch in Patchdesk against `main`, with the spec in
  `docs/plan.md` as the intent, and ask for an Analysis."
- "The Analysis ran. Check Patchdesk."
- "Check Patchdesk. I left two notes on the parser."

## Tools

Each entry gives the description the agent receives, then the tool's
arguments. Tools marked read-only change nothing. Every tool acts on the
active workspace profile and on local Reviews only, except `show_review`, which
also shows a pull request Review. A refused call returns an
error code and a sentence the agent can relay to you;
[Troubleshooting](#troubleshooting) lists the common ones.

<!-- START AUTOMATED TOOLS -->

- **list_repositories** (read-only): List the repositories of the active Patchdesk workspace profile that have a local checkout, with each live checkout (the configured one and its linked worktrees) and the branch it is on. Reads local git only.
  - No arguments.

- **list_local_reviews** (read-only): List the shared Reviews the maintainer has open for the checkout that contains cwd, in the active Patchdesk profile, the one opened last first. Read-only: it opens, prepares, and moves nothing, takes no snapshot, and does not mark a Review opened. head names the branch the checkout is on. Each entry has the reviewId, branch, baseRef (the base as a full ref, such as refs/heads/main or refs/remotes/origin/main), lastOpenedAt when the maintainer opened it, changeIntent when the Review has a Change intent (kind text with source maintainer or agent, without the text, or kind file with the spec file's path), and the Review's current session (sessionId, headSha, baseSha, patchHash). Use it to find the Review the maintainer means before get_feedback or get_insight. When several entries on your branch differ only by base, ask the maintainer which base they mean. An empty list means no shared Review is open here; review_local opens one. A cwd outside every checkout of the profile is refused checkout_not_found; a repository whose configured checkout no longer exists is refused checkout_missing, naming the path. A Review whose current session is missing is left out. If Patchdesk cannot read the complete saved Review list or a listed Review's current session, it refuses storage rather than leaving that Review out.
  - `cwd` (string, required, at most 4,096 characters): An absolute path inside the checkout, usually your working directory.

- **review_local**: Open the Patchdesk Review of the checkout that contains cwd, so the maintainer reviews your change in Patchdesk. By default this is the shared Review of the branch checked out there: every change since the branch left its base branch, committed or not, so your commits keep the maintainer's notes in place. Without base, the branch's open shared Review is returned when there is one (the one the maintainer opened last), else Patchdesk infers the base: the other local branch with the fewest commits between its merge base and HEAD, ties going to the default branch. The result names baseRef, the base as a full ref, and baseInferred: true when Patchdesk picked it. A branch with no open Review and no other local branch behind HEAD is refused base_required; pass base. A new Review reads the checkout as it is now; an existing one is returned on the session the maintainer sees, and refresh_review reads newer changes. It changes no branch, index, or working-tree file; Patchdesk stores the snapshot as git objects, a refs/patchdesk/local/ ref, and a worktree in its cache. Returns the reviewId, the session (sessionId, headSha, baseSha, patchHash), the changed files, and which Insights are retained. When the Review has a Change intent, the goal Analysis checks the change against, changeIntent returns it: kind text with source (maintainer or agent) and markdown, or kind file with the path of a spec file to read in your checkout. intent is the task you were given, as Markdown; it is recorded only when the Review has no Change intent. With intent, intentRecorded says whether the Review now holds it: intentKept is false when this call recorded it, and true when the Review already held the same text. A refused intent still returns the opened Review, with intentRecorded: false, intentRefused (intent_exists when the Review holds a different intent, the one changeIntent returns, in_progress or storage when recording failed and a retry may work), and intentMessage. A working tree with more than 5,000 untracked files or 100 MiB of them is refused untracked_too_large before anything is stored; the message names the largest untracked paths to add to .gitignore. A change whose patch is over 2 MiB is refused patch_too_large and no session is stored; the message names the files with the most changes. A cwd in a repository whose configured checkout no longer exists, as after a move on disk, is refused checkout_missing; the message names the configured path.
  - `cwd` (string, required, at most 4,096 characters): An absolute path inside the checkout, usually your working directory.
  - `source` (object, optional): What to review; defaults to local_branch, the shared Review of the checked-out branch against its base, with committed, staged, unstaged, and untracked changes. commit reviews one commit against its parent. One of:
    - `{ "kind": "local_branch" }`
    - `{ "kind": "commit", "commit": <string> }`
  - `base` (string, optional, at most 255 characters): The branch the shared Review compares with: a local branch such as main, or a remote-tracking branch such as origin/main as last fetched, since Patchdesk never fetches. A local branch of the same name wins; pass a full ref such as refs/remotes/origin/main to choose. Omit it to reuse the branch's open Review or let Patchdesk infer one. Not allowed with source commit.
  - `intent` (string, optional, at most 65,536 characters): The goal of the change as Markdown, for Analysis to check the patch against.

- **refresh_review**: Read the checkout of a local Review again after you changed it, and prepare those changes for the maintainer. The Review stays on the session the maintainer sees, and Patchdesk shows them Updates available; their Refresh moves the Review to the prepared session and carries their notes. It changes no branch, index, or working-tree file; Patchdesk stores the snapshot as git objects, a refs/patchdesk/local/ ref, and a worktree in its cache. Returns changed: false when the checkout still matches the Review's session, else changed: true with preparedSessionId. One call per Review every 10 seconds; an earlier one is refused rate_limited with retryAfterMs. A working tree over the untracked limit of review_local is refused untracked_too_large, naming the largest untracked paths. A patch over 2 MiB is refused patch_too_large, naming the files with the most changes. A Review whose configured checkout no longer exists is refused checkout_missing, naming the path.
  - `reviewId` (string, required, at most 512 characters): The reviewId review_local or list_local_reviews returned.

- **run_insight**: Ask the maintainer to run one Insight on a local Review's current session. It returns at once with status awaiting_approval and a requestId; nothing runs until the maintainer presses Run in Patchdesk, and the provider and model are theirs to pick. On awaiting_approval, stop: tell the user the request waits for their approval in Patchdesk, and read get_insight when they resume you. A request already awaiting or running for that session and type is returned as it stands, and a declined one returns declined: the maintainer declined it for this session. sessionId must be the Review's current session, else it is refused stale_session.
  - `reviewId` (string, required, at most 512 characters): The reviewId review_local or list_local_reviews returned.
  - `sessionId` (string, required, at most 512 characters): The sessionId review_local, list_local_reviews, or get_insight returned.
  - `type` (string, required): One of `analysis`, `walkthrough`, `brief`.

- **get_insight** (read-only): Read one Insight of a local Review: its status, and the retained result with the session it describes. awaiting_approval and declined answer a run_insight request on the current session. An Analysis lists its Findings with whether the maintainer dismissed, drafted, or applied each. A result from an earlier session carries outdated: true.
  - `reviewId` (string, required, at most 512 characters): The reviewId review_local or list_local_reviews returned.
  - `type` (string, required): One of `analysis`, `walkthrough`, `brief`.

- **show_review**: Switch the Patchdesk window to an existing Review, so the maintainer finds it on screen the next time they switch to Patchdesk. It never raises or focuses the window, and it does not create or refresh a Review. It shows any saved Review of the active profile, local or pull request, even one whose repository is no longer watched. Returns status shown, or held when an unsaved Finish review summary or a GitHub write in progress keeps Patchdesk on its current screen; on held nothing moved, so tell the user the Review is ready for them to open. A reviewId the active profile does not hold is refused not_found, or profile_changed when another profile holds it. A shared Review whose checkout is now on another branch is refused branch_mismatch, naming that branch.
  - `reviewId` (string, required, at most 512 characters): The reviewId review_local or list_local_reviews returned.

- **get_feedback** (read-only): Read the review comments the maintainer drafted on a local Review in file and line order, up to 25 per page and fewer when they are long, with the same Markdown prompt Copy as agent prompt gives. Each comment names the session it was written against, the view it was written in (combined, committed, or uncommitted; its path, side, and lines are numbered in that view), inline (true when those lines sit inside a hunk of that view on the Review's current session), and a state: current (written on the Review's current session), unchanged or changed (its lines since it was written), needs_attention (its lines could not be found), or applied. Pass nextCursor to read the next page.
  - `reviewId` (string, required, at most 512 characters): The reviewId review_local or list_local_reviews returned.
  - `cursor` (string, optional, at most 64 characters): The nextCursor of the previous page.

<!-- END AUTOMATED TOOLS -->

`pnpm docs:mcp-tools` writes this list from `src/mcp/tool-manifest.ts`.

## What the agent cannot do

The tools give the agent no way to:

- Start an Insight run without your **Run**, or choose the provider or model.
- Press Apply, dismiss a Finding, or add, edit, or remove your notes.
- Replace a Change intent the Review already holds.
- Commit, push, change a branch, or write your index or working-tree files.
- Read or write GitHub, or create or refresh a pull request Review.
- Change provider settings or switch the workspace profile.
- Start Patchdesk, or bring its window to the front.

`show_review` switches the Patchdesk window to a Review the agent names, the
way clicking a notification does, but never raises or focuses the window: the
Review is on screen the next time you switch to Patchdesk. While you have a
kept Finish review summary or a GitHub write is in progress, it moves nothing
and answers `held`.

`review_local` and `refresh_review` store a snapshot of the checkout as git
objects, a `refs/patchdesk/local/` ref, and a worktree in Patchdesk's cache.

### Approve or decline a run

When the agent calls `run_insight`, Patchdesk posts the notification
`Agent asks for Analysis` (or the Insight it named), and the repository's row
in the Visited pull requests column shows an `agent` marker. Open the Review.
Its Insights tab shows an **Agent requests** bar:

- **Run** opens the usual run dialog with your stored provider, model, and
  effort. Confirm it to start the run. Cancelling the dialog leaves the
  request waiting.
- **Decline** refuses the request for that session. The agent can ask again
  after your Refresh moves the Review to a new session.

Running the same Insight from its own Generate button also approves the
waiting request.

### Accept the agent's changes

`refresh_review` prepares the agent's new code without moving the Review, so
the diff never changes under a note you are writing. The header shows
**Updates available** when the window gains focus, or within 90 seconds while
it stays in front. Press **Refresh** to move the Review to the new code. Each
note then reads **Unchanged** or **Changed since your note**.

## Troubleshooting

Run `patchdesk mcp --check` first whenever your agent reports the Patchdesk
server as failed.

- **Patchdesk is not running.** Calls return `app_not_running`. Start
  Patchdesk; the command never starts it. The next call works without
  restarting the agent.
- **Patchdesk does not answer.** Calls return `app_not_responding` when the
  app accepts the connection but sends no answer within 30 seconds. Check
  that Patchdesk is not stuck, then retry.
- **No workspace profile.** Calls return `no_profile`. Finish
  [first run](user-guide.md#first-run) in Patchdesk.
- **You switched workspace profiles.** A call about a Review of another
  profile returns `profile_changed` and names the active one. Switch back in
  Patchdesk, or have the agent call `review_local` again to open a Review in
  the active profile.
- **The repository has no local path.** `list_repositories` leaves it out,
  and `review_local` returns `checkout_not_found`. In Settings → Workspace,
  add the repository if it is not watched, then press Choose checkout on its
  row and pick the folder that holds the checkout.
- **The repository moved on disk.** `review_local` and `refresh_review`
  return `checkout_missing` and name the path the profile still holds. In
  Settings → Workspace, under Repositories, press Choose checkout on the
  repository and pick the checkout's new folder. Its Reviews reopen on the
  same sessions. If the repository has linked
  worktrees of your own, run `git worktree repair` in the moved checkout.
- **Too many untracked files.** `review_local` and `refresh_review` return
  `untracked_too_large` when the working tree has more than 5,000 untracked
  files or 100 MiB of them, usually an un-ignored `node_modules` or build
  folder. The message names the limit the working tree is over and the
  largest untracked paths; add them to
  `.gitignore` or remove them, then call again. Patchdesk stores nothing
  for the refused call.
- **The patch is too large.** `review_local` and `refresh_review` return
  `patch_too_large` when the change's patch, or its committed or
  uncommitted part alone, is over 2 MiB, usually a lockfile or generated
  file. The message names the files with the most
  changes; leave generated ones out of the change, or review it in smaller
  parts, then call again. Patchdesk stores no session for the refused call.
- **No base branch.** `review_local` returns `base_required` when the
  branch has no open Review and no other local branch is behind `HEAD`, as
  in a repository with one branch. Have the agent pass `base`, the branch the
  change should be compared with, such as `main` or `origin/main`, or create
  that branch first.
- **The agent finds no Review.** `list_local_reviews` returns an empty
  `reviews` list when no shared Review is open for the agent's checkout. A
  Review you opened in another linked worktree of the repository is listed
  only for that worktree. Open the Review of the agent's checkout in
  Patchdesk, or have the agent call `review_local`.
- **`patchdesk: command not found` in a terminal.** The link is missing or its
  folder is not on your PATH. Repeat [Install the command](#install-the-command).
- **The server fails to start in a GUI host.** The host cannot find
  `patchdesk` on its PATH. Use an absolute path, as in
  [Other MCP hosts](#other-mcp-hosts).

To see each call, set `PATCHDESK_MCP_DEBUG=1` in the server's environment,
for example with
`claude mcp add patchdesk -e PATCHDESK_MCP_DEBUG=1 -- patchdesk mcp` or
`codex mcp add patchdesk --env PATCHDESK_MCP_DEBUG=1 -- patchdesk mcp`.
The command then writes one line per call to stderr, with the tool, its
outcome, and how long it took. Where your client shows that stderr depends on
the client.

Patchdesk also logs every call to
`~/.local/share/patchdesk/logs/patchdesk.jsonl` with topic `mcp`, without the
intent, note text, or file contents. Help → Diagnostics → Review activity
lists refused calls.
