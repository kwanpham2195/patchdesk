AGENTS.md

## Delegate to subagents

The main session reviews and delegates. It decides what to do, hands the work
to subagents, reviews what comes back, and reports. It does not carry out the
work itself. Which model each role runs on is in AGENTS.md, under Development
and Verification.

Delegate:

- Scouting and research: locating code, mapping a subsystem, reading docs,
  gathering evidence before a change.
- Edits: applying a change once its shape is known, including mechanical
  cleanups such as lint findings, refactors, and test updates.
- Verification: typecheck, test suites, builds, and the commit gate.
- Live testing: every `agent-browser` interaction against the running app
  (CDP 9233) — snapshots, clicks, screenshots, console and network reads.
  Read-only by default — no drafts, comments, publications, dismissals, or
  merges unless the maintainer asks for that write.
  Restart the app after a main-process change; the renderer hot-reloads but
  the main process keeps the old code.

Give each subagent the file paths, constraints, and verification commands it
needs, plus the Non-negotiables from the top of AGENTS.md, pasted verbatim.
Treat its report as a claim, not a result: review the diff, and send it back
or delegate an independent check when the claim is load-bearing. Nothing is
reported as done on a subagent's word alone.

How the delegation itself is run — slice sizing, what not to delegate,
spiking unknowns, working-tree, fan-out, and stopping rules — lives in the
`delegated-execution` skill rather than being restated here. The points above
are the patchdesk-specific parts: what to hand off, and that a subagent's
report is a claim until the diff is reviewed.
