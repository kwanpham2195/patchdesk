# Project a bounded Codex activity trace

> **Status: Accepted.** Issue #243. Amends the "raw provider events are not
> projected" boundary in the Brief and Analysis product descriptions. The
> authority boundary of ADR 0013 is unchanged.

A Brief, Walkthrough, or Analysis runs for minutes, and until this decision the
running panel showed a spinner, a start time, and nothing else. A run that had
been silent for eight minutes looked the same as one that had died, and the
only way to find out was Stop, which spends the provider account again. The
Codex app server already streams what separates the two: `item/started` and
`item/completed` for each command it runs, and reasoning summary deltas.
Patchdesk dropped all of them.

## The decision

A Codex CLI account run projects a small activity trace on the existing
500 ms run poll, `GET /v1/reviews/insights/runs/:runId`, as an optional
`activity` object beside `status`:

- `phase`: `preparing` until Patchdesk asks Codex to start the turn, then
  `turn`. Model discovery, thread start, and prompt preparation are the
  `preparing` gap.
- `reasoningLine`: the last non-empty line of the current reasoning item's
  summary, with Markdown heading and bold markers stripped, the same rule the
  Codex TUI uses for its status header. It is absent when no summary arrived.
- `commands`: one row per command, keyed by Codex's item id and updated in
  place when the command completes: the command, its status (`in_progress`,
  `completed`, `failed`, `declined`), and the exit code and duration when Codex
  reports them.
- `approvals`: how many command approval requests Patchdesk accepted and
  declined in the run (#240), as two counts with no command text.

What is not projected: prompts, the agent message stream, raw notifications,
and command output. `aggregatedOutput` is unbounded worktree output that the
panel does not show, so the Codex mapper drops it before the event exists.

Bounds apply where the notification is parsed, not where it is rendered. The
mapper (`src/adapters/codex/codex-activity.ts`) cuts a command to 200
characters, rewrites the represented worktree path as relative and the home
directory as `~` first, so neither absolute path crosses into the renderer, and
drops an item id over 256 characters. The buffer keeps at most 200 rows and a
4096-character reasoning tail. The renderer's `insightRunActivitySchema` is a
strict schema with the same limits, so an over-long snapshot fails the poll
closed instead of rendering. The command string is untrusted model output
(#240) and renders as plain text with no styling that implies Patchdesk checked
it.

The caps come from a measured run on 2026-09-17 with `gpt-5.6-luna` at high
effort: a Walkthrough produced 170 notifications and no command, an Analysis
produced 959 notifications (peak 68 per second, almost all agent message
deltas the trace ignores) and one 94-character command, and neither produced a
reasoning summary delta. The 200-row and 4 KB defaults stand, events are
appended one at a time with no batching, and on that model the reasoning line
is simply absent.

The trace is in memory only. `InsightRunCoordinator` keeps one buffer per
profile, Review, and Insight type, answers a poll from it only when its run id
matches the polled run, replaces it when the next run for that key starts, and
clears the map in `recoverAll`. It is never written to the Insight record:
`parseInsightRecord` is a strict schema (ADR 0022), and a run cannot outlive the
process that ran it. The buffer outlives the run's `Active` entry, so a
timed-out or stopped run still answers its last poll with the trace, and the
renderer keeps that last trace under the failure notice.

`InsightInvoker.invoke` takes `onActivity` in the options bag that already
carries `signal`. The Codex client calls it synchronously from its RPC listener
and never awaits it, and a callback that throws loses its trace without failing
the turn. The buffer's `append` only mutates; the line scan happens once per
poll in `snapshot`, because reasoning deltas arrive per token.

## Consequences

- An API key (Pi) run keeps today's panel. Its child writes one result at exit
  with no incremental boundary, so the coordinator creates no buffer for it
  and its poll carries no `activity`.
- `InsightRun.status = "running"` stays declared and unwritten. Writing it from
  a streaming callback would mean a disk write under the Review lock racing
  `persistTerminal`, for a value nothing reads.
- The trace is lost when Patchdesk restarts, and the renderer drops a failed
  run's trace when it reloads, since it stops polling once the run settles.
- A reasoning line appears only on models and efforts that send reasoning
  summaries. There is no capability field to check in advance, so the panel
  treats an absent line as normal.
