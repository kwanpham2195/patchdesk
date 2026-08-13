---
created_at: 2026-08-13
repos:
  - patchdesk
status: in_progress
---

# Complete the Patchdesk implementation-plan portfolio

## Objective

Execute and verify every numbered plan in `plans/` in the order recorded by
`plans/README.md`. Do not redefine completion around a subset. The goal is done
only when Plans 001-008 are DONE and their combined current-state audit passes.

## Source of truth

- Queue, dependencies, and plan status: `plans/README.md`
- Executable requirements: `plans/001-*.md` through `plans/008-*.md`
- Audit evidence only: `plans/audit-2026-08-13-standard-codebase.md`
- This file: cross-plan progress, evidence ledger, decisions, and resume notes

## Operating constraints

- One implementation writer at a time. The parent owns integration and final
  verification. Use at most one worker, or one reviewer, or up to three scouts
  at once; never mix those groups concurrently.
- Preserve all pre-existing dirty changes. Inspect committed, staged, and
  unstaged diffs before each plan.
- Keep the raw `patchdesk.jsonl` tail and `pnpm dev` console live in Herdr.
  Rediscover panes by the labels `patchdesk logs live` and
  `patchdesk dev live`; pane IDs are not durable.
- Restart the app after main-process, services, adapters, or packaging changes.
- Use the real Electron surface for renderer/desktop verification.
- Stage explicit paths only. Do not push, switch branches, or commit unless the
  operator asks.
- Add no compatibility layer unless a current public contract requires it.

## Principles

- `[[principles/outcome-oriented-execution]]`
- `[[principles/prove-it-works]]`
- `[[principles/migrate-callers-then-delete-legacy-apis]]`
- `[[principles/serialize-shared-state-mutations]]`
- `[[principles/agent-orchestration]]`
- `[[principles/encode-lessons-in-structure]]`

## Baseline

- Planned-at/source baseline: `7b4f6e6`
- Branch at start: `fix/inline-conversation-freshness-repair`
- Initial dirty paths:
  - `AGENTS.md`
  - `CHANGELOG.md`
  - `package.json`
  - `pnpm-lock.yaml`
  - `src/renderer/src/components/summary-review-dialog.tsx`
  - `src/renderer/src/flows/review-workbench-flow.tsx`
  - `tests/renderer/review-workbench-flow.ui.test.tsx`
  - `tests/renderer/summary-review-dialog.ui.test.tsx`
  - `.agents/skills/react-doctor/`
  - `plans/`
- Environment at start: fresh Patchdesk dev process listening on CDP 9233;
  raw JSONL and dev-console tails live in Herdr.

## Ordered progress

- [x] Setup: persistent goal, queue, tracker, memory, and live logs/dev process
- [ ] Plan 001: prevent stale direct-summary observation
- [ ] Plan 002: restore workbench navigation accessibility
- [ ] Plan 003: correct safety/runtime docs
- [ ] Plan 004: lock packaged Flue beta.9 runtime
- [ ] Plan 005: remove superseded Review systems
- [ ] Plan 006: migrate Pi Insights to Flue 2.0.3
- [ ] Plan 007: lazy-load the Review workbench
- [ ] Plan 008: migrate quality tooling to Oxc
- [ ] Portfolio audit: prove every plan criterion against current state

## ADR checkpoints

- Plans 001-004: no new ADR expected; they implement current decisions.
- Plan 005: update current ADR wording and mark replaced ADRs superseded; retain
  history. Do not create a new decision unless runtime evidence contradicts the
  approved single-authority target.
- Plan 006: create the next ADR before production migration. Record the
  Patchdesk-owned one-shot Flue 2 child, strict `AgentReply.data` result,
  no-sandbox capability boundary, owned cancellation, and exact packaged
  runtime closure. This is a hard-to-reverse runtime decision.
- Plan 007: add an ADR only if implementation introduces a general renderer
  route-loading architecture rather than one bounded Review chunk.
- Plan 008: no ADR expected unless lint-policy parity requires an intentional
  policy reduction.

## Verification policy

Per plan:

1. Run its drift checks and confirm dependencies are DONE.
2. Create failing regression evidence first when the plan has a cheap bug seam.
3. Implement only the plan scope.
4. Run every focused gate named by the plan.
5. Inspect the complete diff and live app/logs when required.
6. Update `plans/README.md`, this checklist, and the evidence ledger only after
   direct verification.

Portfolio completion requires, at minimum:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm exec playwright test
pnpm stage:flue-runtime
pnpm package:mac
pnpm test:package-smoke
git diff --check
```

`pnpm format:check` becomes required after Plan 008. Package commands become
required after Plans 004 and 006. Live read-only Electron checks must cover the
final Inbox, Settings, Review, Analysis, Walkthrough, Refresh, and merge surfaces.

## Evidence ledger

Append one dated entry per completed plan. Include exact commands, results,
live checks, changed files, residual risks, and any ADR added or updated.

### 2026-08-13 — setup

- Active goal confirmed through the goal tracker.
- `plans/README.md` contains eight TODO plans in leverage-first order.
- Fresh Patchdesk dev process started with
  `pnpm dev -- --remote-debugging-port=9233` and verified listening on 9233.
- Raw `~/.local/share/patchdesk/logs/patchdesk.jsonl` tail is live.
- No source implementation changed during setup.

## Resume protocol

1. Read this file and `plans/README.md`.
2. Run `git status -sb` and inspect all dirty in-scope paths.
3. Confirm live Herdr log/dev panes and CDP 9233.
4. Continue the first unchecked plan only.
5. Never mark the goal complete from plan status alone; run the portfolio audit.
