# Let a terminal coding agent use Patchdesk as its review desk over MCP

> **Status: Accepted** (2026-09-26, maintainer in chat, for issue #463,
> including every recommendation in "Accepted recommendations"). Builds on
> ADR 0050 (local sources, identity, Local
> snapshot, Apply) and ADR 0051 (review-only purpose, Local drafts as
> feedback, Change intent). ADR 0035, 0044, 0047 and the invariants in
> `docs/architecture.md` are unchanged: the main process stays the single
> authority, and the Insight runtime still installs no MCP client (that rule
> is about the model child, not this server). Every section records
> decisions made in chat on 2026-09-25 and 2026-09-26. Terms in bold
> are defined in `CONTEXT.md`.

ADR 0051 made local review a loop between a maintainer and a coding agent:
the agent edits the working tree, the maintainer reads the diff with the
three **Insights**, writes **Local drafts**, and hands them back. Today the
hand-back is a clipboard. The maintainer presses **Copy as agent prompt**,
pastes into the agent's terminal, waits, and presses Refresh. The agent never
opens the **Review**, cannot ask for an **Analysis** against the spec it was
given, and cannot tell whether a note is about the code it has now.

The loop as it should run. The maintainer starts Claude Code in
`~/src/patchdesk` and says "implement #467, then get it reviewed in
Patchdesk". The agent edits, then calls `review_local` with its working
directory and the task text. Patchdesk opens **Working tree on
feat/467-change-intent** with an "agent" marker in the sidebar, records the
text as the **Change intent**, and returns the session id and changed files.
The agent calls `run_insight(analysis)`; a notification says an agent asks for
Analysis on that Review; the maintainer opens it and presses Run. The agent
polls `get_insight` and reads two P2 Findings. The maintainer adds a note on
line 12 and tells the agent "check Patchdesk". The agent calls
`get_feedback`, fixes both, and calls `refresh_review`; the header shows
"Updates available", and the maintainer's Refresh moves the Review and
carries the note as **unchanged** or **changed since your note**. Nothing in
that run pressed Apply, committed, or spent the provider account without a
click in the app.

## The decision

### Purpose and limits

Patchdesk is the code review desk for a terminal coding agent. The MCP server
is review-only: it opens and refreshes local Reviews, requests Insights, and
reads results and feedback. It performs no git write; Apply stays a button in
the app, and the maintainer stays the reviewer. The agent reads what the
maintainer drafted or wrote and never posts a review of its own. Delegation
mode (the agent submits its own Analysis) is cut, not deferred.

### Protocol and SDK (verified 2026-09-26)

Patchdesk targets the stateless revision, 2026-07-28, with the v2 TypeScript
SDK, and serves the 2025-era handshake from the same code for clients that
still send it.

- 2026-07-28 removes protocol sessions and `Mcp-Session-Id`, removes the
  `initialize` handshake, carries the protocol version and client
  capabilities in each request's `_meta`, and requires `server/discover`,
  which clients "MAY call ... as a backward-compatibility probe on STDIO"
  (modelcontextprotocol.io/specification/2026-07-28/changelog).
- The v2 SDK is `@modelcontextprotocol/server` 2.1.0, with `client`, `node`,
  and `core` at the same version (npm, 2026-09-23; `engines.node >= 20`).
  `@modelcontextprotocol/sdk` 1.30.1 is the v1 line; its
  `LATEST_PROTOCOL_VERSION` is `2025-11-25`.
- Stdio on 2026-07-28 is `serveStdio(factory, options)` from
  `@modelcontextprotocol/server/stdio`: the opening exchange selects the
  connection's era, one factory instance is pinned per connection, and
  `legacy: 'serve'` (the default) serves a 2025-era opening "exactly as a
  hand-wired stdio server serves it today". A hand-wired
  `McpServer.connect(transport)` serves only the 2025 era
  (ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28). One
  factory serves both eras; no pin, no second build.
- Claude Code (2.1.283 installed) runs the v2 runtime by default from 2.1.274
  in sessions that do not fetch feature flags and from 2.1.232 in sessions
  that do. On v2 it asks HTTP servers for the newer revision but "connects
  to every other server as v1 does"; to have it ask stdio servers, set
  `MCP_PROTOCOL_NEGOTIATION=auto` (code.claude.com/docs/en/mcp, "MCP client
  runtimes"). Tool results warn at 10,000 tokens and cut at 25,000 by
  default.
- Codex CLI (0.156.1 installed) is legacy by default: feature
  `mcp_2026_07_28` is `Stage::UnderDevelopment`, `default_enabled: false`
  (`codex-rs/features/src/lib.rs`); a stdio server gets the modern lifecycle
  only when that feature is on and the server's configured `env` carries
  `CODEX_MCP_PROTOCOL_VERSION=2026-07-28`
  (`codex-rs/rmcp-client/src/protocol_mode.rs`, `stdio_mode`). Otherwise it
  sends `initialize` at 2025-06-18. openai/codex#33952 is open.
- The client SDK's `versionNegotiation.mode` defaults to `'legacy'`; `'auto'`
  probes with `server/discover` and on stdio treats silence as a legacy
  server (`@modelcontextprotocol/client` 2.1.0 typings).

Both clients work today with no flag, on the 2025 era; a client moved to the
modern era by its own flag keeps working because the era decision is per
connection. The ADR asks the maintainer to set no client flag; the user guide
names the two flags for readers who want the modern era.

### Transport: a stdio shim over a Unix socket

`patchdesk mcp` is a small stdio process the client spawns. It is the MCP
endpoint: it runs `serveStdio` with the six tools registered, and each tool
handler forwards one call. It opens one connection to the running app's Unix
domain socket, writes one JSON line `{ tool, arguments }`, reads one JSON
line back, and returns it as the tool result. The app side is a `net.Server`
in the main process that parses the line with the tool's schema, calls the
service, and writes the serialized `Result`. No MCP SDK runs in the app.

- **Socket path.** `<dataDirectory>/mcp/patchdesk.sock`, so
  `~/.local/share/patchdesk/mcp/patchdesk.sock` (`PatchdeskPaths.default()`),
  in a directory created `0700`, `chmod 0600` right after `listen`. The shim
  computes the same path from the same module. `PATCHDESK_MCP_SOCKET`
  overrides it on both sides; `pnpm dev` sets it to
  `<dataDirectory>/mcp/patchdesk-dev.sock`, so the dev app and an installed
  app are both reachable (they share the data directory). The main process
  reads the variable when it starts the listener, after the login-shell
  import has settled (ADR 0038).
- **No port, no token.** A socket in a `0700` directory is reachable only by
  the same user, which is what a per-launch token on loopback HTTP would
  have re-established. Loopback HTTP is rejected: a browser tab can POST to
  `127.0.0.1`, so it needs Origin and Host validation plus a token the agent
  must be handed.
- **Stale socket.** At start the app connects to the path: a refused
  connection is a stale file, unlinked before listening; a live one is
  another instance, logged and left alone (the single-instance lock makes
  this a dev-only case).
- **App closed.** The shim starts and lists its tools whether or not the app
  runs. A call that cannot connect returns the tool error `app_not_running`
  ("Start Patchdesk and try again"). The shim never launches the app. Since
  every call connects afresh, an app restart mid-session needs no client
  reconnect.
- **Bounds.** One request per connection. Request lines over 256 KiB and
  responses over 4 MiB are refused `too_large`; connect and read time out at
  30 s, the desktop bridge's bound. No tool waits on a human or a model.

### One implementation for the UI and MCP

Every tool is a thin adapter over the service method the local API route
calls. No validation, decision, or result shaping lives in MCP code or in the
renderer that a tool needs. The first PR is a transport-neutral refactor with
no behaviour change:

1. Each request schema moves out of `src/main/routes/*` to sit beside its
   service. The route parses with it; the shim derives the tool's JSON
   Schema from the same Valibot schema with `@valibot/to-json-schema` 1.8.0.
2. One failure-reason table per service. The route maps reasons to HTTP; the
   tool maps the same reasons to tool errors. `localReviewResponse` in
   `http-status.ts` is the first such table.
3. `get_insight` and `get_feedback` read through the projection the
   workbench reads, so the agent and the UI never disagree on dismissed,
   drafted, or applied Findings, or on a draft's carry state.
4. The context pack drops its own title copy and uses `reviewSourceTitle`
   from `src/domain/review-source.ts` (#495; the prompt rewording it brings
   is reviewed in chat).

The dispatcher is a table `toolName -> { schema, call }` in `src/main/mcp/`;
the shim registers names, descriptions, and schemas from
`src/mcp/tool-manifest.ts`. One test asserts the two tables name the same
tools; one test per tool asserts it returns what its route returns.

### Tools, v1

All tools act on the active workspace profile; a `reviewId` from another
profile is refused `profile_changed`. Every result that describes a session
carries `reviewId`, `sessionId`, `headSha`, `baseSha`, and `patchHash`, so
the agent can tell which code a Finding or note is about (ADR 0012).

- `list_repositories()` → the profile's repositories with a `localPath`,
  each with its configured **Checkout** and live linked worktrees (cache
  worktrees excluded, #489) and the branch each is on. No GitHub read.
- `review_local(cwd, source?, intent?)` → opens or reuses the local Review
  for the checkout containing `cwd`, resolved to its worktree top-level;
  else `checkout_not_found`. `source` defaults to `working_tree`; `branch`
  and `commit` take the dialog's fields. `intent` is Markdown text, recorded
  only when the Review has none: the same text returns `intentKept: true`, a
  different one is refused `intent_exists`. Returns the session description,
  the changed files with status and line counts, `title`
  (`reviewSourceTitle`), and whether retained Insights exist. Refusals:
  `repository_not_local`, `checkout_not_found`, `unmerged_index`,
  `revision_not_found`, `in_progress`, `storage`.
- `refresh_review(reviewId)` → the prepare-only form under **Accepted
  recommendations**.
  Refusals: `not_found`, `branch_mismatch` (names the branch),
  `in_progress`, `rate_limited`, `unmerged_index`, `storage`.
- `run_insight(reviewId, sessionId, type)` → records an **agent run
  request** for `analysis`, `walkthrough`, or `brief` and returns at once
  with `awaiting_approval` and a `requestId`. A stale session is refused
  `stale_session`; a type already running or requested for that session
  returns the existing id and status; a declined one returns `declined`.
  The tool has no provider, model, or effort field. It does not block on
  the maintainer: Codex's default tool timeout is 60 s (`tool_timeout_sec`,
  learn.chatgpt.com/docs/extend/mcp) and an approval can take an hour.
- `get_insight(reviewId, type)` → `awaiting_approval`, `declined`, `queued`,
  `running`, `completed`, `failed` (with the `InsightFailure` reason), or
  `none`; the revision it describes; on `completed` the validated retained
  record: Findings (id, severity, title, explanation, `path:line`, verified
  suggestion, `dismissed`, `drafted`, `applied`) and summary for Analysis,
  the `renderBriefAsPullRequestDescription` Markdown for Brief, chapters for
  Walkthrough. A result for an earlier session carries `outdated: true`.
- `get_feedback(reviewId, cursor?)` → the paged form under **Accepted
  recommendations**.
  Refusals: `not_found`, `not_applicable` (a pull request Review).

Never exposed: Apply, Dismiss, adding, editing, or removing the maintainer's
notes, provider settings, profile selection, and pull request Reviews. v2
candidates (`reply_to_note`, `add_agent_note`, `cancel_insight`) are decided
after a week of real use.

### Per-run approval in the app

An agent run request never spends the provider account by itself. It is
stored on the Review record (`agentRunRequests`, keyed by session and type,
with `requestedAt` and the client's `_meta` name when present) and posts one
notification through the ADR 0044 port: "Agent asks for Analysis · Working
tree on feat/467 in patchdesk", naming the profile when more than one is
configured. Clicking it opens the Review, whose Insights tab shows an **Agent
requests** bar with **Run** and **Decline** per request. Run opens the
ordinary run dialog with the type fixed and the stored provider, model, and
effort prefilled; confirming starts the run through
`InsightRunCoordinator.start` with the same revalidation, Review lock, and
one-run-per-type rule the Run button has, and marks the request `approved`
with its `runId`. Decline marks it `declined`. The notification has no
action buttons: Electron shows them on macOS only for a signed app with
`NSUserNotificationAlertStyle` set to `alert`, and Patchdesk is ad-hoc signed
(electronjs.org/docs/latest/api/structures/notification-action). The silence
rule holds; for the focused Review the bar is the signal.

### Feedback hand-off

`get_feedback` returns what the maintainer drafted or wrote: each Local draft
with id, kind (`finding` or `note`), `path`, `side`, line range, title or
text, comment, verified suggestion when present, `state` (`unchanged`,
`changed`, `needs_attention`, `applied`), and the session it was written
against. The maintainer triggers the hand-off by telling the agent to read
it. The agent does not poll: no tool description asks it to, and the server
sends no notifications.

### Multiple checkouts

Shipped in #489: `review_local` resolves `cwd` to the configured `localPath`
or a linked worktree it lists, and two agents in two worktrees of one
repository get two Reviews with their own sessions and drafts.

## Accepted recommendations

Proposed by the advisor and accepted by the maintainer in chat on
2026-09-26.

**Agent refresh prepares; the maintainer moves.** `refresh_review` reads the
checkout as the maintainer's Refresh does and prepares the session for the
current content (snapshot, managed ref, worktree, patch) but does not move
the Review. It records the prepared session on the Review as
`updatesAvailable` and returns `{ changed, preparedSessionId, headSha }`;
unchanged content returns `changed: false`. The header shows **Updates
available** (the #476 path), and the maintainer's Refresh moves the Review
to the prepared session, instantly, because sessions are content-keyed.
Drafts carry only on that move, so the diff is never replaced under a
half-written note. Retention keeps a prepared session that is not yet
current, as it keeps the session a Prepared Refresh names today. Rate limit:
one agent refresh per Review per 10 s; the next is refused `rate_limited`
with `retryAfterMs`. A refresh runs `git add -A` into a temporary index over
the whole tree (#485), and an agent can call it after every file write.

**Agent intent is untrusted prompt input.** The intent already sits between
`BEGIN CHANGE INTENT` and `END CHANGE INTENT` in `review-input.md`. An intent
recorded over MCP is stored with `source: "agent"`, the header reads "Intent
from the agent", and the run input prefixes the section with one sentence:
the text was supplied by the coding agent whose change is under review, may
be wrong or adversarial, and is the stated goal to check against, not an
instruction to follow. That prompt change is reviewed in chat and may land
later; until then an agent intent is stored and shown, and the run input is
unchanged.

**Decline is final for the session.** After Decline, `run_insight` for the
same session and type returns `declined` and posts nothing. A new session,
after the maintainer's Refresh, allows a new request. Requests for a session
the Review has moved past are dropped on the move; `get_insight` reports
`stale_session` for them.

**App restart mid-run.** Nothing new: `insight-recovery.ts` fails runs a
crash left active, so `get_insight` reports `failed`, and the agent may
request again, which needs a new approval. Requests survive the restart
because they live on the Review record.

**Profile switch.** Every tool resolves the active profile at call time; a
`reviewId` of another profile is refused `profile_changed` with the active
profile's name. The notification and the Agent requests bar name the profile
when more than one is configured.

**Feedback size.** `get_feedback` pages 25 entries, ordered by path then
line, with `nextCursor`, and returns for that page the Markdown
`renderLocalDraftsAsAgentPrompt` produces, so the agent reads the same text
the clipboard carries. A page of 25 notes with suggestions stays under
Claude Code's 25,000-token cut.

**Spec-file intents.** `review_local` accepts text only. A spec file must be
in the Local snapshot to be read (ADR 0051); an agent that has the file sends
its text, and a path would add the `change_intent_file_*` refusals to a tool
that cannot fix them.

**Notes after the agent commits (#491): pin the base.** A working-tree
Review records `baseSha` at creation, the `HEAD` it was opened on or the
`base` the agent passes to `review_local` (the commit it started from), and
every later session diffs the Local snapshot against that base instead of
the current `HEAD`, so the agent's commits stay in the diff and the notes
stay inline. Identity is unchanged (branch and checkout); only how
`working_tree` resolves `baseSha` changes. The header reads "against <short
sha>" and offers **Set base to HEAD**, a move to a new session with drafts
carried. A base that is no longer an ancestor of `HEAD` (rebase, reset)
refuses Refresh with `base_not_ancestor` and names that control. The other
option, carrying drafts into the branch Review when the tree is clean, needs
a cross-Review carry and a guessed base branch, and still loses the notes on
the first commit of a partly committed tree.

**Settled notification for local runs (#496).** The notification subject
becomes a pull request reference or a local source title
(`reviewSourceTitle` plus the checkout folder), so `InsightSettled` posts
"Analysis finished · Working tree on feat/467 in patchdesk"; an
agent-approved run adds "requested by the agent". The silence rule is
unchanged.

**Sidebar marker.** The local row shows "agent" while the Review has an
`awaiting_approval` request or an active run an agent requested, and drops it
when the last request is settled or declined. A state marker, not a count.

## Error model

Services return `Result<T, { reason }>`. Each reason table maps to one HTTP
status in the route and one tool error in the dispatcher:

- Invalid arguments never reach a service: the shim validates with the
  derived JSON Schema (JSON-RPC `-32602`) and the app re-validates with the
  Valibot schema (`invalid_input`); a disagreement is a bug a test catches.
- Amended 2026-09-26 (slice 2): the v2 SDK does not answer bad arguments
  with JSON-RPC `-32602`. It returns a tool result with `isError: true` and
  an "Input validation error…" text block; the app's `invalid_input`
  re-check is unchanged.
- A service refusal is a tool result with `isError: true`,
  `structuredContent: { error, message, retryAfterMs? }`, and one text block
  with the same message, so both eras and both clients show it. `error` is
  the service's own reason plus the four the MCP layer adds:
  `app_not_running`, `profile_changed`, `rate_limited`, `too_large`.
- Amended 2026-09-26 (slice 2): the shim adds a fifth, `app_not_responding`,
  when it connects but gets no reply within 30 s, the connection closes
  first, or the reply is malformed. `app_not_running` stays the connect
  failure.
- Amended 2026-09-26 (slice 3): every tool refuses `no_profile` when no
  workspace profile is saved. Tools read the saved profiles and never run
  the first-run `gh` account detection, which may save one.
- Amended 2026-09-26 (slice 3): `get_feedback` refuses `stale_cursor` when
  the drafts changed since the cursor was issued (start again without a
  cursor), and `invalid_input` for a cursor Patchdesk did not issue.
- `in_progress` means the Review lock is held; the message says to retry
  when it finishes, as the UI does.
- A tool never returns a stack, a path outside the checkout, or another
  Review's intent text.

## Logging and diagnostics

The app logs topic `mcp` to `patchdesk.jsonl`: `listening` with the socket
path, `tool called` with tool, `reviewId`, duration, and outcome (`ok` or
the reason), `refused` for `too_large` and parse failures, and `stale socket
removed`. Intent text, note text, and file contents are never logged. Refused
and failed calls also go through `review-diagnostic-service.ts`, so Settings
→ Data & recovery lists them. The shim writes only to stderr (stdout is the
protocol), one line per failed connect or malformed response;
`PATCHDESK_MCP_DEBUG=1` adds one line per call. `patchdesk mcp --check`
connects, calls `list_repositories`, prints the socket path and result, and
exits non-zero when the app is not running; it is the first thing to run
when a client reports the server as failed.

## Test strategy

- **Tool contracts, in process.** A `Client` from `@modelcontextprotocol/
  client` over `StreamableHTTPClientTransport` with its `fetch` option
  pointed at `createMcpHandler(factory).fetch` serves the 2026-07-28 era with
  no port; `InMemoryTransport.createLinkedPair()` against `McpServer.connect`
  covers the 2025 era. Both drive the shim's factory. Each tool has one test
  asserting it returns what its route returns, on real services, temporary
  directories, and real git, as `tests/services/local-review-opening.test.ts`
  does. The v2 docs have no in-memory entry for the modern era; the fetch
  path is their recommended substitute.
- **Socket and shim.** `tests/main/mcp-socket.test.ts` starts the app-side
  listener on a temporary socket, spawns the built shim with
  `PATCHDESK_MCP_SOCKET`, and drives it with `StdioClientTransport` in both
  negotiation modes, covering the stale-socket rule, `app_not_running`,
  `too_large`, and the 30 s bound.
- **Protocol.** `npx @modelcontextprotocol/inspector --cli patchdesk mcp
  --method tools/list` and one `tools/call` per tool, in both eras the
  Inspector negotiates (modelcontextprotocol.io/docs/2026-07-28/tools/
  inspector, Node 22.19+). Recorded in the PR body, not run in CI.
- **Live end to end.** In a herdr pane, `claude -p --mcp-config
  /tmp/patchdesk-mcp.json --strict-mcp-config "review this change in
  Patchdesk"` against the dev app on CDP 9233, with screenshots of the agent
  marker, the Agent requests bar, the approval, the Findings, a note, and
  Updates available after the agent's refresh. Codex is the second client:
  `codex exec` with the server in `config.toml`, once legacy and once with
  `mcp_2026_07_28` plus `CODEX_MCP_PROTOCOL_VERSION=2026-07-28` in the
  server's `env`. Insight runs use `gpt-6-luna` on the Codex CLI account
  provider, picked in the run dialog (AGENTS.md). The client sessions spend
  the maintainer's Claude and Codex accounts, so the loop runs once per
  client per slice that changes it, not per commit.

## Packaging

The shim is a second main-process input in `electron.vite.config.ts`, built
to `out/main/mcp-shim.js` with `@modelcontextprotocol/server` bundled, and
staged through `extraResources` beside the Insight runtime as
`Contents/Resources/mcp-shim/index.js`, outside the asar. A launcher at
`Contents/Resources/bin/patchdesk` runs `ELECTRON_RUN_AS_NODE=1
Contents/MacOS/Patchdesk Contents/Resources/mcp-shim/index.js "$@"`, so the
shim uses the Node the app ships. The cask adds
`binary "#{appdir}/Patchdesk.app/Contents/Resources/bin/patchdesk"`, which
links into `$(brew --prefix)/bin` (docs.brew.sh/Cask-Cookbook, `binary`); a
`.dmg` install documents the same `ln -s`. `patchdesk` alone prints usage;
`mcp` and `mcp --check` are the only subcommands. Package smoke runs
`patchdesk mcp --check`. In development, `pnpm mcp:shim` runs
`node out/main/mcp-shim.js` with the dev socket. The user guide shows:

```
claude mcp add patchdesk -- patchdesk mcp
codex mcp add patchdesk -- patchdesk mcp
```

## Slices, in order

1. **Transport-neutral refactor.** Schemas beside services, one reason table
   per service, projection-backed reads, `reviewSourceTitle` in the context
   pack (#495, wording reviewed in chat). No behaviour change.
2. **Socket and shim.** The listener, the dispatcher with
   `list_repositories` only, the shim, `--check`, the launcher, the cask
   `binary`, the dev socket. Inspector pass in both eras.
3. **Read tools.** `review_local`, `refresh_review` (prepare-only),
   `get_insight`, `get_feedback` with paging. Live pass with Claude Code.
   Refused and failed calls also recorded through
   `review-diagnostic-service.ts` (deferred from slice 2, which only logs
   them).
4. **Requests and approval UI.** `run_insight`, the request record, the
   notification, the Agent requests bar, the sidebar marker, the local
   settled notification (#496). Live pass with both clients.
5. **Docs.** `docs/product-description/pull-requests/coding-agent-over-mcp.md`,
   the user guide, `CONTEXT.md` (agent run request, prepared session),
   `docs/architecture.md` (`src/main/mcp/`, the shim), CHANGELOG.

The pinned base (#491) and the intent prompt sentence follow as their own
PRs, each behind its own chat review.

## Consequences

- A third process, the shim, ships in the bundle and holds the only MCP SDK
  dependency. The main process gains one socket listener and no HTTP
  surface.
- The Review record gains `agentRunRequests`, `updatesAvailable`, and
  `changeIntent.source`; stored records without them parse unchanged.
- `refresh_review` prepares sessions the Review has not moved to; retention
  and the per-move prune treat a prepared session as live.
- Every request schema has one home and two consumers; a tool that needs a
  field the route lacks is a service change.
- Agent-supplied text enters the Analysis prompt; until the prompt sentence
  lands, it is checked with the same words as a maintainer's.
- Both clients reach the shim on the 2025 era by default; the modern era is
  opt-in per client and free on the server side. The model child is
  unchanged.

## Rejected alternatives

**Streamable HTTP on loopback.** Reachable from any browser tab; needs Host
and Origin validation plus a token the agent must be handed and store.

**A byte relay for a shim, SDK in the main process.** Fewer lines, but a
closed app is a failed server with no tools, and an app restart drops the
client's connection; per-call forwarding gives an error the agent can act on
and survives restarts.

**Blocking `run_insight` until Run or Decline.** Hits Codex's 60 s tool
timeout and holds a connection on a human's decision.

**A budget rule instead of per-run approval.** Lets an agent loop spend the
account without a click.

**Letting the agent overwrite the Change intent.** The intent is what the
maintainer wants checked; an agent that rewrites it can hide a goal it
missed.

**Delegation mode (`submit_insight`).** A self-review by the author is not
the review this desk is for.

**A `patchdesk` npm package for the shim.** A second artefact to version and
a system Node to depend on; the bundled launcher matches the app's schemas
by construction.
