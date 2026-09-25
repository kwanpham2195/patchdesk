# Review local changes for the coding agent

> **Status: Accepted** (2026-09-25, maintainer in chat). Supersedes the ship
> half of ADR 0050: Commit, Push, Open PR, and the handoff to a pull request
> Review. ADR 0050's sources, identity, Local snapshot, freshness rule, Apply,
> and Local drafts stand. Terms in bold are defined in `CONTEXT.md`.

ADR 0050 made Patchdesk the place a maintainer ships from: review the working
tree, commit, push, open the pull request with the Brief as its body, and hand
the drafts to the pull request Review. Before the ship half was built, the
maintainer set a narrower purpose: local review is for reviewing what a coding
agent changed, the way the `hunk` CLI is, and Patchdesk is not meant to become
another git client.

The loop that purpose describes has no git write in it. An agent edits the
working tree. The maintainer reads the diff with Analysis, Walkthrough, and
Brief, and collects feedback. The feedback goes back to the agent, the agent
edits again, and the maintainer refreshes and reads the change against their
notes. Committing and opening the pull request stay with the maintainer's own
tools.

## The decision

- **No ship steps.** Patchdesk does not commit, push, or open a pull request
  from a local Review, and a local Review does not hand off to a pull request
  Review. Issues #453 to #456 are closed as not planned.
- **Git writes.** From ADR 0050's list only the object and managed-ref writes
  (the Local snapshot and its worktree) and Apply remain. The main process
  writes nothing else to a maintainer's repository, and never pushes.
- **Local drafts are feedback for the agent.** The Local draft list is
  copied to the coding agent as one Markdown prompt ("Copy as agent prompt"),
  each draft with its `path:line`, comment, and suggestion. A draft never
  becomes a GitHub comment.
- **Maintainer notes.** A maintainer may add a note on any diff line of a
  local Review (#462). A note is a Local draft that the maintainer wrote and
  may edit; a draft taken from a Finding stays non-editable, as ADR 0050
  states.
- **Addressed or not.** After Refresh, each carried draft shows whether the
  lines under its anchor changed since the note (#452), so the maintainer can
  check what the agent addressed without an agent reply.
- **Copy Brief as PR description** stays: it is a copy action, and the
  maintainer opens the pull request with their own tools.

## Consequences

- ADR 0050's "Preconditions" and "Operations and recovery" apply to Apply
  only. Its Commit, Push, and Open PR records, the receipt chain, and the
  "Handoff" section describe work that will not be built.
- No local write needs GitHub credentials, and the profile account is used
  only for reads.
- An integration that lets the agent read the drafts and answer them directly
  (an MCP server, #463) is a separate decision with its own ADR.

## Change intent (#467)

> **Added 2026-09-26** (maintainer in chat).

A local Review may hold a **Change intent**: the spec the agent was given,
as Markdown the maintainer enters or as a repository-relative spec file.

- **Analysis owns the check.** The intent goes into the Analysis run input
  as the change's stated goal, and the existing stated-goal check applies: a
  goal the patch misses, or a change the intent does not mention, is a P2
  Finding. The Analysis result records the intent it ran against.
- **Brief is unchanged.** The Brief keeps ADR 0040's hunk-only manifest, and
  Walkthrough does not read the intent either.
- **A spec file is read from the Local snapshot**, the session's head commit,
  so an edit to the working tree after the snapshot does not reach the run.
- **An unreadable spec file refuses the start.** A missing, non-text, or
  over-64 KiB spec file refuses the Analysis with a named reason; Analysis
  never runs against an intent it could not read.
