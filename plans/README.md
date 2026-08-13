# Implementation Plans

Reconciled with fresh eyes on 2026-08-13. Execute plans in numeric order unless
a dependency says otherwise. The order is leverage-first: small, high-confidence
correctness and safety gains precede large migrations; broad tooling churn is
last.

Each executor must read the complete plan, preserve pre-existing working-tree
edits, honor every STOP condition, run each verification gate, and update only
its status row when done.

## Execution order and status

| Plan | Title                                                           | Priority | Effort | Risk | Depends on            | Status |
| ---- | --------------------------------------------------------------- | -------- | ------ | ---- | --------------------- | ------ |
| 001  | Prevent stale direct-summary observation from replacing Refresh | P1       | S      | LOW  | —                     | DONE   |
| 002  | Restore valid Review workbench navigation semantics             | P1       | S      | LOW  | —                     | DONE   |
| 003  | Correct write-safety and development-runtime documentation      | P1       | S      | LOW  | 001, 002              | DONE   |
| 004  | Make the packaged Flue runtime reproducible                     | P1       | M      | MED  | 001–003               | DONE   |
| 005  | Remove superseded Review systems and keep one current runtime   | P1       | L      | HIGH | 001–004               | DONE   |
| 006  | Migrate Pi Insights from Flue beta.9 to Flue 2.0.3              | P1       | L      | HIGH | 004, 005              | DONE   |
| 007  | Keep the Review workbench out of the initial renderer bundle    | P2       | M      | MED  | 005, 006              | DONE   |
| 008  | Migrate quality tooling to Oxc                                  | P3       | M      | MED  | 001–007; clean branch | DONE   |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (with one-line reason) |
REJECTED (with one-line rationale).

`audit-2026-08-13-standard-codebase.md` is evidence only. It is not an
executable plan and has no status.

## Why this order

1. **Plan 001 first:** It fixes an introduced concurrency defect in the current
   dirty direct-summary work. A delayed observation can overwrite a newer
   explicit Refresh. The fix is small, testable, and protects the sole
   changed-revision adoption path.
2. **Plan 002 second:** It removes a reproduced critical Axe violation with a
   small semantic correction and no architecture dependency.
3. **Plan 003 third:** The main safety statement is inaccurate and the command
   ladder is incomplete. Correct documentation is cheap, but it follows the two
   live defects so it can describe their integrated current behavior.
4. **Plan 004 fourth:** The shipped Flue dependency closure is not reproducible.
   Locking the existing runtime now gives a medium-effort security and packaging
   gain and creates the boundary that Plan 006 updates.
5. **Plan 005 fifth:** Removing competing Review authority is valuable but broad
   and high-risk. It runs only after the fast fixes and package baseline are
   stable. Its internal order remains one coordinated deletion sequence.
6. **Plan 006 sixth:** Flue 2 is a breaking execution rewrite. It follows Plan
   005 so obsolete attempt, incremental, completion, and local-batch fields are
   not ported. It updates Plan 004's exact closure rather than recreating an
   unlocked package path.
7. **Plan 007 seventh:** Lazy loading has a useful startup gain, but Plans 005
   and 006 can change the workbench import graph and verification environment.
   Splitting the bundle afterward avoids rework and produces a stable budget.
8. **Plan 008 last:** Oxc can improve feedback speed, but it has no immediate
   product safety gain and Oxfmt rewrites hundreds of files. Running it last on
   a clean branch prevents formatting churn from hiding functional changes.

## Dependency and contract notes

- Plans 001 and 002 are technically independent, but execute them in that order
  because Plan 001 prevents stale authority replacement.
- Plan 003 is documentation only. It must describe shipped behavior, including
  any still-reachable authorization exception; it must not claim Plan 005 or
  Plan 006 has already landed.
- Plan 004 locks Flue beta.9 deliberately. This is not throwaway work: its exact
  manifest/lock, fail-closed staging, and no-cache-fallback contract become the
  package boundary Plan 006 updates.
- Plan 005 has explicit approval to remove the unreachable ADR-0010 automatic
  Analysis completion/publication stack. The local API rejects `completion`,
  the renderer does not send it, and production does not configure a completion
  handler. It must also correct the stale exception in `AGENTS.md`.
- Plan 005 must preserve current explicit Finding **Add to review** writes,
  immutable receipts, pending-review ownership/reconciliation, duplicate
  prevention, and Analysis-summary Finish-review prefill.
- Superseded ADRs remain historical records. Mark them superseded; do not delete
  decision history merely because runtime compatibility is removed.
- Plan 006 uses an isolated exact Flue 2 package for its proof while root beta
  code remains buildable. Production callers and root dependencies switch only
  after the proof and converted child boundary are ready.
- Plan 006 package smoke uses a separate fixed faux-provider entry and an
  explicit child environment allowlist. Production cannot select faux mode.
- Plan 008 must inventory the full effective ESLint policy, including JS and
  TypeScript recommended rules and React Hooks. Four explicit overrides alone
  are not lint parity.

## Working-tree baseline

At reconciliation time, the checkout was already dirty:

- `AGENTS.md`
- `CHANGELOG.md`
- `package.json`
- `pnpm-lock.yaml`
- `src/renderer/src/components/summary-review-dialog.tsx`
- `src/renderer/src/flows/review-workbench-flow.tsx`
- `tests/renderer/review-workbench-flow.ui.test.tsx`
- `tests/renderer/summary-review-dialog.ui.test.tsx`
- `.agents/skills/react-doctor/` (untracked)
- `plans/` (untracked)

Every executor must inspect committed, unstaged, and staged diffs for in-scope
paths. Do not overwrite, reformat, or absorb unrelated hunks.

## Scope decisions and rejected alternatives

- **Run large migrations before quick defects:** rejected. Lower leverage and
  higher risk; it leaves known user-facing correctness defects open.
- **Split Plan 005 across parallel executors:** rejected. Its type extraction,
  caller migration, authority deletion, parser cleanup, and recovery changes
  are ordered and share composition points. One plan can still use small
  commits and verification gates.
- **Upgrade Flue before deleting superseded Review systems:** rejected. It would
  port fields already scheduled for deletion and create overlapping authority.
- **Use `flue run --json` as result transport:** rejected. Its envelope contains
  assistant text, not the named strict data returned by programmatic
  `AgentReply.data`.
- **Run Flue 2 in Electron's main process:** rejected for this migration.
  One-shot children preserve crash, cancellation, and capability isolation.
- **Keep copying a previous package as an offline cache:** rejected. It cannot
  prove dependency identity for the current source commit.
- **Delete all recovery or receipts with legacy code:** rejected. Merge,
  pending-review, direct-summary, observation, preparation, and exact Finding
  receipt protocols are current safety systems.
- **Delete superseded ADRs:** rejected. Unsupported runtime behavior may be
  removed while decision records remain explicitly historical.
- **Treat the audit as an executable plan:** rejected. It is evidence and
  disposition history only.
- **Plan the three product direction options now:** rejected until selected by
  the product owner. They remain in the audit.
- **Migrate Oxc during feature work:** rejected. It adds large formatter review
  noise and low immediate product gain.
