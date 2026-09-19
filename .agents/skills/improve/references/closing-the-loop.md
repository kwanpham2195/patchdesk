# Closing the Loop — execute, reconcile, issues

The advisor's job doesn't end at the plan. This file covers the three follow-through flows: dispatching an executor and reviewing its work (`execute`), keeping the plan backlog alive (`reconcile`), and publishing plans where work gets picked up (`--issues`).

The founding rule survives unchanged: **the advisor never edits source code.** In `execute`, a _separate executor subagent_ edits code in an isolated git worktree; the advisor dispatches, reviews, and renders a verdict — like a tech lead who doesn't push commits to your branch.

---

## `execute <plan>` — dispatch and review

### Preconditions (check all before dispatching)

- The repo is a git repository (worktree isolation requires it). If not: stop and say so.
- The plan file exists and its dependencies show DONE in its authoritative plan index or workspace work-item checkpoint. If not: stop and name the missing dependency.
- Run the plan's drift check yourself. If in-scope files changed since `Planned at`, reconcile the plan first (see below) — don't hand a stale plan to an executor.

### Dispatch

Before dispatch, read `~/.agents/skills/delegated-execution/SKILL.md` and its model policy. The skill owns delegation authority, brief and recovery requirements; model policy selects the implementation model and concurrency cap; the native harness owns launch and failure protocol. Dispatch one executor only in an isolated worktree. If that launch is unavailable, stop and report; do not fall back to another execution mode.

The subagent prompt must contain:

1. **The full plan file text, inlined.** The worktree contains only committed files — if the plan is uncommitted, the executor cannot read it. Never assume; always inline.
2. Applicable repository instructions or readable absolute paths, required absolute skill paths, the task's exact authority boundary, and an explicit prohibition on further delegation.
3. The executor preamble:

> You are the executor for the implementation plan below. Follow it step by
> step. Run every verification command and confirm the expected result before
> moving on. Touch only the files listed as in scope. If any STOP condition
> occurs, stop immediately and report. Do not improvise around obstacles.
> Commit your work in the worktree following the plan's git workflow section.
> One override: SKIP the plan's instruction to update its plan index — your reviewer maintains the authoritative record. Before reporting, audit every claim in
> your report against an actual tool result from this session — only report
> what you can point to evidence for; if a verification failed or was
> skipped, say so plainly. When finished, reply with exactly the report
> format below.

4. The report format:

```
STATUS: COMPLETE | STOPPED
STEPS: per step — done/skipped + verification command result
STOPPED BECAUSE: (only if STOPPED) which STOP condition, what was observed
FILES CHANGED: list
NOTES: anything the reviewer should know (deviations, surprises, judgment calls)
```

### Review (the advisor's real job here)

Note on fresh worktrees: they share git history but not `node_modules` or build artifacts — the executor must install dependencies first, and check tooling that resolves from `dist/` may need one build even though the plan's command table (recon'd in the main tree) didn't mention it. Expect this; it isn't a deviation.

Review like a tech lead reviewing a PR against the spec — never fix anything yourself:

1. **Re-run every done criterion** in the worktree. Don't trust the executor's report — verify.
2. **Scope compliance**: `git -C <worktree> diff --stat` against the plan's in-scope list. Any file outside scope fails review, full stop.
3. **Read the full diff.** Judge it against "Why this matters" (does it solve the actual problem?) and the repo conventions named in the plan (does it look like the rest of the codebase?).
4. **Audit the new tests.** Executors game criteria — a test that asserts nothing meaningful passes `pnpm test` and proves nothing. Read what the tests assert.

### Verdict

**Documented deviations are judged on merit, not reflex-blocked.** "Do not improvise" exists to stop silent drift; an executor that hits a real obstacle (e.g. the plan's approach breaks existing test mocks), adapts minimally, and explains it in NOTES has done the right thing. Approve it if the adaptation serves the plan's intent and stays in scope; treat _undocumented_ deviations as review failures.

| Verdict     | When                                                                     | Action                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **APPROVE** | Criteria pass, scope clean, quality holds                                | Update the authoritative plan record to DONE. Present the diff summary, worktree path and branch, and NOTES. **Merging remains the user's decision.** |
| **REVISE**  | Fixable gaps                                                             | Send specific, actionable feedback to the same executor. **Max 2 revision rounds**, then BLOCK. |
| **BLOCK**   | STOP condition hit, scope violated unrecoverably, or revisions exhausted | Mark BLOCKED in the authoritative plan record with the reason. Refine or rewrite the plan with what was learned. |

Running verification commands inside the executor's worktree is fine — it's isolated and disposable. The no-mutating-commands rule protects the user's working tree, not the worktree.

---

## `reconcile` — keep `plans/` alive

Process what happened since the last session. Read the authoritative plan index or workspace work-item checkpoint and every plan file, then per status:

- **DONE** — spot-check that the done criteria still hold on the current HEAD (cheap ones only). Mark verified in the index. Don't delete plan files — they're the record.
- **BLOCKED** — read the reason. Investigate the underlying obstacle in the codebase. Either rewrite the plan around it (new number if the approach changed fundamentally, in-place refresh otherwise) or mark REJECTED with one line of rationale.
- **IN PROGRESS** (stale) — flag it to the user; an executor probably died mid-run. Check the worktree if one exists.
- **TODO** — run the drift check. If drifted: re-verify the finding still exists (it may have been fixed in passing), then refresh the "Current state" excerpts and `Planned at` SHA. If the finding is gone, mark REJECTED ("fixed independently").

Finish with a short report: what's verified done, what was refreshed, what's rejected, and what's executable right now.

---

## `--issues` — publish plans as GitHub issues

`--issues` is explicit publication authorization only after the workspace tracker destination and repository scope are resolved. Read `~/.agents/skills/issue/SKILL.md` and follow its destination, visibility, and content rules; use `~/.agents/skills/pr/SKILL.md` for related pull-request work. Record the resulting URL in the authoritative plan record. Do not invoke `gh` directly as a substitute for those workflows.
