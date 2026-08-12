---
created_at: 2026-08-12
repos:
  - patchdesk
status: todo
adr: docs/adr/0017-separate-pr-metadata-reconciliation-from-revision-refresh.md
spec: .agents/specs/2026-08-12-pr-metadata-reconciliation-and-workbench-polish/2026-08-12-tech-spec.md
---

# Separate PR metadata reconciliation from revision refresh and polish the workbench

> **Executor instructions:** Read this plan, `CONTEXT.md`, ADR-0001, ADR-0012, ADR-0013, and the new ADR-0017 before editing. Preserve the immutable represented-review worktree, explicit GitHub-write confirmation, and existing uncertain-write recovery. This plan never authorizes a live GitHub write; use deterministic fakes and read-only Electron verification only.
>
> **Drift check:** `git diff --stat 6d37a45..HEAD -- AGENTS.md CONTEXT.md docs/adr src/main src/services src/domain src/renderer/src tests`
>
> If the current freshness/write-owner seams differ, stop and reconcile this plan. Do not silently make a metadata poll adopt a remote revision.

## Status

- Priority: P1
- Effort: M
- Risk: MEDIUM — changes the boundary between advisory GitHub state and the pinned Review revision.
- Depends on: the committed Codex provider slice (`6d37a45`) only as the current baseline; it is otherwise independent.

## Purpose

Patchdesk should show current PR review status and merge readiness without making a maintainer press **Refresh** after a confirmed Patchdesk GitHub action. At the same time, **Refresh** must retain a precise meaning: it becomes available only when the remote PR has a new code revision, and selecting it adopts that revision and its associated metadata.

The same slice corrects two visual defects documented by maintainer screenshots:

- Pierre's Changed files tree remains dark when Patchdesk is in light mode.
- The merge method and **Prepare merge confirmation** action look detached and oversized in the PR Overview sidebar.

## Fixed product decisions

- A **revision refresh** is explicit and is available only when the remote head SHA or patch differs from the represented Review session. It refreshes both code artifacts and all GitHub metadata.
- A **metadata reconciliation** is automatic and never replaces the Review session, represented-review worktree, patch, revision hash, Insight state, or draft anchoring. It may update only safe current-PR metadata: checks, review decision, merge readiness/reasons, merge method availability, mergeability, and Conversation/read-only state.
- Run metadata reconciliation immediately after a *confirmed* Patchdesk GitHub write that can affect PR state: direct review submission, pending-review start/submit/discard, Finding command completion, thread resolve/unresolve, and merge success. Run it on the existing focus/visibility and periodic observation schedule when the remote head remains unchanged.
- Do not reconcile after a failed or uncertain write. Preserve the existing recovery/retry state; it must not claim a remote result.
- If reconciliation detects a newer remote head/patch, it sets `updates_available`, pauses GitHub writes under the existing freshness gate, and does **not** apply any remote metadata snapshot. The only action is the explicit **Refresh** control.
- If reconciliation observes remote non-code activity without a head/patch change, it updates metadata in place and does **not** show **Updates available** or **Refresh**.
- A remote code revision always wins over automatic metadata presentation: do not show potentially mixed old-revision/new-revision merge readiness.
- The file tree inherits app color-scheme tokens in both system light and dark modes. Do not hard-code a dark panel or introduce a separate tree theme preference.
- The ready-to-merge sidebar has one compact action group: merge method selector, readiness context, and a right-sized **Prepare merge confirmation** action. The confirmation dialog and its explicit GitHub-write acknowledgement remain unchanged.

## Current state

- `docs/adr/0001-manual-github-refresh.md` treats all detected remote activity as a reason for an explicit refresh. It needs a superseding ADR that distinguishes a code revision from metadata-only activity.
- `ReviewWorkbenchFlow` already observes `POST /v1/reviews/detect-updates` at mount, focus/visibility, and a 90-second interval. It intentionally patches only `revision.freshness`.
- `src/main/local-api.ts` parses the detection request and delegates to the Review workbench service. The loopback route and desktop bridge already protect this boundary.
- `ReviewNavigator` uses `PierreFileTree`; the tree library's default styling is visually dark in a system-light Patchdesk session. `PierreFileTree` currently overrides only git-status colors.
- `MergeConfirmationDialog` renders the method selector in its own vertical block and a full-width outline trigger. The screenshots show it detached from the PR Overview context.
- Current full Playwright results include unrelated pre-existing fixture/accessibility failures. Record exact names and baseline evidence; focused renderer and browser cases remain required proof for this slice.

## Implementation steps

### 1. Record the revised freshness contract

Create `docs/adr/0017-separate-pr-metadata-reconciliation-from-revision-refresh.md`. It must supersede the metadata-activity portion of ADR-0001 while retaining explicit adoption of a new code revision.

Update `CONTEXT.md` terminology if needed to distinguish **metadata reconciliation**, **revision refresh**, and **Updates available**. Update ADR-0001 only with a link to the superseding decision; do not rewrite historical rationale.

**Verify:** focused documentation/contract tests, if present, show that a metadata-only response cannot make a revision refresh available.

### 2. Model the bounded observation outcome at the service boundary

Inspect the existing `ReviewWorkbench` / detection service and GitHub adapter. Replace a boolean-or-undifferentiated update outcome with a parsed, closed result that distinguishes:

- `revision_changed` — new head SHA or patch hash;
- `metadata_changed` — same represented revision with a safe current-PR metadata projection;
- `unchanged`;
- `unavailable`.

Keep external GitHub payloads at the adapter boundary. The metadata projection must exclude worktree paths, raw GitHub errors, draft content, Insight output, and any unbounded Conversation payload. Reuse existing parsers and projections for checks, review decision, merge readiness/reasons, methods, mergeability, and Conversation freshness rather than duplicating GitHub response mapping.

The service must compare the remote head and patch against the represented session before it projects metadata. If code changed, return `revision_changed` without applying metadata. Do not read, copy, or change the represented-review worktree in this path.

**Verify:** service and adapter tests cover all four outcomes, malformed response rejection, metadata projection redaction, and the invariant that a `revision_changed` result carries no metadata replacement.

### 3. Reconcile safe metadata through the protected loopback boundary

Evolve `POST /v1/reviews/detect-updates` or add a tightly scoped protected route only if the existing response cannot remain backward compatible inside Patchdesk. Keep strict request parsing and capability/origin protection in `local-api.ts` and `desktop-bridge.ts`.

Map only the bounded observation outcome to renderer DTOs. The main process remains the source of GitHub access and parsed identifiers. A metadata response must contain sufficient revision identity for the renderer to reject stale or superseded responses; it must not contain raw provider/GitHub diagnostics.

**Verify:** local API and desktop-bridge tests prove authentication/origin handling, malformed body rejection, no path/raw-error disclosure, stale response rejection, and metadata-only versus revision-changed response shapes.

### 4. Update detection and post-write behavior in the workbench

Refactor `ReviewWorkbenchFlow`'s current detector to:

1. preserve its one-in-flight, focus debounce, visibility, and explicit-refresh guards;
2. patch the metadata projection only after confirming the response belongs to the current Review/session/head/patch;
3. set `updates_available` only for `revision_changed`;
4. leave `fresh`/write authority intact for successful metadata-only reconciliation; and
5. discard automatic results while an explicit Refresh or any GitHub command is in flight.

At each confirmed GitHub-write success point, schedule one coalesced metadata reconciliation after the command completes and its local optimistic/persisted projection is applied. Do not schedule it for error, cancellation, or `OutcomeUnknown` paths. Preserve journal/recovery semantics; this is observation, not a second write or retry.

Move the Refresh affordance so it renders only for `revision_changed` freshness. When a maintainer invokes Refresh, continue using the existing full refresh path and replace both revision artifacts and metadata together.

**Verify:** renderer and coordinator tests prove: a confirmed approval updates merge readiness without Refresh; a same-head metadata change never creates a Refresh affordance; a new head creates the affordance and blocks writes; stale detector results do not patch a replaced session; two completed writes yield one reconciliation; failed/uncertain writes yield none; and explicit Refresh still replaces the whole canonical projection.

### 5. Make Pierre respect system/app theme

Audit Pierre's supported color-scheme and CSS variable APIs before styling. Configure the `PierreFileTree` container with app-owned light/dark semantic tokens and the correct `color-scheme` inheritance so a system-light app never retains the black tree canvas. Keep existing accessible status-color contrast in both modes.

Do not fork Pierre markup or apply broad global CSS that affects unrelated trees. Keep tree selection, keyboard navigation, active-path following, and virtualized scrolling behavior unchanged.

**Verify:** add focused renderer tests for semantic color-scheme attributes/variables and both light/dark snapshots where stable. Use read-only Electron/CDP verification in both system light and dark modes; check selection, folder hierarchy, and changed-file status colors.

### 6. Compact the PR Overview merge control

Refactor `MergeConfirmationDialog`'s ready state into a compact sidebar action card/group. Keep the label, selector, and trigger visible without the large empty footer or a full-width trigger. Preserve:

- blocked/acknowledgement/error/success state copy;
- explicit `Prepare merge confirmation` then `Confirm merge` two-step write flow;
- supported merge-method filtering;
- keyboard labels and focus behavior; and
- responsive wrapping at constrained sidebar widths.

Use installed shadcn/Base UI primitives and existing design tokens. Do not merge, auto-confirm, or alter GitHub-write permission policy.

**Verify:** component tests cover methods, readiness states, acknowledgement gating, and keyboard trigger behavior. Add responsive screenshot/DOM assertions for normal and narrow PR Overview widths. Read-only Electron QA must show the compact control alongside a representative diff/tree without clipping.

### 7. Run proof in order

Run focused service/API/renderer tests after each step, then:

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm exec playwright test
git diff --check
```

Before live UI checks, restart the Electron main process. Use `patchdesk-electron-tester` for read-only CDP verification only. Do not approve, merge, submit, or otherwise write to GitHub during validation.

If the full Playwright suite has unrelated failures, capture the exact test names, show baseline evidence from before this work, and run the focused browser cases for metadata reconciliation, light/dark tree appearance, and the merge-card layout.

## Done criteria

- [ ] Refresh appears only for a verified remote code revision change.
- [ ] Explicit Refresh adopts both the new revision and current PR metadata.
- [ ] Confirmed Patchdesk GitHub writes reconcile safe same-revision metadata without a Refresh click.
- [ ] Failed and uncertain writes never claim reconciled metadata.
- [ ] Automatic observation never replaces a represented revision, worktree, draft anchors, or Insight result.
- [ ] New remote code blocks GitHub writes through the existing freshness gate until explicit Refresh.
- [ ] The file tree follows light and dark app/system themes and preserves accessibility contrast.
- [ ] The PR Overview merge controls are compact, responsive, and retain their explicit two-step confirmation.
- [ ] Focused tests, standard gates, and required read-only UI proof pass, or exact unrelated browser failures are documented.

## Stop conditions

Stop and ask before proceeding if:

- GitHub cannot return safe metadata without fetching or adopting a changed code revision.
- A metadata-only response could make the represented session's head/patch ambiguous.
- The existing GitHub adapter cannot distinguish an uncertain write from a confirmed result without changing the recovery contract.
- Pierre does not offer a supported light/dark theming seam and the only workaround is a global or brittle DOM override.
- The compact merge layout would hide the selected method, acknowledgement, or explicit confirmation boundary.
