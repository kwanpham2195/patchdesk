---
created_at: 2026-08-12
repos:
  - patchdesk
status: todo
adr: docs/adr/0017-separate-pr-reconciliation-from-revision-refresh-and-merge-confirmation.md
spec: .agents/specs/2026-08-12-pr-metadata-reconciliation-and-workbench-polish/2026-08-12-tech-spec.md
---

# Reconcile same-revision GitHub state and polish the workbench

> Read this plan, its linked spec, `CONTEXT.md`, ADR-0001, ADR-0012, ADR-0013, and ADR-0017 before editing. Preserve immutable represented-review worktrees, explicit GitHub-write confirmation, and uncertain-write recovery. Use deterministic fakes and read-only Electron verification only; this plan never authorizes a live GitHub write.

## Status

- Priority: P1
- Effort: L
- Risk: HIGH — changes reconciliation, draft ownership, and merge-write contracts.

## Purpose

Patchdesk should quietly present current GitHub state for the represented revision without making maintainers press **Refresh** after a confirmed action. Refresh remains the explicit operation that adopts changed code. The same slice fixes the light-theme file tree and changes the sidebar merge UX to a method selector plus one **Merge** command.

## Fixed product decisions

- **Revision identity** is the represented head SHA, base SHA, and patch identity. A changed or unprovable identity means automatic reconciliation applies no metadata or draft state; it sets `updates_available` for a verified change or `unavailable` when it cannot prove identity. Either blocks writes; only verified revision change shows Refresh.
- **Same-revision reconciliation** quietly saves bounded PR metadata, Conversation, merge readiness/methods, and the authoritative viewer pending review. It never changes session, worktree, revision-bound Insights, or patch artifacts.
- GitHub's current pending-review state replaces Patchdesk's confirmed state when it differs and no pending-review operation is in flight or `OutcomeUnknown`. Drafts are never merged. Old receipt provenance remains history; a Finding is actionable again only with evidence it is neither pending nor published.
- Terminal merged/closed state is the narrow exception: adopt terminal lifecycle and stop writes, but do not adopt changed revision metadata or a worktree.
- Keep typed Finish-review summary text stable across a quiet draft replacement/removal. Submit checks an opaque pending-review revision token; drift blocks submit and asks the maintainer to reopen/review. Discard acts on the current adopted draft; absent draft reports no action.
- Run one coalesced read-only observation after confirmed state-changing Patchdesk writes, and on the existing visible-workbench focus/visibility/periodic schedule. Never observe after failed or uncertain writes; never retry a write.
- The changed-files tree inherits the active app light/dark theme with no separate preference.
- Merge uses a selected method and explicit **Merge** button; no confirmation dialog. Warnings require acknowledgement bound to the exact revision and warning code set. The final merge read returns typed outcomes. Refresh applies only to changed revisions; uncertain merge uses existing recovery.

## Implementation steps

### 1. Record decisions and terms

Create ADR-0017; link it from ADR-0001 without rewriting ADR-0001 history. Keep `CONTEXT.md` a glossary: revision identity, same-revision reconciliation, terminal state, pending-review reconciliation, merge command, and unavailable state. Update Conversation wording: it reconciles automatically for its represented revision.

### 2. Add typed revision and observation contracts

Add a reusable `ReviewObservationService`, not more logic to `ReviewRefreshService`. It owns review-level serialization, two revision reads, bounded GitHub reads, snapshot persistence, terminal handling, and standard workbench projection. `PendingReviewService` remains sole owner of draft transitions and receipt invariants.

Model `reconciled`, `revision_changed`, `unavailable`, `terminal`, and `unchanged` as a closed union. Require full represented revision identity before any automatic projection. Do not put raw GitHub payloads, paths, draft body, Insight output, or raw errors in renderer DTOs.

### 3. Reconcile the authoritative draft safely

Give `PendingReviewService` a same-revision adoption transition. It must retain locked writes unchanged, replace confirmed remote draft state, and classify receipts as pending, published, or historical/superseded based on evidence. When evidence is incomplete, do not re-enable a Finding.

Create an opaque pending-review revision fingerprint. Finish-review open captures it; Submit sends it and returns `pending_review_changed` before a write if the authoritative draft differs. Keep dialog draft text in a controller that survives workbench projection replacement. Direct reply text stays visible but cannot use Comment now after an adopted pending review appears.

### 4. Project and schedule observation through the protected boundary

Evolve `POST /v1/reviews/detect-updates` with strict parsing and a bounded closed response. Renderer identity-checks response review/session/revision before applying it. Preserve one in-flight observation, visibility/focus guards, and coalescing. Successful same-revision observation clears unavailable and restores write availability automatically. Verified revision change marks stale and exposes Refresh. Explicit Refresh stays the only code/worktree adoption path.

### 5. Replace merge dialog with a typed compact merge command

Replace `MergeConfirmationDialog` with a compact PR Overview action group: method selector, readiness/warning context, acknowledgement control where needed, and **Merge** button. Keep accessible labels, focus behavior, wrapping, selected-method retention, and error/recovery state.

Pass `MergeWarningAcknowledgement { revisionIdentity, warningCodes }`, not a boolean. At merge execution, re-read identity/readiness: return `readiness_changed`, `revision_changed`, `unavailable`, `outcome_unknown`, or `merged`. Changed warnings invalidate acknowledgement. On success reload terminal projection; never retry an uncertain merge.

### 6. Make Pierre inherit theme

Use Pierre's supported color-scheme/CSS-variable seam from the immediate container. Preserve tree keyboard navigation, selection, follow-active behavior, scrolling, and status-color contrast.

### 7. Prove each vertical slice

1. Same-revision metadata persists/projection updates; revision identity and worktree remain unchanged.
2. Base/head/patch change produces `revision_changed`; unprovable identity produces `unavailable`; terminal state wins narrowly.
3. Pending draft adoption, locked-state preservation, receipt history/evidence, and Finish-review token/text behavior.
4. Protected route parsing, redaction, renderer stale-response rejection, post-write coalescing, and recovery behavior.
5. Typed final merge outcomes and revision/warning-bound acknowledgement.
6. Pierre light/dark and compact merge component/rendering tests.

Then run:

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm exec playwright test
git diff --check
```

Restart Electron before read-only CDP QA. If full Playwright has unrelated failures, record exact baseline failures and run focused browser cases.

## Done criteria

- [ ] Same-revision state, including bounded Conversation and authoritative draft, reconciles quietly.
- [ ] Changed/unprovable revision identity never gets mixed metadata; writes block correctly.
- [ ] Refresh appears only for verified revision change and remains the sole worktree/code adoption path.
- [ ] Draft drift preserves typed Finish-review text and blocks only unsafe Submit.
- [ ] Receipt history cannot produce duplicate Finding comments.
- [ ] Compact Merge has no dialog, rechecks current GitHub state, and binds warning acknowledgement to exact warnings/revision.
- [ ] Tree follows app light/dark mode and keeps contrast/accessibility.
- [ ] Focused tests, standard gates, and read-only UI proof pass or documented unrelated browser failures remain.

## Stop conditions

Stop and ask if GitHub cannot supply enough evidence to prove revision identity or receipt publication state, if pending-review recovery cannot distinguish an unresolved write, or if Pierre requires a brittle/global theme override.
