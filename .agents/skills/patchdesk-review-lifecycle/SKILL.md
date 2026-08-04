---
name: patchdesk-review-lifecycle
description: "Use when changing Patchdesk Review, Insight, draft, publication, recovery, or merge lifecycle behavior."
---

# Patchdesk Review lifecycle

Preserve one Review across revisions and keep each Review session immutable. The approved specification and ADRs define product behavior; this skill defines implementation guardrails.

## Preserve identity and ownership

1. Keep lifecycle state in typed domain, service, and storage boundaries. Expose one renderer projection with independent Review, Insight, draft, Published feedback, freshness, and merge state. Do not add prepared, completed, model, manual, or read-only modes.
2. Bind Insight candidates to `{profileId, reviewId, sessionId, headSha, patchHash, runId}`. Bind publication to that identity plus draft revision, event, attempt, and authorization. Reject stale, late, or mismatched results.
3. Use approved recovery keys and bounded copy. Redact diagnostics when writing and when loading or exporting. Never expose provider errors, paths, prompts, hidden reasoning, raw commands, or stack traces.

## Separate detection, execution, and writes

1. Let detection set `Updates available` only. Explicit Refresh selects the represented GitHub snapshot. Known updates or unavailable freshness block GitHub writes while local reading, drafting, and Insight access stay available.
2. Keep Analysis finite with a strict schema, its four bounded immutable inspection tools, and an enforced budget. Keep Walkthrough finite, tool-free, bounded, cancellable, and independent of Analysis.
3. Treat model output as a candidate. The workflow cannot mutate the checkout, GitHub, or authoritative Review state. A coordinator validates and persists active, replacement, failure, cancellation, and retained-result state.
4. Allow one active run per Insight type and concurrent runs across types. Keep the latest successful result until a validated current replacement commits.
5. Persist the exact model and reasoning selection for each run. Defaults and preference tuning are not lifecycle invariants.

## Make recovery and writes safe

1. Serialize each durable owner separately: Review refresh, each Insight type, draft revision, publication, and merge. Run long model work outside locks, then re-enter to validate and commit.
2. Preserve every draft item across refresh and migration. Remap an inline anchor only after one exact safe match. Move unsafe anchors to Needs attention; never guess or drop them.
3. Route every GitHub write through the shared freshness and ownership gate with an exact-head check. Review publication needs UI confirmation or one immutable per-run authorization. Merge and destructive Published feedback actions need confirmation.
4. Preserve publication intent, ordered receipts, and idempotency. Freeze conflicting retries after partial or unknown outcomes; never replay blindly.
5. Recover interrupted work without claiming a false reconnect. Keep cleanup idempotent, path-checked, and limited to non-running sessions. Treat profile changes as atomic ownership transitions and reuse the dirty-navigation guard.

## Prove the surface

1. Cover freshness detection versus Refresh, no-drop draft migration, Insight concurrency and retention, cancellation and late suppression, model authority, receipt recovery, write gates, and redaction.
2. Use the approved design artifact. For the Unified Review Workbench, use `.agents/tasks/unified-review-workbench/design/`; do not create a parallel `src/design/` source.
3. Run focused, phase, and full gates. Delegate live UI verification to `$patchdesk-electron-tester` as required by `AGENTS.md`.
