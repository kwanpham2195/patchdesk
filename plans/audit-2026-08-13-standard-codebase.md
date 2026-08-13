# Patchdesk Standard Codebase Audit — evidence only

Audited state: commit `7b4f6e6` plus the five uncommitted files present during the audit.

No source files were changed by the audit. This file is not executable and has
no status row. Current execution order lives in `plans/README.md`.

## Prioritized findings

### 1. Prevent stale post-write observation from replacing Refresh

- **Category:** Correctness
- **Evidence:** `src/renderer/src/flows/review-workbench-flow.tsx:472-513` applies direct-summary observation results without the generation and snapshot checks used by normal detection at `src/renderer/src/flows/review-workbench-flow.tsx:294-310`.
- **Impact:** A delayed post-write response can replace a newer explicit Refresh projection or overwrite its freshness, metadata, Conversation, checks, or terminal state.
- **Effort:** S
- **Fix risk:** Low
- **Confidence:** High
- **Note:** This defect is introduced by the current uncommitted change. Add a deferred-response regression test where Refresh finishes before observation delivery.

### 2. Restore valid workbench tab semantics

- **Category:** Correctness / Accessibility
- **Evidence:** `src/renderer/src/components/review-workbench.tsx:776-798` has no `tablist`, while `src/renderer/src/components/review-workbench.tsx:1309-1313` gives each button `role="tab"`.
- **Impact:** Screen readers receive an invalid control structure. The targeted Axe test reports a critical `aria-required-parent` violation for Conversation, Diff, and Insights.
- **Effort:** S
- **Fix risk:** Low
- **Confidence:** High
- **Fix direction:** Implement the complete tab pattern, including keyboard behavior and linked panels, or use ordinary buttons without tab roles.

### 3. Make the packaged Flue dependency closure reproducible

- **Category:** Security / Dependencies / Packaging
- **Evidence:**
  - `scripts/stage-flue-runtime.mjs:19-37` creates a new one-dependency manifest and runs an offline install without a checked-in lock.
  - `scripts/stage-flue-runtime.mjs:75-91` can copy dependencies from a previously packaged application.
  - `package.json:91-104` ships that generated runtime.
  - The root lock includes affected production packages such as `fast-uri` at `pnpm-lock.yaml:6114` and `js-yaml` at `pnpm-lock.yaml:6821`.
- **Impact:** The same source commit can package different transitive dependencies according to the machine cache or an older installed package. Security fixes and regressions are therefore difficult to audit or reproduce.
- **Effort:** M
- **Fix risk:** Medium
- **Confidence:** High
- **Audit signal:** `pnpm audit --prod --audit-level high` reported 9 high advisories. Individual reachability varies, so the audit does not report each advisory separately.

### 4. Separate immutable Analysis publication from legacy mutable `ReviewBatch`

- **Category:** Architecture / Tech debt
- **Evidence:**
  - ADR-0014 supersedes the editable local Review draft at `docs/adr/0014-use-github-pending-reviews-for-review-drafting.md:9`.
  - New sessions still create and carry local batches at `src/services/review-session-preparation.ts:446-474`.
  - Mutable batch routes remain exposed at `src/main/local-api.ts:1257-1261` and `src/main/desktop-bridge.ts:53-80`.
  - A complete `DraftSlot` is still mounted inside a hidden container at `src/renderer/src/components/review-workbench.tsx:1004-1009`.
- **Impact:** The implementation retains two authoring state machines and couples the approved immutable Analysis publication exception to obsolete mutable-draft machinery. Recovery, storage, and write-safety changes must account for both.
- **Effort:** L
- **Fix risk:** High
- **Confidence:** High
- **Boundary:** Preserve the exact immutable per-Analysis-run publication authorization. Remove only mutable legacy authority after it has a dedicated replacement.

### 5. Split the Review workbench from the initial renderer bundle

- **Category:** Performance
- **Evidence:**
  - `src/renderer/src/app.tsx:3` statically imports the workbench.
  - The workbench statically imports diff rendering through `src/renderer/src/components/review-workbench.tsx:49`.
  - Pierre enters through `src/renderer/src/components/review-diff-view.tsx:19-20`.
  - The production entry chunk is approximately 3.7 MB, or 736 KB gzip.
- **Impact:** Inbox and settings startup must parse the Review, Pierre, syntax, and Markdown implementation before a Review is opened.
- **Effort:** M
- **Fix risk:** Medium
- **Confidence:** High
- **Fix direction:** Add route-level lazy loading and a size or route-loading regression check.

### 6. Correct the README write-safety statement

- **Category:** Documentation
- **Evidence:**
  - `README.md:19` says all GitHub writes always require explicit confirmation.
  - `AGENTS.md:43` and the implemented publication-authorization path define one exact immutable Analysis-run exception.
- **Impact:** The main safety document gives maintainers an incorrect authorization model.
- **Effort:** S
- **Fix risk:** Low
- **Confidence:** High

### 7. Document the supported development runtime

- **Category:** DX / Documentation
- **Evidence:**
  - `README.md:7-12` documents only the basic local commands.
  - `package.json:14-22` also defines browser, accessibility, performance, packaging, and smoke gates.
  - pnpm is pinned at `package.json:81`, but no tracked Node version or `engines` requirement exists.
- **Impact:** New contributors cannot reproduce the expected runtime or determine the full verification sequence.
- **Effort:** S
- **Fix risk:** Low
- **Confidence:** High

## Direction options

### Surface retained Insight provenance

`src/domain/insight-record.ts:18-23` stores provider, model, and reasoning, but `src/renderer/src/renderer-contracts.ts:397-416` omits them. A compact provenance label would help maintainers judge retained Analysis and Walkthrough results.

- **Effort:** M
- **Product risk:** Low if only non-secret fields are projected.

### Make Walkthrough Support inspectable

`src/renderer/src/components/narrative-walkthrough.tsx:407-436` lists Support paths and permits marking all Support reviewed, but only primary sections render evidence at `src/renderer/src/components/narrative-walkthrough.tsx:518-539`. A bounded Support reader would make the review claim more meaningful.

- **Effort:** M
- **Trade-off:** It must not become another full Files surface.

### Show what changed since an outdated Insight

Outdated results remain readable by design, but `src/renderer/src/flows/review-workbench-flow.tsx:1996-2001` shows only old and current short SHAs. A read-only revision delta could help maintainers decide whether to regenerate.

- **Effort:** L
- **Product risk:** High. It must never make old Findings actionable.

## Considered and rejected

- **GitHub Actions CI:** Not recommended because this checkout has no configured remote.
- **Flue beta.9 upgrade:** Superseded by the product owner's 2026-08-13 request
  to migrate to latest. The investigated migration is now
  `plans/006-migrate-pi-insights-to-flue-2.md`; it follows Plan 005 because
  Flue 2 removes workflows and Plan 005 first deletes obsolete invocation
  fields. Plan 004 first makes the packaged closure reproducible.
- **Every audit advisory as a separate finding:** Rejected because reachability was not proven for each package.
- **Large-file refactoring by itself:** Rejected; file size alone is not evidence.
- **Legacy PR overview controls as a current user-facing defect:** Rejected because the canonical overview does not mount that older component.
- **General Playwright failure cleanup:** Not reported because the full suite timed out; only the reproduced tab failure was vetted.

## Audit limits

The audit did not fully cover:

- Live GitHub writes or recovery mutations
- Live Pi or Codex execution
- macOS packaging and package smoke
- Every source file at deep-audit depth
- Every transitive advisory's runtime exploitability
- The complete Playwright suite

## Disposition in the revised portfolio

- Finding 1 -> Plan 001.
- Finding 2 -> Plan 002.
- Findings 6 and 7 -> Plan 003.
- Finding 3 -> Plan 004, then Plan 006 updates the closure for Flue 2.
- Finding 4 -> Plan 005.
- Finding 5 -> Plan 007 after the architecture migrations stabilize imports.
- Direction options remain unselected and have no implementation plans.
