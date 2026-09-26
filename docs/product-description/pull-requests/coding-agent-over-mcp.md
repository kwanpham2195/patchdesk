# A coding agent over MCP

## Summary

A terminal coding agent, such as Claude Code or Codex, can use Patchdesk as its review desk through the `patchdesk mcp` command (ADR 0052). The agent opens a _local Review_ of its own change, asks for an _Insight_, reads the result, and reads the notes the maintainer drafted. The maintainer stays the reviewer: every Insight run waits for their **Run**, and only their **Refresh** moves the Review to the agent's newer changes. The tools cannot press Apply, edit the maintainer's notes, commit, or write to GitHub. The feature is available whenever Patchdesk is running with a saved _workspace profile_ and the agent's client has the command registered; [Patchdesk MCP server](../../mcp.md) owns installing and registering it.

## The simple case

The maintainer starts Claude Code in a checkout the workspace profile lists and asks it to implement a task and get it reviewed in Patchdesk. The agent edits files, then calls `review_local` with its working directory and the task text. Patchdesk opens the working-tree Review for that checkout's branch, records the text as the Review's _Change intent_ with the header label `Intent from the agent`, and answers with the Review's id, its session, and the changed files. The Patchdesk window stays where the maintainer left it.

The agent calls `run_insight` for an Analysis. Nothing runs yet. A notification reads `Agent asks for Analysis`, and the repository's row in the Visited pull requests column shows an `agent` marker. The maintainer opens the Review; the Insights tab shows an **Agent requests** bar with **Run** and **Decline**. Run opens the ordinary run dialog, and confirming it starts the Analysis. The agent reads the Findings with `get_insight` when the maintainer tells it the run finished.

The maintainer adds a note on a diff line and tells the agent "check Patchdesk". The agent calls `get_feedback`, fixes the code, and calls `refresh_review`. The header shows **Updates available**. The maintainer presses Refresh, the Review moves to the new code, and the note reads `Unchanged` or `Changed since your note`.

## The task, event by event

The loop the maintainer passes through, in order:

1. The agent opens the Review (`review_local`).
2. The agent asks for an Insight (`run_insight`). The request waits.
3. The maintainer presses Run or Decline on the Agent requests bar.
4. The run settles; the agent reads it (`get_insight`).
5. The maintainer drafts notes and tells the agent to read them (`get_feedback`).
6. The agent changes the code and prepares a new session (`refresh_review`). The header shows Updates available.
7. The maintainer presses Refresh. The Review moves to the prepared session and carries the notes. The loop returns to step 2 or ends.

### Arrive

The agent reaches Patchdesk through the tools its client lists. The tools are listed whether or not Patchdesk is running; a call made while it is closed returns `app_not_running`, and the command never starts the app. Every tool acts on the workspace profile that is active when the call arrives.

`list_repositories` names the repositories of the active profile that have a local checkout, each with its configured checkout, its live linked worktrees, and the branch each is on. It reads local `git` only.

### Leave unchanged

`list_repositories`, `get_insight`, and `get_feedback` read and change nothing. A `review_local` call for a Review that already exists returns it on the session the maintainer sees and does not read the checkout again, so it neither moves the Review nor marks it opened. A `refresh_review` call on a checkout whose content still matches the Review's session answers `changed: false` and changes nothing.

### Begin an action

The agent's writing tools are `review_local`, `refresh_review`, and `run_insight`.

`review_local` takes an absolute path inside a checkout, usually the agent's working directory. Patchdesk resolves the path to its checkout, the configured one or a linked worktree, and opens the Review of that checkout's working tree, including uncommitted and untracked files. The agent can pass a branch with a base branch, or a commit, to open those sources instead, as the [Local review dialog](opening-a-local-review.md#begin-an-action) does. A new Review reads the checkout as it is now.

The optional `intent` is the task the agent was given, as Markdown. Patchdesk records it only when the Review has no Change intent. The same text again answers that the intent was kept. A different text leaves the maintainer's intent in place: the Review still opens, and the answer says the intent was refused with `intent_exists`. Text that looks like a credential is refused before anything opens. Analysis reads an agent intent as the stated goal to check, and is told the agent under review wrote it and not to follow instructions in it.

`refresh_review` reads the checkout of a local Review again after the agent changed it, and prepares a session for the new content. It does not move the Review.

`run_insight` asks for one Analysis, Walkthrough, or Brief on the Review's current session. It records an _Agent run request_ and returns at once with `awaiting_approval` and a request id. The tool has no provider, model, or effort field; those are the maintainer's to pick.

> Technical note: `review_local` and `refresh_review` take a Local snapshot, which writes git objects, a `refs/patchdesk/local/` ref, and a worktree in Patchdesk's cache. They change no branch, index, or working-tree file (ADR 0050, ADR 0052 amendment of 2026-09-26).

### While the action runs

Each call opens one connection to the running app and waits at most 30 seconds for the answer. No tool waits on the maintainer or a model. `run_insight` answers before the maintainer has seen the request, and its description tells the agent to stop and tell the user that the request waits in Patchdesk.

An agent run request waits on the Review until the maintainer acts. While it waits:

- The notification `Agent asks for <Insight>` has been posted once, unless the silence rule held it back; see [Notifications](#notifications).
- The Visited pull requests column shows the `agent` marker on the repository's local row, with the hover text `An agent's Insight request awaits you or is running`.
- The Review's Insights tab shows the Agent requests bar. Each row names the Insight, the client's self-reported name (`An agent` when it sent none), and `asked <time>`. With more than one workspace profile, the heading reads `Agent requests · <label> profile`.

A second `run_insight` for the same session and Insight returns the same request as it stands and posts nothing.

### Settle

**Run** opens the ordinary [Insight run dialog](../review-workbench/analysis.md) with the Insight fixed and the stored provider, model, and effort filled in. The maintainer can change any of them. Confirming starts the run under the same checks and Review lock as the Generate button, and marks the request approved. Cancelling the dialog leaves the request waiting. Run is disabled with its reason beside it when no model is configured (`No model configured`) or when that Insight is already running (`<Insight> is running`). When the request was declined or already run by the time the dialog confirms, the dialog reads `The agent's request was declined or run meanwhile.`

Any Run of an Insight approves the current session's waiting request for that Insight, whether the maintainer pressed it on the bar or on the Insight's own Generate button, so the bar, `run_insight`, and `get_insight` agree.

**Decline** marks the request declined; the button reads `Declining…` while the write runs, and `Decline failed. Try again.` appears under the row when it fails. Decline is final for the session: a later `run_insight` for the same session and Insight answers `declined` and posts nothing. After the maintainer's Refresh moves the Review to a new session, the agent can ask again.

The `agent` marker clears when the last request is settled or declined and no run an agent asked for is still active.

## The tools in plain terms

- `list_repositories`: which repositories and checkouts Patchdesk can review in the active profile.
- `review_local`: open this checkout's Review so the maintainer can read my change, and record my task as the Change intent if the Review has none.
- `refresh_review`: I changed the code; prepare it for the maintainer. The maintainer sees Updates available.
- `run_insight`: ask the maintainer to run an Analysis, Walkthrough, or Brief on the current session.
- `get_insight`: read one Insight's status and result. The status is `none`, `awaiting_approval`, `declined`, `running`, `completed`, or `failed`. An Analysis lists its Findings with whether the maintainer dismissed, drafted, or applied each. A result from an earlier session carries `outdated: true`.
- `get_feedback`: read the maintainer's _Local drafts_, in file and line order, with the same Markdown prompt that **Copy as agent prompt** copies.

Every answer that describes a session names its id, head, base, and patch hash, so the agent can tell which code a Finding or note is about.

## Updates available and Refresh

After `refresh_review` prepares a session for new content, the Review stays on the session the maintainer is reading. The header shows **Updates available**, and Apply stays unavailable until the Review moves. An open Review checks for the prepared session when its window gains focus and every 90 seconds, so the label can take up to 90 seconds to appear while the window stays in front. The diff never changes under a half-written note.

The maintainer's [Refresh](opening-a-local-review.md#refresh) reads the checkout again. When the checkout still matches what the agent prepared, the Review moves to that session at once; when the agent changed more since, Refresh prepares the newer content. Either way every Local draft is carried as Refresh always does. When the agent reverts its change so the checkout matches the current session again and calls `refresh_review`, the answer is `changed: false` and the header drops Updates available.

`refresh_review` accepts one call per Review every 10 seconds; an earlier call is refused `rate_limited` with the milliseconds to wait. On a working-tree Review whose checkout is now on another branch, it is refused `branch_mismatch`, naming the branch the checkout is on.

## Feedback states

`get_feedback` returns each Local draft with its kind (Finding or note), file, side, lines, text, suggestion when it has one, the session it was written against, and a state:

- `current`: written on the Review's current session.
- `unchanged`: the Review moved since, and the lines under the draft are the ones the maintainer saw.
- `changed`: the Review moved since, and the lines under the draft differ from the ones the maintainer saw.
- `needs_attention`: after a move, Patchdesk could not find the draft's lines.
- `applied`: a Finding draft whose suggestion the maintainer applied in Patchdesk.

A page holds at most 25 drafts, and fewer when they are long, so a page stays within what a client accepts in one answer. The answer carries a cursor for the next page. When the drafts change between pages, the next page is refused `stale_cursor` and the agent starts again without a cursor.

The agent does not poll for feedback. The maintainer tells the agent when the notes are ready.

## Notifications

Both notifications go through the same macOS notifications as the rest of Patchdesk and follow the **Send notifications** setting.

- `Agent asks for <Insight>` when an agent records a new request. The body is the Review's source title with its checkout folder, such as `Working tree on feat/467 in patchdesk`, followed by `· <label> profile` when more than one profile exists.
- `<Insight> finished` or `<Insight> failed` when any Insight on a local Review settles. The body is the same source title, then `· requested by the agent` when an agent run request started the run, then the profile when more than one exists.

A notification about the Review the focused window shows is not posted; the Agent requests bar or the Insight tab is the signal there. Clicking a notification opens its Review. Neither notification has buttons: Run and Decline are only in the app.

## What MCP never does

- Start an Insight run without the maintainer's Run, or choose the provider or model.
- Press Apply, Dismiss a Finding, or add, edit, or remove the maintainer's notes.
- Replace a Change intent the Review already holds.
- Commit, push, change a branch, or write the maintainer's index or working-tree files.
- Read or write GitHub, or open a pull request Review.
- Change provider settings or switch the workspace profile.
- Start Patchdesk, or send the agent a message on its own.

## Errors an agent reports

A refused call returns an error code and a sentence the agent can relay. The ones the agent is most likely to meet:

- `app_not_running`: Patchdesk is not running. Start Patchdesk and try again.
- `app_not_responding`: Patchdesk accepted the connection but did not answer within 30 seconds, or answered with something unreadable.
- `no_profile`: no workspace profile is saved. The maintainer finishes setup in Patchdesk first.
- `profile_changed`: the Review belongs to another workspace profile than the active one; the sentence names the active profile. The maintainer switches profile in Patchdesk.
- `rate_limited`: `refresh_review` was called on this Review less than 10 seconds ago; the answer says how long to wait.
- `stale_session`: `run_insight` named a session the Review has moved past. The agent reads the current session from `get_insight` or `review_local` and asks again.
- `stale_cursor`: the drafts changed since the `get_feedback` cursor was issued. The agent reads again from the first page.

Others name their cause: `checkout_not_found` for a directory outside every checkout of the profile's repositories, `repository_not_local`, `not_found` for an unknown Review, `unmerged_index` during a merge conflict, `in_progress` while Patchdesk is already working on that Review, `intent_exists`, `not_applicable` for a pull request Review, and `too_large` for an answer over 4 MiB.

## Known limits

- After the agent commits, a working-tree Review compares the working tree against the new `HEAD`. A clean tree then shows an empty diff, and the maintainer's notes lose their lines and read Needs attention ([#491](https://github.com/kwanpham2195/patchdesk/issues/491)). Review before the agent commits, or open a Branch Review of the agent's branch against its base branch. The Branch Review is a separate Review with its own drafts.
- The client name on the Agent requests bar is what the agent's client reports about itself.

## Variants

The fixed rows, each with the case before and while an agent action runs.

- **Workspace profile and GitHub account.** Before: every call resolves the active profile when it arrives; with none saved it is refused `no_profile`, and a Review of another profile is refused `profile_changed`. The GitHub account is not used. While: a request recorded before a profile switch stays on its Review and shows when the maintainer switches back.
- **Pull request and Review state.** Before: only local Reviews are reachable; a pull request Review is refused `not_applicable`. While: a Review the maintainer moved to a new session drops the older session's waiting requests.
- **GitHub permissions and merge readiness.** Before: no effect. While: no effect; nothing reads or writes GitHub.
- **Network, local tool, and Insight provider availability.** Before: `git` must work; the agent's client must be able to start the `patchdesk` command. While: an approved run needs its provider as any run does, and a failed run reads `failed` in `get_insight`.
- **Input path: mouse, keyboard, or desktop menu.** Before: the agent's calls need no input in Patchdesk. While: Run and Decline take mouse and keyboard; there is no menu or palette entry for a request.

## Cancel and interrupt

- **Cancel, Stop, or Escape.** Before: an agent's request has no cancel; Decline is the maintainer's way to refuse it. While: cancelling the run dialog opened from Run leaves the request waiting; Stop on an approved run stops it as it stops any run, and the request stays approved.
- **Navigate to another Patchdesk screen, Review, Settings section, or workspace profile.** Before: requests and prepared sessions stay on their Review. While: navigating away does not affect a run; a later profile switch makes the agent's next call on that Review answer `profile_changed`.
- **Start another action or request a refresh.** Before: a second `refresh_review` on the same Review while the first still runs is refused `in_progress`. While: the maintainer's own Run of the same Insight approves the waiting request.
- **GitHub, the network, a local tool, or an Insight provider fails or times out.** Before: a `git` failure refuses the call. While: a failed run reads `failed`; the agent can ask again, which needs a new approval.
- **Close Settings, reload the renderer, close the window, or quit Patchdesk.** Before: requests live on the Review record and survive a restart. While: calls made while Patchdesk is closed return `app_not_running`; a run a crash left active reads `failed` after the next start.
- **The pull request, represented revision, pending review, permission, or other target changes elsewhere.** Before: an edit to the checkout reaches the maintainer only through `refresh_review` or their own Refresh. While: a Refresh that moves the Review drops the older session's waiting requests, and a later `run_insight` naming that session is refused `stale_session`.
- **macOS focus, a file or folder picker, or another input path takes control.** Before: a focused window showing the Review silences its notifications. While: no effect on the agent's calls.

## Interactions with other systems

**Workspace profile and identity.** The agent's Review is the same Review the maintainer opens for that checkout and branch from the Local review dialog or the Visited pull requests column, with the same sessions and drafts. Two agents in two linked worktrees get two Reviews.

**Review revision and freshness.** The Review moves to a new session only on the maintainer's Refresh, a reopen, or an Apply. A prepared session is kept by retention while Updates available points at it.

**Local persistence and recovery.** Agent run requests and the prepared session are stored on the Review record and survive a restart. Nothing about the agent is stored outside the Review record except the log lines below.

**GitHub permissions and write authority.** None. The agent's tools make no GitHub read or write.

**Network, local tools, and Insight providers.** The command talks to the app over a socket only the maintainer's macOS user can reach. An approved run uses the provider the maintainer confirmed in the run dialog.

**Concurrent operations and locking.** `refresh_review` reads the checkout outside the Review lock and waits for the lock only to record the prepared session; a second `refresh_review` on the same Review while the first runs is refused `in_progress`. Approving a request happens inside the run's start, under the Review lock, so a Decline cannot land between the approval and the start.

**Feedback, errors, and diagnostics.** The app logs each call to `patchdesk.jsonl` with topic `mcp`, with the tool, the Review, the duration, and the outcome, and never the intent, note text, or file contents. Refused calls also appear in Diagnostics → Review activity. `patchdesk mcp --check` is the first thing to run when a client reports the server as failed.

**Preferences, keyboard commands, and desktop integration.** The run dialog's stored choices prefill Run. The **Send notifications** setting governs both notifications.

**Supported input and accessibility limits.** Mouse and keyboard only, as elsewhere.

## Edge cases

- A `review_local` call on a clean working tree opens a session whose patch is empty.
- An agent that calls `review_local` again after editing gets the Review on its old session; only `refresh_review` reads the new content.
- A `run_insight` for an Insight that the maintainer is already running without a request answers `running` with that run's id and records nothing.
- After an approved run settles, the same `run_insight` records a new request that needs a new approval.
- A request for a session the Review has moved past is dropped; `get_insight` describes the new session, usually with status `none`.
- A draft whose text alone is larger than a page's size limit goes out on its own page, and that page's Markdown points to the entry for the full text.

## Open questions and verification

- Drafted from Patchdesk application source at `21457aee`, the tool manifest in `src/mcp/tool-manifest.ts`, the dispatcher and tools in `src/main/mcp/`, and ADR 0052 with its amendments. The live passes below checked the loop on `3068248c`.
- Live evidence recorded in the pull requests that built the feature, on the dev app with throwaway repositories: #509 (headless Claude Code ran `list_repositories`, `review_local` with an intent, `get_insight`, and `get_feedback`, and read a note the maintainer added), #510 (`refresh_review` showed Updates available; Refresh moved the Review; reverting cleared it), #512 (one request and one notification for two `run_insight` calls; Decline answered `declined` with no second notification), #515 (the bar and the marker; Run with the Codex CLI account and `gpt-6-luna` completed; Decline removed both), and #517 (a second, different intent answered `intent_exists` and left the first in place).
- Live pass on 2026-09-26 over CDP 9233 (ADR 0052 slice 5b, Claude Code): headless `claude -p` 2.1.283 with `--model sonnet` and `--strict-mcp-config` on the dev shim, in a throwaway checkout, given the user guide's "Review in Patchdesk" block and a task to add `initials(fullName)` to `text.ts`. Turn 1 edited the file, called `review_local` with the task as intent and `run_insight` for Analysis, got `awaiting_approval`, and stopped saying the request waits in Patchdesk. After the column re-read, the row showed `agent`; the Insights tab showed `Agent requests · Personal profile` with `Analysis · claude-code · asked 40s`. Run prefilled the Codex CLI account and `gpt-6-luna`; the Analysis returned P2 `Astral letters produce incorrect initials` and the marker cleared. The maintainer's note on line 9 read `current`. Turn 2 ("The Analysis ran. check Patchdesk", same session) called `get_insight` and `get_feedback`, changed the line to `Array.from(word)[0]`, and called `refresh_review` (`changed: true`). Updates available appeared at the next check, and Refresh moved the Review to `1e0fbf37` with the note reading `Changed since your note` (`changed` in `get_feedback`). Evidence: `/tmp/patchdesk-mcp5b/claude/`.
- Live pass on 2026-09-26 over CDP 9233 (ADR 0052 slice 5b, Codex): `codex exec` 0.157.1 with `-m gpt-6-luna`, the server given as `-c mcp_servers.patchdesk.*` overrides with `default_tools_approval_mode="approve"`, `config.toml` unchanged, and the same block and task. The first call stopped before editing on a workspace-routing rule in the maintainer's global `AGENTS.md`; after that was answered in the same session, Codex edited, called `review_local` and `run_insight`, and stopped at `awaiting_approval`. The bar named the client `codex-mcp-client`. The Analysis returned no Findings. The maintainer's note on line 1, the doc comment, read `current`. Turn 2 called `get_feedback`, rewrote the doc comment, and called `refresh_review`: one call with a mistyped id answered `not_found`, and the retry answered `changed: true`. Codex did not call `get_insight` although told the Analysis ran. After Refresh the note read Needs attention (see Edge cases). Evidence: `/tmp/patchdesk-mcp5b/codex/`.
- In both passes neither agent committed: `git log main` held only the initial commit. `patchdesk.jsonl` logged `desktop-notification` `shown` with `AgentRunRequested` and `InsightSettled` for each Review, and one `mcp` line per call. The screen was locked, so input went through CDP and no notification banner was seen. Decline (MCP-05), two `run_insight` calls in a row, and Codex on the 2026-07-28 MCP revision were not run in this pass.
- Not observed live: the focused-window silence for `Agent asks for` and the banner text of `<Insight> finished` on a local Review (#496). The 2026-09-26 passes logged the settled notification as shown. Service and notifier tests cover both.
- A new Review that `review_local` creates appears in the Visited pull requests column the next time the column reads; whether it should appear at once is not settled.
- The page lists variants and interrupts as bullets rather than the template's tables, and walks the loop as numbered steps rather than a state diagram.

Verified against Patchdesk application source commit `21457aee`.
