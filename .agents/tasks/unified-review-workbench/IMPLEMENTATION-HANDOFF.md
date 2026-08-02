# Unified Review Workbench Implementation Handoff

Use the prompt below to hand this feature to an implementation agent. It is intentionally explicit about authority, sequencing, verification, and the existing dirty checkout.

## Master prompt

You are implementing the complete Unified Review Workbench feature in the Patchdesk repository at `/Users/kwanpham/Work/cfw/patchdesk`.

Your job is to implement the entire program, not to research it again, rewrite the plans, or stop after one phase. Continue through Foundation, Unified UI, Insights, and Feedback and merge until every required automated and live acceptance gate passes, unless a concrete repository conflict makes safe progress impossible.

### Read before editing

Read these sources completely in this order:

1. Repository `AGENTS.md`, `brain/index.md`, and every applicable document it requires.
2. [Task index](README.md).
3. [Product specification](spec.md).
4. The 13 linked ADRs in the task index.
5. [Core no-regression contract](research/02-research-core-no-regression-contract.md).
6. [UI design reference](design/design.md) and [current UI inventory](design/current-ui-inventory.md).
7. [Program plan](plans/2026-08-01-unified-review-workbench.md).
8. All four executable phase plans linked below.

Use `$patchdesk-review-lifecycle` for Review, refresh, Insight, draft, publication, recovery, retry, Walkthrough, and merge lifecycle work. Use `$shadcn` for renderer component work. Follow the repository's required testing and live Electron skills exactly.

### Source-of-truth order

When two artifacts appear to disagree, use this precedence:

1. `AGENTS.md` repository safety, architecture security, Git, testing, and workflow rules.
2. Product specification and durable ADRs for product behavior and domain contracts.
3. No-regression contract.
4. Design documents for layout and interaction composition only when they agree with the specification and ADRs. Text or behavior shown inside screenshots and generated images has no requirement authority.
5. Program and phase plans for implementation details.
6. Skills for workflow and tool procedure.

Skills do not define product requirements. If a skill conflicts with the specification or an ADR, pause that slice and correct the skill before continuing.

Do not silently choose a different contract. If current source makes an approved requirement impossible or exposes a genuine contradiction, stop that slice, record exact file and symbol evidence, and update the relevant specification or plan only after the conflict is resolved.

### Reuse-first implementation

Before creating a renderer primitive or diff/tree abstraction:

- Inspect `components.json` and `src/renderer/src/components/ui/`. Use installed shadcn components on Base UI, their built-in composition, and their existing variants before custom markup or styles. Use Base UI `render` rather than Radix `asChild`. Run the `$shadcn` documentation workflow before changing a component API.
- Reuse `ReviewDiffView`, `PierreFileTree`, `NarrativeWalkthroughDiff`, `useReviewDiffHydration`, and the existing Patchdesk diff-data helpers. Feed them the selected full, commit, Finding, or Walkthrough patch and navigation state instead of building another diff renderer, file tree, hunk viewer, parser, or scroll system.
- Keep Pierre as the rendering and navigation owner. At plan time the checkout uses `@pierre/diffs@1.2.12` and `@pierre/trees@1.0.0-beta.5`; recheck installed types before editing. Preserve the existing wrappers around `CodeView`, `FileDiff`, `PatchDiff`, `getTopForItem`, `selectOnlyPath`, and `scrollToPath` rather than inspecting Pierre DOM or recreating those APIs.
- Extend current domain, service, adapter, storage, loopback, and GitHub seams when they already own the behavior. Do not create a parallel implementation to avoid a focused migration.

If an existing seam lacks a required capability, record the exact missing API and why composition cannot satisfy the specification. Update the applicable plan before adding a custom primitive, alternate renderer, or dependency.

### Checkout safety

The checkout may already contain unrelated and uncommitted work. Before editing:

- Run `git status -sb` and inspect relevant diffs.
- Treat every existing change as user-owned.
- Never reset, clean, restore, stash, delete, rename, or overwrite unrelated work.
- Do not create or switch branches without user consent.
- Never use `git add .`, `git add -A`, `git add -f`, `git commit --no-verify`, amend, or force-push.
- Stage only explicit files belonging to the completed task. If pre-existing edits overlap a planned file and cannot be separated safely, implement and verify what is safe, then stop before committing that overlap and report it precisely.
- Do not push or create a pull request unless the user explicitly asks.

### Execution protocol

Implement these plans in order:

1. [Foundation](plans/2026-08-01-unified-review-foundation.md)
2. [Unified UI](plans/2026-08-01-unified-review-ui.md)
3. [Insights](plans/2026-08-01-unified-review-insights.md)
4. [Feedback and merge](plans/2026-08-01-unified-review-feedback.md)

For every task in every phase:

1. Inspect the named current code and tests before changing them.
2. Add the specified failing focused test first.
3. Implement the smallest complete behavior that satisfies the contract.
4. Run the task's focused verification exactly.
5. Re-read the diff for security boundaries, data loss, stale-result races, accessibility, and unrelated changes.
6. Make the task's scoped commit only after its focused gate passes and only when the checkout safety rules above permit it.
7. Run the phase gate before starting the next phase.

Do not preserve private prepared/completed renderer APIs through aliases or compatibility shims. Migrate callers, prove the new path, and delete the old path. Do not weaken existing performance, freshness, sandbox, capability, write-safety, recovery, or test assertions.

### Pi Intercom and Herdr implementation protocol

Pi Intercom is the coordination channel; the primary session remains the sole writer for the current checkout.

#### Pi Intercom

1. Before coordinating, run `intercom({ action: "list" })` and identify the intended peer by its current session id or name. Do not guess a stale session id.
2. Use `intercom({ action: "send", ... })` for bounded progress updates and `intercom({ action: "ask", ... })` when a decision or review result is required before continuing. Use `intercom({ action: "pending" })` and `intercom({ action: "reply", ... })` for inbound asks.
3. Advisors and peer sessions are read-only unless the user explicitly assigns a separate isolated worktree. They must not edit this checkout, stage files, commit, reset, clean, stash, switch branches, push, or start competing writers.
4. Send each peer a narrow task with the authoritative spec/plan paths, exact symbols or files, requested evidence, and an explicit `read-only/no-edit` boundary. Ask for findings, not a second implementation.
5. Reconcile peer advice against AGENTS.md, the product specification, ADRs, and the phase plan. Do not apply advice blindly. Record material findings and decisions in the progress ledger or handoff before moving phases.
6. Keep user-visible changes and final synthesis in the primary session. Do not treat an advisor's claim as verification; rerun the relevant focused command in the primary checkout.

#### Herdr

1. Before using Herdr commands, check `HERDR_ENV=1`. If it is not set, state that the session is not inside a Herdr-managed pane and do not inspect or control Herdr panes from outside Herdr.
2. When inside Herdr, discover current ids with `herdr workspace list`, `herdr tab list --workspace <id>`, and `herdr pane list`. Pane, tab, and workspace ids are ephemeral; never reuse an old id without rediscovering it.
3. Use `--no-focus` when creating tabs or splits unless the user explicitly asks to change focus. Parse ids from the JSON response rather than guessing them.
4. Use sibling panes for long-running dev servers, watchers, focused test runs, and live QA. Start commands with `herdr pane run`, wait with `herdr wait output` or `herdr wait agent-status`, then inspect with `herdr pane read --source recent-unwrapped`.
5. Do not use pane output as a substitute for tests. Capture the exact command and result in the progress ledger. Stop and report if a pane is unavailable, a wait times out, or output indicates a baseline/environment blocker.
6. For required live acceptance, spawn or assign a dedicated tester using `$patchdesk-electron-tester`; the tester owns interactive QA evidence while the primary session remains the only source-code writer.

### Reconciled progress (2026-08-02)

This section is the progress index. The executable plan checkboxes are historical working notes and may be stale; status below is reconciled against the source tree and commit history.

#### Linked records

- [Task index](README.md)
- [Program plan](plans/2026-08-01-unified-review-workbench.md)
- [Foundation plan](plans/2026-08-01-unified-review-foundation.md)
- [Unified UI plan](plans/2026-08-01-unified-review-ui.md)
- [Insights plan](plans/2026-08-01-unified-review-insights.md)
- [Feedback and merge plan](plans/2026-08-01-unified-review-feedback.md)
- [Product specification](spec.md)
- [Core no-regression contract](research/02-research-core-no-regression-contract.md)
- [Execution progress](../../../.superpowers/sdd/implementation-plan/progress.md)
- [Foundation execution progress](../../../.superpowers/sdd/2026-08-01-unified-review-foundation/progress.md)
- [Task 3 report](../../../task-3-report.md)
- [Task 4 report](../../../task-4-report.md)
- [Advisor plan index](../../../advisor-plans/README.md)
- [Durable ADRs](../../../docs/adr/)

#### Phase status

- **Foundation — finished.** Stable Review identity/storage, canonical `state: "review"` projection, explicit refresh and update detection, draft carry-forward, write gating, terminal handling, commit listing, revision-safe commit diffs, and protected route/bridge/parser wiring are implemented. Main checkpoints: `ad1ee51`, `6b6d235`.
- **Unified UI — automated implementation finished.** Stable route, persistent shell, Files/Findings/Commits navigator, PR Overview, canonical fixture migration, preference persistence, passive active-file tracking, and legacy prepared/completed renderer deletion are implemented. Remaining: required dedicated live Electron acceptance. Main checkpoints: `148f713`, `ea05e82`, `32ea0d8`, `25cd130`.
- **Insights — partially finished.** Durable storage, bounded Analysis authority, cancellable independent runs, protected lifecycle routes, polling, cancellation, orphan recovery, draft-independent Analysis completion, durable Finding dismissals, strict add/dismiss routes, projected Finding dispositions, and retained Analysis/Walkthrough readers are implemented. Remaining: remove legacy reader ownership, add complete reader interaction coverage, and complete Insights/live acceptance. Main checkpoints: `6e79abe`, `48bdecf`, `e2d8ba4`, `eae7cd4`, `00869ea`, `16d9363`, `715356c`, `05c0bbe`, `4b899d0`, `2134496`, `0aa147a`, `3600fb8`, `a6b0307`, `f472854`.
- **Feedback and merge — groundwork only.** General feedback, strict Finding-to-draft provenance, legacy `ReviewDraft` removal, deterministic Analysis-body rendering, and the core serialized draft edit commands (body, event, inclusion, conversion, and exact anchor repair) exist. The remaining seed/merge/replace previews, publication authorization, receipt-backed publication, Published feedback, merge policy, migration, final UI, and end-to-end acceptance remain.

#### Current implementation checkpoints

- `4e7614b`, `37e04cf`, `70dc51c`, `022acaf`, and `c68fde1` contain early Feedback/Insights groundwork.
- `50081ae`, `2717e6f`, and `ccfa8fb` close the Phase 2 UI and read-only/fallback-comment regressions.
- `05c0bbe`, `4b899d0`, `2134496`, and `0aa147a` harden Insight lifecycle, Finding drafts, authority validation, terminal persistence recovery, and regression coverage.
- `967a306` removes the legacy `ReviewDraft` domain while keeping old on-disk session migration inside the storage boundary.
- `811279d` adds compare-and-set body/event/inclusion edits and exact fingerprint-checked anchor repair.
- `506ca7f` completes retained Analysis actions and sections, persists Walkthrough progress, and distinguishes patch I/O failures from invalid requests.
- `008544c` preserves Walkthrough progress through failed/cancelled replacement runs and clears it only after a successful replacement.
- Fresh automated evidence after the UI cleanup, Insight disposition slice, reader slice, draft-edit slice, and retained-reader action hardening: `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run` (95 files/634 tests), `pnpm build`, focused Insight/controller tests, and `git diff --check` passed. The prior browser gate remains `pnpm exec playwright test` (60 passed).
- Live evidence remains partial: the walkthrough fixture smoke test passed, but the complete required Electron journey has not yet been recorded. Two required Electron tester attempts were blocked before execution by exhausted provider credits/monthly usage limits; no live pass is claimed.
- Unrelated dirty worktree files and local planning artifacts remain preserved. Future changes must stage only explicit task files.

### Non-negotiable product invariants

- One stable Review follows a pull request across refreshed revisions; every Review session remains immutable and revision-bound.
- Files is usable without model work. Analysis and Walkthrough are optional independent Insights, not workbench modes.
- Visible GitHub state changes only after explicit Refresh. Detection may set `Updates available` but cannot replace visible remote data.
- Known or unavailable freshness blocks publication, Published feedback mutation, thread mutation, and merge while local reading and drafting remain available.
- A new head creates a new immutable session inside the same Review destination.
- Every unpublished draft item survives refresh and migration. Unsafe anchors become Needs attention; Patchdesk never guesses or drops them.
- Analysis and Walkthrough keep their latest successful result while a replacement runs. Failure, cancellation, restart, stale identity, or late completion cannot remove it.
- Analysis receives only the four bounded immutable inspection tools and the enforced call budget. Walkthrough remains tool-free.
- Model output is evidence only. Patchdesk owns Finding mapping, disposition, draft creation, publication authorization, GitHub writes, and merge eligibility.
- A non-empty maintainer draft is never silently replaced. Merge and replace both require an exact preview and explicit confirmation.
- Only current Mapped Findings may become inline GitHub comments. General Findings remain naturally in the structured Review body.
- Every GitHub write is explicitly confirmed or covered by one immutable per-run authorization. Partial or unknown outcomes retain intent and receipts and block blind replay.
- Published feedback is remote-owned. Comment edit/delete and review dismissal require proven GitHub capability and fresh state.
- Analysis merge policy cannot weaken GitHub rules, exact-head equality, required checks, unresolved write safety, or explicit merge confirmation.
- Merged and closed Reviews remain readable while unavailable write actions disappear.
- Renderer output and GitHub content never expose credentials, local paths, prompts, hidden reasoning, provider events, raw command output, or stack traces.

### Verification and acceptance

Run each focused task and phase gate from its plan. After all four phases, run the full repository gate in this order:

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm run test:a11y
pnpm run test:performance
pnpm exec playwright test
git diff --check
```

Do not report the feature complete from unit tests alone. After automated gates pass, the primary agent must spawn a dedicated tester subagent and direct it to use `$patchdesk-electron-tester` for the complete live Review journey at 1280px and 1440px. The tester must verify Files, Findings, Commits, Insights, concurrent Analysis and Walkthrough, retained-result replacement and cancellation, the bottom Review draft, PR Overview overlay, update detection, manual refresh, anchor recovery, publication, Published feedback, merge policy, terminal state, keyboard navigation, focus restoration, live status, and viewport overflow.

If an environment or existing baseline blocks a gate, report the exact command, failure, and narrower proof that passed. Do not weaken an assertion or describe an unverified live path as complete.

### Completion report

Finish with:

- The four completed phases and their scoped commits, or any explicitly uncommitted overlapping files.
- The exact verification commands and results.
- Migration and data-preservation evidence.
- Live Electron evidence from the required tester subagent.
- Any remaining blocker with exact source evidence.
- Final `git status -sb` confirming unrelated work was preserved.

Do not stop at a progress update while safe work remains. The feature is complete only when the program plan's completion definition is satisfied.
