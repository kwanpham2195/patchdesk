---
name: patchdesk-review-lifecycle
description: "Build or modify Patchdesk review, recovery, retry, and walkthrough lifecycle flows."
---

# Patchdesk Review Lifecycle

Use for Patchdesk flows that create, resume, retry, recover, or display review and narrative-walkthrough state. Preserve the layered architecture and treat lifecycle data as an untrusted boundary.

## Design the state boundary

1. Keep review data and attempts in typed domain and service code; expose the renderer only a safe, typed projection.
2. Map recovery UI to approved `noticeKey`, `tone`, and optional `actionKey` values. Never render provider errors, raw diagnostics, paths, prompts, or stack traces.
3. Redact and bound diagnostics at write time and again when loading or exporting historical data.
4. Bind walkthrough generation and publication to immutable `{profileId, sessionId, headSha, patchHash}` snapshot identity. Discard stale or late results.

## Keep execution isolated

1. Make narrative walkthrough generation finite and read-only: use the typed Flue seam, `tools: []`, bounded artifact reads, a fixed invocation, timeout, and cancellation.
2. Keep generation separate from review completion. It must not mutate review persistence or the invoking checkout.
3. Select supported models and reasoning at run start, default reasoning to medium, remember the profile preference, and persist the exact selection on each attempt. Do not hard-code a model label.

## Make recovery safe

1. Serialize durable lifecycle transitions through one composition-root gate; keep long-running Flue work outside the gate and re-enter only to persist transitions.
2. Reconcile restart state without claiming ownership: interrupted work offers a safe restart, never a false reconnect.
3. Make cleanup idempotent and path-checked so it cannot race a new run.
4. Treat profile changes and reload failures as ownership boundaries: clear or atomically replace old-profile workbench state, and reuse the shared Save/Discard/Cancel guard for dirty work.

## Prove the surface

1. Add focused regression coverage for raw diagnostic rejection, stale walkthrough suppression, restart recovery, cleanup races, and failed profile reload where applicable.
2. Update the stable `src/design/` scenario before production renderer work when the visible flow changes.
3. Run static and focused tests first. Delegate any live UI verification to `$patchdesk-electron-tester`.
