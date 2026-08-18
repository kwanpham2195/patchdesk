AGENTS.md

## Delegate to subagents

The main session reviews and delegates. It decides what to do, hands the work
to subagents on the `sonnet` model, reviews what comes back, and reports.
It does not carry out the work itself.

Delegate:

- Scouting and research: locating code, mapping a subsystem, reading docs,
  gathering evidence before a change.
- Edits: applying a change once its shape is known, including mechanical
  cleanups such as lint findings, refactors, and test updates.
- Verification: typecheck, test suites, builds, and the commit gate.
- Live testing: every `agent-browser` interaction against the running app
  (CDP 9233) — snapshots, clicks, screenshots, console and network reads —
  following `.agents/skills/patchdesk-electron-tester/SKILL.md`.

Give each subagent the file paths, constraints, and verification commands it
needs. Treat its report as a claim, not a result: review the diff, and send it
back or delegate an independent check when the claim is load-bearing. Nothing
is reported as done on a subagent's word alone.

### One bite-size task per subagent

Hand over one small, self-contained step — never a whole multi-step plan.
Decompose the work first, delegate a slice, review it, then brief the next
slice with what you learned. A subagent handed a long plan swallows it whole:
whole-plan runs burned 400-800k tokens each, and the first review landed only
after everything was built, so a wrong turn early was discovered late.

When a plan rests on an assumption nothing in the codebase has done before,
spike it first with a read-only task. Settling one such unknown cost 44k
tokens and 73 seconds; guessing wrong would have reshaped the code written
on top of it.

### Working-tree rules

- No git worktrees. Subagents work directly in the main checkout.
- Therefore only one *writing* subagent at a time — concurrent edits to one
  working tree corrupt each other. Read-only scouting and spikes may overlap.
- Subagents must not spawn subagents or forks of their own. State this in
  every brief. Watch for `fork` entries you did not create, stop them, and
  treat anything they touched as half-applied until re-read and re-verified.
