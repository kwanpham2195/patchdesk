---
created_at: 2026-08-09
repos: [patchdesk]
status: implementation-under-validation-waiver
spec: .agents/archive/inline-diff-conversations/spec.md
tech-spec: .agents/archive/inline-diff-conversations/tech-spec.md
---

# Summary-only GitHub review

> **Executor instructions:** This plan is validation-gated. Do not implement a summary-only write, create an empty pending review, add a menu item that promises the feature, or make a live GitHub write until Step 1 has a recorded product decision and Step 2 has recorded redacted spike evidence. Preserve ADR-0014: a GitHub pending review is authoritative only after it exists; Patchdesk must not create a local editable Review draft as a substitute.

## Status

- **Priority:** P1
- **Effort:** M/L
- **Risk:** HIGH — a review summary is a visible GitHub write that can approve, comment, or request changes.
- **Planned at:** `9c820d1` on `fix/inline-conversation-freshness-repair`
- **Validation waiver:** the product owner explicitly waived the remaining live rows (pending conflict, lost response, stale head, and reader completeness) and directed implementation to proceed. Product confirmation and direct Comment/Approve/Request changes evidence are recorded in `.agents/research/2026-08-10-summary-only-review-direct-submission-spike.md`.
- **Related work:** `.agents/PLANS/2026-08-09-pending-review-inline-lifecycle.md` must remain correct before this feature is layered on top.

## Goal

Let a maintainer submit a GitHub review summary with a Comment, Approve, or Request changes decision when they have no inline threads and no authenticated viewer pending review.

The existing **Start a review** header action must not silently do nothing on the Diff tab. It must make the two distinct starting paths understandable:

- add an inline comment, which starts a GitHub pending review with that first thread;
- write a summary-only review, which publishes one immediate GitHub review without creating a pending review.

## Recommended product model

Use a **direct submitted summary review**, not an empty GitHub pending review.

Why:

- Empty pending review creation is unproven and would introduce an invisible remote owner with zero threads.
- A direct summary review matches the user’s actual intent: publish a final review now, with no later inline comments attached to it.
- It preserves the existing invariant that an active pending review is the sole editable Review owner. A summary-only review has no editable owner after it is submitted.
- It avoids overloading **Finish review** with a state that has no pending comments.

The plan remains blocked until the product owner confirms this model. If the owner instead wants a summary that remains editable before submission, stop and create a separate empty-pending-review validation/design plan; do not adapt this one.

## Product contract

After the model is confirmed:

- The header action when no viewer pending review exists opens a small **Start review** choice surface rather than silently switching tabs.
  - **Add inline comment** navigates to Diff and gives concise guidance to select a changed line. It does not create an empty remote review.
  - **Write review summary** opens a dedicated summary-review dialog.
- The summary dialog is a direct-write surface, not `FinishReviewDialog` and not a pending-review editor.
  - It identifies the action as publishing immediately.
  - It offers **Comment**, **Approve**, and **Request changes** using title-case user labels; API enum values remain internal.
  - The summary body is required and nonblank, so the action never creates an accidental empty review.
  - Its only write control is explicit **Submit review**. Close cancels locally.
- The action is unavailable while the viewer has a confirmed pending review. The header instead shows **Finish review · N**.
- Before sending, the service validates the represented session/head/patch and rechecks the viewer pending state. A newly discovered pending review blocks summary submission and directs the maintainer to finish that review; it never creates a second review.
- A typed operation intent is persisted before the write. A normal confirmed response records a receipt. A timeout/lost response becomes `OutcomeUnknown`, locks conflicting controls, never retries automatically, and offers **Check GitHub again** only in recovery.
- A successful direct summary does not automatically replace the represented snapshot. It gives a local confirmed receipt and relies on explicit Refresh for the represented GitHub snapshot, while own-write detection prevents a false **Updates available** warning.

## Validation spike — required before implementation

Use a separately authorized disposable PR and dedicated test account. Record only redacted evidence under `.agents/research/`; delete harnesses and temporary configuration afterward. Each authorized write runs exactly once. Do not reuse a real working PR, alter an existing pending review, or clean up by additional writes without explicit approval.

### Required rows

1. **Baseline bounded read** — prove complete absence of a viewer pending review and record the current head.
2. **Direct Comment summary** — submit a nonempty body with no inline comments. Prove it creates a submitted review, does not create a `PENDING` review, retains the expected commit/head, and appears through the bounded published-review reader.
3. **Direct Approve summary** — repeat on a separate disposable PR or permitted test state. Prove event/body/read-back semantics.
4. **Direct Request changes summary** — repeat on a separate disposable PR or permitted test state. Prove event/body/read-back semantics.
5. **Pending conflict** — create a viewer pending review through the already-proven first-thread flow, then attempt the direct-summary preflight. Prove Patchdesk/GitHub rejects it without creating a second review. Discard the test pending review only if that deletion is separately authorized.
6. **Lost response** — send exactly one direct summary write whose client response is intentionally lost after request dispatch. Use a pre-write baseline of matching submitted-review identities. A bounded read must distinguish one new matching review, confirmed absence, and ambiguity; never issue a retry.
7. **Stale head** — advance the test PR head after opening the dialog but before the write. Prove the exact-head gate blocks the write before GitHub mutation.
8. **Reader completeness** — prove pagination/incomplete reads become unavailable rather than absence.

### Spike stop conditions

Stop and revise scope if:

- GitHub cannot create a direct no-inline review with a nonempty body and selected event;
- a direct summary can coexist with a viewer pending review despite preflight;
- a lost response cannot be reconciled unambiguously from a bounded reader and durable pre-write baseline;
- exact-head validation cannot prevent a stale summary write;
- required reader data cannot be obtained without exposing credentials or persisting a local editable summary.

## Implementation steps

### Step 1: Characterize the no-pending header and direct-review boundary

Before production changes, add focused tests at the existing workbench-flow and renderer seams for:

- no pending review: the header opens the start-choice surface, not a no-op;
- Add inline comment navigates to Diff and exposes only guidance, without a GitHub write;
- Write review summary opens the direct-summary dialog;
- a pending projection renders **Finish review · N** and does not expose the start-choice surface;
- unavailable/recovery state blocks both start paths and retains the existing explicit recovery treatment.

Add the dialog tests for title-case decision labels, nonblank-body gating, immediate-publication copy, close-without-write, and keyboard/focus behavior.

**Verify:** focused renderer tests first fail against the current silent header action, then pass after the new surface exists.

### Step 2: Add a narrow direct-summary service after spike evidence exists

Create a dedicated domain/service boundary for direct summary submission. Do not add an `EmptyPendingReview` state or reuse local `ReviewBatch`/`batchContent` persistence.

The service must:

1. accept parsed profile/review identity, expected session/head/patch, decision, and nonblank body;
2. require write capability and exact freshness;
3. read the viewer pending-review state immediately before mutation and return typed `pending_review_exists` when applicable;
4. persist typed intent and a pre-write baseline of matching submitted-review identities;
5. invoke only the spike-proven adapter operation;
6. persist the returned receipt before reporting confirmed success;
7. translate expected outcomes into typed failures: rejected, stale_head, pending_review_exists, unavailable, and outcome_unknown;
8. reconcile an unknown write only from an explicit user action. It may confirm a single new matching review, confirm complete absence, or remain locked when ambiguous.

Keep request JSON parsing in `src/main/local-api.ts`; pass refined values only into the service. The loopback capability boundary and desktop bridge allowlist must cover only the exact new route.

**Verify:** service tests use its existing fake GitHub gateway seam to prove preflight ordering, no second review under a pending conflict, intent-before-write, receipt persistence, no retry, and each recovery result.

### Step 3: Implement the adapter and bounded reconciliation contract

Add the exact spike-proven REST/GraphQL operation to `src/adapters/github/github-adapter.ts` and strict response parsing.

- Keep `COMMENT`, `APPROVE`, and `REQUEST_CHANGES` API values inside the adapter/service boundary.
- Read-back matching uses the durable baseline plus viewer, event, body, commit/head, and bounded timestamp window. It must never treat a merely similar older review as the new write.
- Incomplete/paginated reads return unavailable, not no match.
- Never log raw summary text, authorization, or raw GitHub response bodies.

**Verify:** adapter command-construction and parser tests cover all three events, nonempty body, bounded pagination, and normalized failure categories. The live spike is evidence for GitHub behavior; fake process tests alone are not evidence.

### Step 4: Build the header choice and summary dialog

Implement renderer composition only after Steps 1–3 pass.

1. Replace the no-pending header’s silent navigation-only handler with an accessible `Start review` popover/dialog containing the two explicit paths. Reuse installed shadcn/Base UI primitives; do not invent a custom overlay.
2. Keep inline composer behavior unchanged: its **Start a review** action still starts from the selected first thread.
3. Add `SummaryReviewDialog` rather than adding zero-comment behavior to `FinishReviewDialog`.
4. Make the dialog responsive: `min-w-0`, viewport-safe width, wrapping/stacking controls, explicit labels, focus restoration, and no color-only state.
5. On successful submission, close the dialog, present a confirmed local receipt, and retain no editable summary state. On a confirmed failure, show a typed message. On unknown, replace controls with recovery guidance and no retry.
6. Add the confirmed direct review to the existing recent-write normalization only after its receipt is known, so background detection does not flag the app’s own published summary as an external update. Do not suppress unrelated comments, checks, or head changes.

**Verify:** renderer tests prove the two no-pending paths, submission gating, pending conflict treatment, receipt/unknown presentation, focus behavior, title-case decision labels, and responsive footer behavior. Browser tests cover dialog geometry at 960px, 1280px, and 1440px without horizontal overflow.

### Step 5: Full verification and authorized live proof

Run, in order:

1. focused adapter, service, local-API, renderer, flow, and refresh-service tests;
2. `pnpm typecheck`;
3. `pnpm lint`;
4. `pnpm test -- --run`;
5. `pnpm build`;
6. relevant Playwright workbench tests;
7. `git diff --check`.

Restart the Electron main process for main-process changes. Read-only live QA can verify the no-pending header choice, dialog layout, decision labels, nonblank validation, Close behavior, and console/page errors.

A valid live submission test requires a separately authorized disposable PR/account. Do not substitute a production PR, user-owned pending review, build result, or fixture-only test for that proof.

## Files expected to change

- `src/domain/` — a focused direct-summary operation/intent type only if current pending-operation types cannot express a non-pending write without misnaming it.
- `src/services/` — direct summary service and bounded recovery/read matching.
- `src/adapters/github/github-adapter.ts` — exact spike-proven direct summary operation and parser.
- `src/main/local-api.ts` and `src/main/desktop-bridge.ts` — strict capability-bound route and DTO parsing.
- `src/renderer/src/components/review-workbench.tsx` — no-pending header choice.
- `src/renderer/src/components/summary-review-dialog.tsx` — new direct summary dialog.
- `src/renderer/src/flows/review-workbench-flow.tsx` — command invocation, confirmed receipt, recovery, and own-write normalization.
- focused domain/service/adapter/local-API/renderer/flow/refresh/browser tests.
- `.agents/PLANS/README.md` — plan status and actual verification.

## Done criteria

- [ ] Product owner has confirmed direct immediate summary submission rather than an empty pending review.
- [ ] Redacted spike evidence proves all selected events, pending conflict, lost-response reconciliation, stale-head block, and reader completeness.
- [ ] No-pending header offers visible inline and summary paths; it is never a silent Diff-tab no-op.
- [ ] Summary-only review requires nonblank content, clearly publishes immediately, and creates no pending review.
- [ ] Confirmed pending review blocks direct summary submission and retains the single pending owner.
- [ ] Summary writes persist intent and receipt, fail closed on uncertainty, and never retry automatically.
- [ ] Own direct summary write does not produce a false update warning; unrelated updates still do.
- [ ] Focused tests, typecheck, lint, full suite, build, browser checks, diff check, and separately authorized live proof pass.

## Explicitly rejected alternatives

- **Empty pending review by default:** unproven GitHub behavior and an invisible zero-thread remote owner. This requires a distinct plan if selected.
- **A local summary draft:** violates the authoritative GitHub pending-review decision and reintroduces local draft recovery/migration complexity.
- **Auto-submit on header click:** a GitHub review decision must remain explicit and reviewable.
- **Automatic retry after timeout:** risks duplicate public reviews.
