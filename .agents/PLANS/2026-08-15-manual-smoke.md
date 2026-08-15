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

- [ ] Run one Analysis: queued -> running -> completed; findings map into the diff.
- [ ] Run one Walkthrough: narrative renders with chapter rail; mark one section reviewed; progress survives reopening the review.
- [ ] Cancel a run mid-flight: settles as cancelled, retains nothing.
- [ ] Context truncation on a chatty PR (if one exists): `context.json` < 512 KiB with `truncated` counters.
- [ ] Oversized-patch walkthrough (if a > 2 MiB patch PR exists): clear failure diagnostic, no crash.

## Phase 3: GitHub write flows (requires explicit consent per action)

- [ ] Finding review command starts the viewer's GitHub pending review; Analysis summary action appears.
- [ ] Submit the pending review from the Finish review modal; one GitHub review published.
- [ ] Comment now from the diff publishes immediately (only while no pending review exists).
- [ ] Resolve and unresolve one mapped conversation thread.
- [ ] Merge with acknowledgement on a test PR; uncertain-outcome path stays locked (simulated only).

## Phase 4: close and restart

- [ ] Dirty draft blocks close with the confirm dialog; discard keeps saved history.
- [ ] Second instance focuses the first.
- [ ] Corrupt one `review.json`: quarantined on next open, app refuses to load it.

## Evidence

Record per phase: path taken, app reuse, CDP port, screenshots, console/page-error result, and blockers with their user-visible effect.
Redact repo names, review text, tokens, and paths in reports.

## Gates

- Phase 1 runs without extra consent (read-only local state).
- Phases 2 and 3 pause for explicit user authorization before each action.
- Any bug found gets a regression test before the smoke continues.
