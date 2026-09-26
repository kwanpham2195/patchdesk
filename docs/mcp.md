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

- The agent opens a Review of its working tree in Patchdesk and records the
  task you gave it as the Review's Change intent, so an Analysis checks the
  patch against that task.
- The agent asks for an Analysis, Walkthrough, or Brief. The request waits in
  Patchdesk until you press **Run**, and you pick the provider and model.
- You leave notes on diff lines, then tell the agent "check Patchdesk". It
  reads your notes and the Analysis Findings.
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
- When I say "check Patchdesk", call `get_insight` for any Insight you requested, then `get_feedback`; address every Finding and comment, then call `refresh_review` and tell me the changes are ready.
- Do not commit until I say the review is done.
```

The last rule matters; see [Known limits](#known-limits).

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
active workspace profile and on local Reviews only. A refused call returns an
error code and a sentence the agent can relay to you;
[Troubleshooting](#troubleshooting) lists the common ones.

<!-- START AUTOMATED TOOLS -->

- **list_repositories** (read-only): List the repositories of the active Patchdesk workspace profile that have a local checkout, with each live checkout (the configured one and its linked worktrees) and the branch it is on. Reads local git only.
  - No arguments.

- **review_local**: Open the Patchdesk Review of the checkout that contains cwd, so the maintainer reviews your change in Patchdesk. A new Review reads the checkout as it is now; an existing one is returned on the session the maintainer sees, and refresh_review reads newer changes. It changes no branch, index, or working-tree file; Patchdesk stores the snapshot as git objects, a refs/patchdesk/local/ ref, and a worktree in its cache. Returns the reviewId, the session (sessionId, headSha, baseSha, patchHash), the changed files, and which Insights are retained. intent is the task you were given, as Markdown; it is recorded only when the Review has no Change intent. With intent, intentRecorded says whether the Review now holds it: intentKept is false when this call recorded it, and true when the Review already held the same text. A refused intent still returns the opened Review, with intentRecorded: false, intentRefused (intent_exists when the Review holds a different intent, in_progress or storage when recording failed and a retry may work), and intentMessage.
  - `cwd` (string, required, at most 4,096 characters): An absolute path inside the checkout, usually your working directory.
  - `source` (object, optional): What to review; defaults to the working tree, which includes uncommitted and untracked changes. One of:
    - `{ "kind": "working_tree" }`
    - `{ "kind": "branch", "branch": <string>, "baseBranch": <string> }`
    - `{ "kind": "commit", "commit": <string> }`
  - `intent` (string, optional, at most 65,536 characters): The goal of the change as Markdown, for Analysis to check the patch against.

- **refresh_review**: Read the checkout of a local Review again after you changed it, and prepare those changes for the maintainer. The Review stays on the session the maintainer sees, and Patchdesk shows them Updates available; their Refresh moves the Review to the prepared session and carries their notes. It changes no branch, index, or working-tree file; Patchdesk stores the snapshot as git objects, a refs/patchdesk/local/ ref, and a worktree in its cache. Returns changed: false when the checkout still matches the Review's session, else changed: true with preparedSessionId. One call per Review every 10 seconds; an earlier one is refused rate_limited with retryAfterMs.
  - `reviewId` (string, required, at most 512 characters): The reviewId review_local returned.

- **run_insight**: Ask the maintainer to run one Insight on a local Review's current session. It returns at once with status awaiting_approval and a requestId; nothing runs until the maintainer presses Run in Patchdesk, and the provider and model are theirs to pick. On awaiting_approval, stop: tell the user the request waits for their approval in Patchdesk, and read get_insight when they resume you. A request already awaiting or running for that session and type is returned as it stands, and a declined one returns declined: the maintainer declined it for this session. sessionId must be the Review's current session, else it is refused stale_session.
  - `reviewId` (string, required, at most 512 characters): The reviewId review_local returned.
  - `sessionId` (string, required, at most 512 characters): The sessionId review_local or get_insight returned.
  - `type` (string, required): One of `analysis`, `walkthrough`, `brief`.

- **get_insight** (read-only): Read one Insight of a local Review: its status, and the retained result with the session it describes. awaiting_approval and declined answer a run_insight request on the current session. An Analysis lists its Findings with whether the maintainer dismissed, drafted, or applied each. A result from an earlier session carries outdated: true.
  - `reviewId` (string, required, at most 512 characters): The reviewId review_local returned.
  - `type` (string, required): One of `analysis`, `walkthrough`, `brief`.

- **get_feedback** (read-only): Read the review comments the maintainer drafted on a local Review in file and line order, up to 25 per page and fewer when they are long, with the same Markdown prompt Copy as agent prompt gives. Each comment names the session it was written against and a state: current (written on the Review's current session), unchanged or changed (its lines since it was written), needs_attention (its lines could not be found), or applied. Pass nextCursor to read the next page.
  - `reviewId` (string, required, at most 512 characters): The reviewId review_local returned.
  - `cursor` (string, optional, at most 64 characters): The nextCursor of the previous page.

<!-- END AUTOMATED TOOLS -->

`pnpm docs:mcp-tools` writes this list from `src/mcp/tool-manifest.ts`.

## What the agent cannot do

The tools give the agent no way to:

- Start an Insight run without your **Run**, or choose the provider or model.
- Press Apply, dismiss a Finding, or add, edit, or remove your notes.
- Replace a Change intent the Review already holds.
- Commit, push, change a branch, or write your index or working-tree files.
- Read or write GitHub, or open a pull request Review.
- Change provider settings or switch the workspace profile.
- Start Patchdesk.

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
  choose the folder that holds the checkout and tick the repository in the
  list Patchdesk finds there.
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

## Known limits

- After the agent commits, a working-tree Review compares the working tree
  against the new `HEAD`. A clean tree then shows an empty diff, and your
  notes lose their lines and read **Needs attention**
  ([#491](https://github.com/kwanpham2195/patchdesk/issues/491)). Review
  before the agent commits. To review work the agent already committed, open
  a Branch Review of its branch against the base branch.
- A note on the first or last line of a file is lost from the Diff when the
  agent rewrites that line. The note reads **Needs attention** after Refresh
  and stays under Local drafts on the Insights tab
  ([#521](https://github.com/kwanpham2195/patchdesk/issues/521)).
