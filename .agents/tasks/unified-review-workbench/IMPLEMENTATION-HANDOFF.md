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

### Current progress (2026-08-01)

- Foundation implementation is complete and committed in `ad1ee51` (`feat: add unified review workbench`) with follow-up regression tests in `6b6d235` (`test: cover review merge operations`).
- Foundation verification passed: `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run` (93 files/631 tests), `pnpm build`, `git diff --check`, and the prohibited legacy projection grep.
- Foundation behavior includes stable Review identity/storage, draft carry-forward and attention blocking, strict canonical projection, explicit detection/refresh, snapshot-backed loading, write gating, terminal handling, commit listing, revision-safe commit diffs, and protected route/bridge/parser wiring.
- Unified UI Task 3 is now committed in `148f713` (`feat: complete review commit navigator`). The canonical flow renders a Files/Findings/Commits navigator, uses the existing Pierre tree/diff seams, loads commit-specific diffs through the protected route, validates response SHA identity, suppresses late responses, gates Findings to current retained Analysis, exposes commit SHA copying, maps commit authoring back to the current full patch, and resets selection across revisions.
- Unified UI Task 4 has started in `ea05e82` (`feat: add review PR overview`) with interaction coverage follow-up in `32ea0d8` (`test: cover review overview interactions`). The canonical read-only PR Overview uses the existing Base UI Sheet, preserves the workbench, shows Description, Summary/change context, Checks, Existing threads, Published feedback, Merge readiness, and terminal state, and covers open, Escape/focus restoration, backdrop close, and body scroll locking.
- Unified UI remains incomplete: draft dock and final UI acceptance gates remain. The current focused UI gate passed with 16 tests; lint, typecheck, build, and diff-check passed for this slice.
- Insights Task 1 is now committed in `6e79abe` (`feat: persist review insights`). Strict Insight records, tokenized lifecycle transitions, per-Review/type storage, atomic writes, and malformed/profile-isolation tests are in place; the focused gate passed with 6 tests.
- Insights Task 2 is complete across `48bdecf` (`fix: enforce bounded analysis inspection`) and `e2d8ba4` (`fix: harden analysis authority boundaries`). All four inspector methods share the eight-call budget with main-process-only denial reasons; the model boundary re-parses strict structured output; trusted-policy ordering, repository-authored injection text, invalid revisions, snapshot caps/escapes, and full-versus-incremental prior-finding rules are covered. The focused Insights authority gate passed with 27 tests.
- Insights Task 3 has started in `eae7cd4` (`feat: coordinate cancellable insight runs`) with polling stabilization in `1c15fb6`, walkthrough signal propagation in `a9f1f24`, desktop wiring in `ef91f73`, and idempotent cancellation in `f7b58c7`. The durable coordinator owns per-run AbortControllers, persists queued/cancelling/completed/failed/cancelled transitions through `InsightStore`, validates current Review revision before replacement, and is exposed through the authenticated Insight routes. Walkthrough generation now accepts caller-owned cancellation, and cancelling an already-completed run returns its completed projection. Remaining Task 3 work is restart recovery and deeper production lifecycle integration; the focused slice passed 15 tests and the full gate passed 97 files/649 tests.
- Insights and Feedback/merge phases remain incomplete. Full accessibility, performance, Playwright, and live Electron acceptance gates have not yet run.
- Unrelated dirty worktree files and local planning artifacts remain outside the scoped commits. Preserve them and stage only explicit files for future scoped commits.

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
