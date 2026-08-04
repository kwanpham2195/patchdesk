# Unified Review Workbench Spec and Design Repair Handoff

This handoff starts the remaining spec and design repair. The original
Foundation, Unified UI, Insights, and Feedback and merge implementation plans
are complete and archived. Do not reimplement them.

## Master prompt

You are fixing the Unified Review Workbench in the Patchdesk repository at
`/Users/kwanpham/Work/cfw/patchdesk`.

Implement the complete
[combined spec and design repair ExecPlan](plans/2026-08-03-unified-review-spec-and-design-repair.md).
Work through all 14 steps, all 18 spec/code findings, and all 16 design
findings. Do not reopen product research, rerun the completed phase plans, or
stop after visual shell changes.

### Read before editing

Read these sources completely in this order:

1. Repository `AGENTS.md`, `brain/index.md`, and every applicable document they
   require.
2. [Task index](README.md).
3. [Product specification](spec.md).
4. The 13 ADRs linked from the task index.
5. [Core no-regression contract](research/02-research-core-no-regression-contract.md).
6. [UI design reference](design/design.md) and
   [current UI inventory](design/current-ui-inventory.md).
7. [Design-conformance review](2026-08-03-design-conformance-review.md),
   including its live evidence limits.
8. [Spec/code review](2026-08-03-spec-code-review.md).
9. [Combined repair ExecPlan](plans/2026-08-03-unified-review-spec-and-design-repair.md).

The [archived plans](plans/archive/README.md) are optional historical context.
Read a specific archived plan only when the repair ExecPlan points to an ownership
decision that current source does not explain.

Use `$patchdesk-review-lifecycle` for Review, refresh, Insight, draft,
publication, recovery, retry, Walkthrough, and merge lifecycle work. Use
`$shadcn` for renderer component work. Follow the repository's required live
Electron workflow exactly.

### Source-of-truth order

When artifacts disagree, use this order:

1. `AGENTS.md` for repository safety, security, Git, and verification rules.
2. Product specification and ADRs for behavior and domain contracts.
3. No-regression contract for existing safety boundaries.
4. Selected design for layout and interaction composition.
5. Spec/code review for current lifecycle and safety defects.
6. Design-conformance review for current UI defects and evidence.
7. Combined repair ExecPlan for execution order, file scope, tests, and stop
   conditions.
8. Skills for workflow and tool procedure.

Do not silently choose another contract. If current source makes a requirement
impossible or exposes a real contradiction, stop that slice and report the
exact file, symbol, and conflicting requirement.

### Checkout safety

The checkout contains user-owned uncommitted work. Before editing:

- Run `git status -sb` and inspect relevant diffs.
- Preserve every existing change that is outside the current repair step.
- Do not reset, clean, restore, stash, delete, rename, or overwrite unrelated
  work.
- Do not create or switch branches without user consent.
- Never use `git add .`, `git add -A`, `git add -f`,
  `git commit --no-verify`, amend, or force-push.
- Stage only explicit files from the completed repair step.
- Do not push or create a pull request unless the user asks.

If an existing edit overlaps a required file and cannot be separated safely,
finish the non-overlapping proof and report the exact conflict before staging.

### Reuse the completed architecture

The repair must compose the current owners:

- `ReviewWorkbenchProjectionService` owns the renderer-safe Review projection.
- `ReviewRefreshService` owns represented GitHub state and session advancement.
- `InsightRunCoordinator` and `InsightStore` own Insight lifecycle and retained
  results.
- `ReviewBatchController` owns serialized local draft edits and already supports
  anchor repair and conversion.
- `PublicationPreviewService`, `ReviewWriteController`, and the existing receipt
  model own publication.
- `PublishedFeedbackService` owns published comment mutation and review
  dismissal.
- `MergeWriteController` and `MergeService` own exact-head merge revalidation.
- Pierre and the existing Patchdesk wrappers own diff rendering, tree
  selection, scrolling, and focus.

Do not add parallel draft, publication, merge, Insight, diff, tree, dialog, or
focus owners. Use installed shadcn components on Base UI before custom
interaction primitives. Do not add a dependency for this repair.

### Maintain the ExecPlan

Treat the combined repair ExecPlan as the execution ledger. At every milestone
boundary and whenever implementation changes course:

- update `Progress` with a timestamp and accurate remaining work;
- add unexpected source behavior or failed assumptions to `Surprises &
  Discoveries` with evidence;
- record implementation-local choices in `Decision Log`;
- add the milestone result and remaining gaps to `Outcomes & Retrospective`;
- record focused commands, test counts, commit or uncommitted file state, and
  evidence paths in `Artifacts and Notes`.

Do not create a separate progress file. A new worker must be able to resume by
reading the ExecPlan and current worktree only.

### Milestone review protocol

There is no stop condition for this repair. Continue serially through every
remaining ExecPlan step until completion. After each milestone's focused
verification passes, dispatch a fresh-context, read-only `reviewer` subagent to
inspect that milestone's diff and its acceptance conditions. Record the
reviewer's artifact path, findings, and disposition in the ExecPlan. Apply
in-scope fixes, rerun the affected focused verification, and only then begin
the next milestone. A reviewer finding never ends the repair; it becomes the
next in-scope fix.

### Repair scope

Complete the repair ExecPlan in this order:

1. Lock down the exact desktop bridge and protected loopback route surface.
2. Restore Patchdesk-owned Finding mapping and retain Analysis before running
   completion actions.
3. Make explicit Refresh the only owner of represented revision advancement and
   eliminate false update detection.
4. Put publication and merge behind the stable Review gate, full authorization
   binding, per-Review serialization, intent/receipt durability, and exact-head
   rechecks.
5. Complete restartable, marker-last migration of every required durable
   artifact and terminal state.
6. Derive and enforce record-specific Published feedback capabilities and reject
   every terminal mutation at the service boundary.
7. Replace legacy design fixtures with deterministic unified-workbench states.
8. Repair shell geometry, persistent empty draft behavior, local-edit
   eligibility, header density, and legacy copy.
9. Build the selected Insight rail and explicit Analysis and Walkthrough
   lifecycle documents.
10. Complete Finding disposition/focus actions and commit statistics.
11. Wire the existing focused Needs-attention repair commands and all-items
   publication gate.
12. Reorder PR Overview and connect the Review-owned confirmed SHA-bound merge.
13. Implement Ready, Publishing, Confirmed, and Needs confirmation publication
   projections, including a durable successor draft after confirmation.
14. Complete accessibility, responsive browser acceptance, cleanup, and
   development plus packaged Electron proof.

Each step starts with its specified failing tests and ends with its focused
verification command. Do not batch verification at the end. Do not weaken
freshness, sandbox, capability, write-safety, recovery, accessibility,
performance, or viewport assertions.

### Non-negotiable behavior

- One Review follows a pull request across immutable revision-bound sessions.
- Files remains usable without model work. Analysis and Walkthrough are
  optional independent Insights.
- Detection may show Updates available but cannot replace visible GitHub state.
- Updates available blocks remote writes while local reading and drafting stay
  available.
- Every unpublished draft item survives refresh. Unsafe anchors require an
  explicit repair choice.
- The latest successful Insight stays readable during replacement. Failure or
  cancellation cannot remove it.
- Outdated evidence cannot navigate current code, mutate a draft, publish,
  dismiss a Finding, or affect merge policy.
- Model output remains evidence. Patchdesk owns mapping, disposition, drafting,
  publication, and merge authority.
- Every GitHub write is explicitly confirmed or covered by one immutable
  per-run authorization.
- Active and uncertain publication states block closing, conflicting writes,
  and blind replay.
- Published feedback is GitHub-owned and changes only after refresh or a
  confirmed mutation followed by refresh.
- Merged and closed Reviews remain readable while unavailable actions disappear.
- Renderer copy never exposes credentials, local paths, prompts, hidden
  reasoning, provider events, raw command output, receipt identifiers, or stack
  traces.

### Verification

Run every focused command in the repair ExecPlan. Finish with:

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm run test:a11y
pnpm run test:performance
pnpm exec playwright test
pnpm run package:mac
pnpm run test:package-smoke
git diff --check
```

The primary agent must delegate every browser, live-app, or packaged-app test to
a dedicated tester subagent using `$patchdesk-electron-tester`. Verify the
production components at 1280px and 1440px. Cover Files, Insights, Analysis
lifecycle, Walkthrough lifecycle, Finding focus, commit selection, expanded
draft, Needs-attention repair, PR Overview, all publication states, Published
feedback, merge readiness, merged, and closed.

Use deterministic fixtures for model, publication, Published feedback mutation,
merge, and terminal states. Do not send pull-request data to a model or perform
a real GitHub write without fresh explicit user authorization.

The tester must capture screenshots and accessibility snapshots and report
viewport geometry, focus behavior, page errors, console errors, bridge route
behavior, and packaged-app smoke results. Unit tests alone do not prove this
repair.

### Continuous execution

Do not stop for a conflict, failed assumption, failed focused gate, ownership
question, or missing proof. Record the evidence in the ExecPlan, choose the
smallest safe in-scope correction that preserves the specification and ADR
contracts, and continue. If a requirement cannot be directly proven without an
unauthorized model or GitHub write, use the required deterministic fixture and
record that proof limit; never perform an unauthorized write.

### Completion report

Finish with:

- The 14 completed repair steps and their scoped commits, or the exact files
  intentionally left uncommitted.
- All 18 spec/code findings and all 16 design findings mapped to passing proof.
- Exact focused and full verification commands with results.
- Packaged bridge route-parity evidence.
- Model-mapping, Refresh-only advancement, write-gate, migration, capability,
  and terminal-state evidence.
- Deterministic 1280px and 1440px acceptance evidence.
- Live Electron evidence from the required tester subagent.
- Successor-draft and unknown-publication recovery evidence.
- Any remaining blocker with exact source evidence.
- Final `git status -sb` proving unrelated work was preserved.

Do not report completion while a safe in-scope repair remains. The task is done
only when every ExecPlan acceptance condition passes.
