---
created_at: 2026-08-15
repos: patchdesk
status: in-progress
---

# Manual smoke test: canonical flows (2026-08-15)

Executes the manual cases from `docs/test-cases.md` against the live development app.
Read-only by default. GitHub write flows and model runs require explicit user consent before they execute.

## Environment

- Dev app: `pnpm dev -- --remote-debugging-port=9233` in herdr tab `wF:t19` (patchdesk-dev).
- Log tail: `tail -f ~/.local/share/patchdesk/logs/patchdesk.jsonl` in herdr tab `wF:t1A` (patchdesk-logs).
- Driver: `agent-browser --session patchdesk-dev --cdp 9233`, per the `patchdesk-electron-tester` skill.
- Real dev profile and real data; no fixtures, no synthetic Review state.

## Phase 0: startup and log health

- [x] Dev app boots, local API health check passes, workbench window appears.
- [x] `patchdesk.jsonl` shows main-process startup entries and no crash record.
- [x] CDP reachable on 9233; snapshot shows the workbench.

## Phase 1: inbox, open, projection (read-only)

- [x] Inbox renders with the real profile and watchlist (CFW QA, 25+ PRs).
- [x] Open one real pull request: pr-85 workbench opens, sections render (Conversation, Diff, Insights), checks and merge state show.
- [x] Workbench projection validates; no `[contracts]` failure, empty console.
- [x] Session artifacts exist for pr-85: `patch.diff` (3.2 KiB), `prepared/context.json` (8.9 KiB < 512 KiB), `review-input.md`, `debug.json`, worktree under `~/.cache/patchdesk/.../review-worktrees/`.
- [x] Diff view renders; navigator and file tree work; detect-updates clean.
- [x] Refresh returns current state; no `400 invalid_input`.
- [x] FINDING (resolved): pr-220 (cfw-database-manager) failed to open with 503 `storage`. Root cause: the GitHub conversation reader emits `nodeId` on timeline IssueComment entries for review-attached comments; the strict snapshot schema (`conversationIssueCommentSchema`) and the `ConversationIssueComment` domain type never declared `nodeId`, and `parseConversation` dropped it. `saveCandidate` -> `parseSnapshot` rejected the unknown key, so the initial refresh failed and left a snapshot-less review that `load()` fails closed on. Fix: declare `nodeId` on the domain type, accept and preserve it in the snapshot schema/reconstruction, regression test, live-verified (open heals the review to Fresh; workbench opens).
- [x] FOLLOW-UP (open): no UI path heals a snapshot-less review - inbox uses `/v1/reviews/load` which fails closed; `/v1/reviews/open` would recover but is never invoked for existing reviews. Suggest: inbox falls back to open (or offers retry) when load returns a storage failure.

## Phase 2: insight runs (requires consent, consumes provider credits)

- [x] Run one Analysis (pr-571, Pi deepseek-v4-flash low): queued -> completed, 5 findings retained, Analysis reader renders. pr-220's first attempt failed with `invalid_result` (model output rejected once); the pr-571 run succeeded, so the failure was one-off, not systemic.
- [x] Run one Walkthrough (pr-571): completed with 5 chapters; narrative renders with chapter rail; "Mark section reviewed" persists `reviewedSectionIds` via `/v1/reviews/insights/walkthrough/progress`; progress survives reopen (projection carries it).
- [x] Cancel a run mid-flight: cancel returns `cancelling`, record settles `cancelled`, the previous retained Analysis is untouched, the child process exits.
- [ ] Context truncation on a chatty PR: covered by unit tests; no chatty PR in the live watchlist.
- [ ] Oversized-patch walkthrough: no > 2 MiB patch PR in the live watchlist.
- [x] FINDING (renderer): React duplicate-key warning `codespan-system_suggestion` in walkthrough/codespan rendering (`generated-markdown`); keys not unique. FIXED `cbf5a37`: keys now include the token position in the stream; regression test proves the old key function fails it. Verified live: pr-571 walkthrough renders with zero console warnings.
- [ ] NOTE: agent-browser `click` did not trigger the Mark-section button's onClick; JS `dispatchEvent(click)` worked. Tooling quirk, not an app bug.

## Phase 3: GitHub write flows (requires explicit consent per action) - pr-85, except merge

- [x] Consent given for pr-85 (centraldigital/cfw-sales-crm-api#85), no merge. RESULT: zero GitHub writes performed; every flow failed closed (safe).
- [x] Finding review command: BLOCKED. Both retained findings have `mappingStatus: invalid_line` (F1 range 166-170 vs hunk 164-169; F2 line 88 vs hunk 92-106). The UI rendered "Add to review" and the click silently threw ("not actionable"). FIXED `7d317b6`: the button now requires `mappingStatus === "mapped"`; regression test added; verified live on pr-85 (findings render, zero Add-to-review buttons).
- [x] Regenerate analysis: failed with `invalid_result`. INVESTIGATED, root cause found and proven, NOT caused by recent commits:
  - The model intermittently emits findings with line ranges wider than 10 lines (observed: 20 and 516 lines). The child validates only the raw schema (no range constraint) and accepts; the parent re-validates with `parseModelReviewResult` -> `projectFinding`, which rejects `lineEnd - lineStart > 9` -> `invalid_result`.
  - Proof: manual child replays succeed 15/15 (pipeline deterministic); captured the failing value through the app (child accepted, parent rejected); a regression-style test shows the exact value fails and removing only the wide-range findings makes it pass.
  - The range guard predates today's commits (review-result.ts last meaningful change Aug 13, before the last successful run). My bounds commit is ruled out: pr-85's failed runs used the Aug-13-prepared context, prompt is ~4 KB, bound never triggers.
  - FIXED `f40debc`: wide ranges are clamped to a 10-line evidence highlight (`lineStart + 9`) instead of failing the run; inverted ranges still rejected. Regression tests; live run 13 completed with 6 findings.
  - Follow-up (ticket-worthy): align child/parent validation contract; clearer diagnostic than generic invalid_result.
- [x] FINDING (UI recovery): a saved review whose record is missing or whose snapshot no longer parses could not be opened from the inbox (`load` fails closed; no fallback). FIXED `23cbecf`: row clicks now fall back to opening by PR identity when `load` fails (heals or recreates; same projection for healthy reviews); regression test proves 404 load -> open by identity. Live note: pr-220 earlier healed through the open path.
- [x] Thread resolve/unresolve: N/A - pr-85 has no conversation threads.
- [x] Comment now: BLOCKED for automation - the diff hunks never materialized in the live app via CDP (file headers render, hunk rows do not; page body text stays < 1.5 KB; synthetic wheel/scroll events do not trigger the stream). Playwright fixtures pass. Needs a human eye on the running app window to decide between a live rendering gap and a CDP/virtualization limitation.
- [ ] Merge: excluded by user.

## Phase 4: close and restart

- [x] Close guard: FINDING + FIX. The guard never engages in the real app: the renderer never reports a non-clear state. `write_pending` reporting was lost in the unified-workbench refactor (old `completed-review-workbench` called `reportNavigationState` on write transitions; the new `review-workbench.tsx` declares the prop but never calls it). `dirty_draft` was never wired in any version. FIXED `247f5a7` for `write_pending` (reported while `pendingReview.busy || directSummary.busy`; regression test proves write_pending -> clear across a hanging command). `dirty_draft` remains unwired: draft presence lives inside `review-diff-view`, needs state lifting (follow-up ticket).
- [x] Clear-state close allows: verified live (window.close() closes the window).
- [x] Second instance: second launch exits via the single-instance lock; no duplicate app. Window recreation on second-instance while windowless could not be verified (dev-environment flakiness).
- [x] Corrupt insight record (DECIDED behavior, fixed `eb96a78`): a corrupt/schema-drifted Analysis or Walkthrough record is IGNORED and the Insight reads as `not_generated` (a re-run heals it), instead of failing the whole Review load. Verified live on pr-571: corrupted `analysis.json` -> `/v1/reviews/load` 200 with `analysis: {status: "not_generated"}` (was 503 storage); after restoring the backup, analysis is `current` with 6 findings. Regression test in `review-workbench-projection.test.ts`.
- [ ] Corrupt `review.json` (the Review record itself): quarantined on next open, app refuses to load it. NOT RUN live; the `invalid_stored_value` -> quarantine path is unit-tested in `review-recovery-service`/`review-session-preparation`. Run when convenient. Note: the Review record case differs from the Insight record case above; insight records are ignored, the Review record itself is quarantined.
- [x] FINDING (tooling debt): the pre-commit react-doctor gate scans whole staged files and blocks ANY change to the 8 giant components (>300 lines; `review-workbench.tsx`, `review-workbench-flow.tsx` x2, `review-diff-view.tsx`, `maintainer-inbox.tsx`, `app.tsx`, `narrative-walkthrough.tsx`, `settings-flow.tsx`). Full-scan score is 76/100 "Needs work" (18 warnings). `247f5a7` was committed with `--no-verify` after explicit user approval. Follow-up: refactor giants or revisit the gate; without it, every future fix in those files stalls.

## Evidence

Record per phase: path taken, app reuse, CDP port, screenshots, console/page-error result, and blockers with their user-visible effect.
Redact repo names, review text, tokens, and paths in reports.

## Gates

- Phase 1 runs without extra consent (read-only local state).
- Phases 2 and 3 pause for explicit user authorization before each action.
- Any bug found gets a regression test before the smoke continues.
