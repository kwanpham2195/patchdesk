# React Doctor follow-up references — 2026-08-14

This file names the concrete follow-up reference for diagnostics that need
static reachability or lifecycle measurement. It is not permission to remove
code or change Review authority.

## `#static-reachability`

Review unused dependencies, exports, files, fixture routes, generated catalogs,
and shared UI entry points with import/reference search, build-entry evidence,
and package smoke. Do not remove an intentional runtime-loaded or fixture-only
entry point without explicit user approval.

Covered diagnostics: unused dependency/dev dependency, unused export, unused
file, and `no-children-prop` observations in package, domain, renderer, service,
and fixture files.

Acceptance: each target has import/reference/build evidence; removals require
user confirmation when the target appears intentional; bundle and package gates
run when an entry point changes.

## `#lifecycle-measurement`

Measure effect dependency, prop-to-state, state-updater, giant-component, and
parent-callback observations through the existing renderer behavior tests and
representative live flows before changing ownership. Preserve Review freshness,
Insight cancellation, explicit Refresh, and GitHub-write gates.

Covered diagnostics: giant components, exhaustive dependencies, state adjustment,
state reset, effect chains, callback-to-parent effects, and component extraction
observations.

Acceptance: a named user-visible or maintenance benefit, focused regression
coverage, unchanged lifecycle owner, and no weakened thresholds.

## `#toolchain-hardening`

Track development-only advisory paths in
`plans/audit-2026-08-14-react-toolchain-advisories.md`. Parent upgrades require
compatibility and package proof; no incompatible override or major migration is
implied.

## Task 1 ownership record

The complete React Doctor 0.9.11 schema-3 baseline contains 207 warnings, 0 errors, score 57, complete coverage, and no skipped checks. Every original diagnostic ID remains exactly once in the disposition audit with one terminal outcome, owner, concrete evidence, exact verification, and review trigger. The Milestone 1 review repair names source-specific bounds or local allocation facts for retained performance rows, records unbounded candidates as `observation-with-owner`, and assigns package candidates to package maintenance or package-manager maintenance. Task 5 records the first grouped approval and the second explicit approval for its three cascaded exports; all approved removals are now verified.

## Task 5 static-reachability evidence (Steps 1–2)

This evidence list records the exact Step 1 searches and the Step 2 candidate
set used for the user's one grouped decision. The user approved this exact set
with “approve all”; execution and terminal outcomes are recorded in the
disposition audit and the execution record below. The second explicit approval
now authorizes the three cascaded post-removal exports documented separately
at the end of this file.

### Packages and package-manager policy

- Candidate: package `@fontsource-variable/geist` (`package.json`, unused-dependency)
  - Static references: `rg -n '@fontsource-variable/geist|@electron-toolkit/utils|font-family.*Geist|--font-geist' ...` returned only `package.json:31`; no source, resource, test, script, or build-config reference. `pnpm why @fontsource-variable/geist` reports direct production dependency `5.3.0`.
  - Build/runtime entry evidence: `src/renderer/src/styles.css` imports `@fontsource-variable/inter`, not Geist; the build and renderer bundle check passed, and no Geist module appears in the generated renderer graph.
  - Appears intentional: no; the active font contract uses Inter and no Geist entry exists. This is evidence of package residue, not authority to remove it.
  - Proposed outcome: remove dependency.
  - Required verification: `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: package `@electron-toolkit/utils` (`package.json`, unused-dev-dependency)
  - Static references: the exact package search returned only `package.json:54`; no source, test, script, or Electron build-config import. `pnpm why @electron-toolkit/utils` reports direct devDependency `4.0.0`.
  - Build/runtime entry evidence: no shipped renderer or main-process module reference was found; `pnpm build` and `pnpm test:bundle` passed without a package import.
  - Appears intentional: no; no current caller or build entry is present. This is evidence of an unused development dependency, not authority to remove it.
  - Proposed outcome: remove dependency.
  - Required verification: `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: root pnpm hardening policy (`pnpm-workspace.yaml`, two require-pnpm-hardening diagnostics)
  - Static references: `test ! -e pnpm-workspace.yaml` passed; the root workspace file is absent. `pnpm --version` returned `8.8.0`.
  - Build/runtime entry evidence: `pnpm help config` returned pnpm 8.8.0 config commands and did not document `minimumReleaseAge` or `trustPolicy`; `pnpm config get minimumReleaseAge` and `pnpm config get trustPolicy` returned empty output. `pnpm build` and `pnpm test:bundle` passed with the pinned manager.
  - Appears intentional: yes; the repository pins pnpm 8.8.0 and has no root workspace policy, so this is package-manager policy rather than a shipped source defect.
  - Proposed outcome: retain.
  - Required verification: `pnpm --version`; `test ! -e pnpm-workspace.yaml`; `pnpm help config`; both `pnpm config get` commands; `pnpm build`; `pnpm test:bundle`; package gate after any approved manager-policy change.
  - Owner: package-manager maintenance. Review trigger: explicit approval to upgrade the pinned pnpm major or create root workspace policy.

### Unused exports

- Candidate: `src/adapters/storage/json-file.ts#appendJsonLine` (unused-export)
  - Static references: exact symbol search returned only `src/adapters/storage/json-file.ts:81:export async function appendJsonLine`; no importing module.
  - Build/runtime entry evidence: the file has other storage exports but is not present in the renderer graph; no runtime or generated entry was found for this export.
  - Appears intentional: no; the export has no current caller, although the containing storage module may be reused by future main-process code.
  - Proposed outcome: remove export only.
  - Required verification: focused storage tests for `json-file.ts`; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/domain/contracts.ts#reviewPrWorkflowOutputSchema` (unused-export)
  - Static references: exact symbol search returned only its definition at `src/domain/contracts.ts:90`; no importing module.
  - Build/runtime entry evidence: no renderer graph module or runtime entry consumes this value; the containing contract module remains source-only in the current build evidence.
  - Appears intentional: no; the schema is not a current caller-facing contract, but removal still needs approval because it changes an exported surface.
  - Proposed outcome: remove export only.
  - Required verification: focused domain contract tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/domain/contracts.ts#parseGitHubPullRequestDto` (unused-export)
  - Static references: exact symbol search returned only its definition at `src/domain/contracts.ts:155`; no importing module.
  - Build/runtime entry evidence: no generated or runtime entry consumes this parser; no renderer graph module for the contract file was emitted.
  - Appears intentional: no; no current caller is present, but the parser is a boundary API and must not be deleted without authority.
  - Proposed outcome: remove export only.
  - Required verification: focused domain contract tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/domain/contracts.ts#parseReviewPrWorkflowOutput` (unused-export)
  - Static references: exact symbol search returned only its definition at `src/domain/contracts.ts:175`; no importing module.
  - Build/runtime entry evidence: no generated or runtime entry consumes this parser; no renderer graph module for the contract file was emitted.
  - Appears intentional: no; no current caller is present, but it is a boundary parser and removal needs authority.
  - Proposed outcome: remove export only.
  - Required verification: focused domain contract tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/domain/contracts.ts#parseStartReviewRequest` (unused-export)
  - Static references: exact symbol search returned only its definition at `src/domain/contracts.ts:183`; no importing module.
  - Build/runtime entry evidence: no generated or runtime entry consumes this parser; no renderer graph module for the contract file was emitted.
  - Appears intentional: no; no current caller is present, but it is a boundary parser and removal needs authority.
  - Proposed outcome: remove export only.
  - Required verification: focused domain contract tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/domain/insight-provider.ts#parseInsightSelection` (unused-export)
  - Static references: exact symbol search returned only its definition at `src/domain/insight-provider.ts:43`; no importing module.
  - Build/runtime entry evidence: no generated or runtime entry consumes this parser; no renderer graph module for the domain file was emitted.
  - Appears intentional: no; no current caller is present, but the parser belongs to the provider boundary and needs authority before export removal.
  - Proposed outcome: remove export only.
  - Required verification: focused insight-provider domain tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/domain/insight-provider.ts#isInsightProvider` (unused-export)
  - Static references: exact symbol search returned only its definition at `src/domain/insight-provider.ts:71`; no importing module.
  - Build/runtime entry evidence: no generated or runtime entry consumes this predicate; no renderer graph module for the domain file was emitted.
  - Appears intentional: no; no current caller is present, but this is a public type guard and needs authority before export removal.
  - Proposed outcome: remove export only.
  - Required verification: focused insight-provider domain tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/domain/log-entry.ts#fitsLogEntryBytes` (unused-export)
  - Static references: exact symbol search returned only its definition at `src/domain/log-entry.ts:215`; no importing module.
  - Build/runtime entry evidence: no generated or runtime entry consumes this predicate; no renderer graph module for the domain file was emitted.
  - Appears intentional: no; the function documents the log-size invariant but has no current caller in this checkout.
  - Proposed outcome: remove export only.
  - Required verification: focused log-entry tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/domain/pending-review.ts#isPendingReviewConfirmed` (unused-export)
  - Static references: exact symbol search returned only its definition at `src/domain/pending-review.ts:165`; `_tag: "Pending"` occurrences are state data, not imports of this function.
  - Build/runtime entry evidence: the pending-review module is consumed by main-process services, but this predicate has no static caller or generated entry reference.
  - Appears intentional: no; the state machine uses equivalent local tag checks and no module imports this named predicate.
  - Proposed outcome: remove export only.
  - Required verification: focused pending-review domain/service tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/domain/pull-request.ts#pullRequestInputSchema` (unused-export)
  - Static references: exact symbol search returned only its definition at `src/domain/pull-request.ts:78`; `parsePullRequestInput` is a different function and does not use this schema.
  - Build/runtime entry evidence: the containing module is present in the generated fixture chunk because `parsePullRequestInput` is used by fixture/renderer code; the schema value itself has no caller.
  - Appears intentional: no; the direct-entry schema is exported without a current importer, while the parser remains an active module API.
  - Proposed outcome: remove export only.
  - Required verification: focused pull-request domain and direct-entry tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/renderer/src/components/pr-overview-sheet.tsx#PullRequestOverviewSheet` (unused-export)
  - Static references: exact symbol search returned only its definition at line 437; no module imports this component. The containing file is imported for `PullRequestOverviewMerge` by `app-fixtures.tsx` and `review-workbench-flow.tsx`, and for `CanonicalReviewOverviewSheet` by `review-workbench.tsx`.
  - Build/runtime entry evidence: `pr-overview-sheet.tsx` is included in `assets/review-workbench-gecO0ZPS.js`; the active canonical sheet ships, while this older exported component has no caller.
  - Appears intentional: no for this export; yes for the containing module because the canonical sheet is active.
  - Proposed outcome: remove export only.
  - Required verification: focused Review overview/workbench tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/renderer/src/components/review-workbench.tsx#usePublishedFeedbackNavigation` (unused-export)
  - Static references: exact symbol search returned only its definition at line 262; no module imports this hook.
  - Build/runtime entry evidence: the containing `review-workbench.tsx` module ships in `assets/review-workbench-gecO0ZPS.js` through `ReviewWorkbench`; the named hook has no runtime caller.
  - Appears intentional: no for this export; the containing component is an active Review workbench entry.
  - Proposed outcome: remove export only.
  - Required verification: focused Review workbench tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/renderer/src/flows/inbox-flow.tsx#InboxScreen` (unused-export)
  - Static references: exact symbol search found the local JSX call at `inbox-flow.tsx:158` and the export definition at line 188; no external module imports `InboxScreen`.
  - Build/runtime entry evidence: `inbox-flow.tsx` is the renderer entry path in `assets/index-DENQ7j0L.js`; `InboxFlow` renders this component internally.
  - Appears intentional: yes for the internal screen component; no for the unused external export surface.
  - Proposed outcome: remove export only.
  - Required verification: focused Inbox/App renderer tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/renderer/src/flows/inbox-flow.tsx#Pending` (unused-export)
  - Static references: exact symbol search found the local JSX call at `inbox-flow.tsx:175` and the export definition at line 256; no external module imports `Pending`.
  - Build/runtime entry evidence: `inbox-flow.tsx` is the renderer entry path in `assets/index-DENQ7j0L.js`; `InboxFlow` renders this component internally.
  - Appears intentional: yes for the internal Pending screen component; no for the unused external export surface.
  - Proposed outcome: remove export only.
  - Required verification: focused Inbox/App renderer tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/renderer/src/review-copy.ts#WALKTHROUGH_LIFECYCLE_KEYS` (unused-export)
  - Static references: exact symbol search returned only its definition at line 116; no module imports this constant.
  - Build/runtime entry evidence: `review-copy.ts` is included in `assets/index-DENQ7j0L.js` for active copy functions, but this exported list has no caller.
  - Appears intentional: no for this export; the surrounding walkthrough copy module remains active.
  - Proposed outcome: remove export only.
  - Required verification: focused walkthrough copy/renderer tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/services/review-commit-service.ts#commitDiffFailureReason` (unused-export)
  - Static references: exact symbol search returned only its definition at line 154; no module imports this function.
  - Build/runtime entry evidence: no generated renderer entry consumes the service module; no static main-process caller was found.
  - Appears intentional: no; the service class remains an active abstraction, but this diagnostic formatter has no current caller.
  - Proposed outcome: remove export only.
  - Required verification: focused review-commit service tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/services/review-preparation-journal.ts#promoteStagedArtifact` (unused-export)
  - Static references: exact symbol search returned only its definition at line 599; no module imports this function.
  - Build/runtime entry evidence: no generated renderer entry or static main-process caller was found for the named export; the containing journal class remains an active service module.
  - Appears intentional: no for this export; no current caller establishes a runtime entry.
  - Proposed outcome: remove export only.
  - Required verification: focused preparation-journal/recovery tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/services/walkthrough-operation.ts#walkthroughInputSchema` (unused-export)
  - Static references: exact symbol search found its definition at line 27 and its local type inference at line 87; no external importer.
  - Build/runtime entry evidence: `WalkthroughInput` uses the schema locally for its inferred type, but no generated renderer or runtime entry consumes the exported schema value.
  - Appears intentional: no for the export; yes for the local schema because it still establishes `WalkthroughInput`.
  - Proposed outcome: remove export only while retaining the local schema and inferred type.
  - Required verification: focused walkthrough operation tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

### Unused files and shared UI entries

- Candidate: file `src/renderer/src/components/dashboard-empty-state.tsx` (unused-file)
  - Static references: exact file-token search returned no result; no module imports the file.
  - Build/runtime entry evidence: no generated renderer-graph module contains `dashboard-empty-state`; the build and bundle check passed without it.
  - Appears intentional: no; the component is a standalone older empty-state implementation with no current route or fixture entry.
  - Proposed outcome: remove file.
  - Required verification: focused Inbox/empty-state renderer tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: file `src/renderer/src/components/ui/dropdown-menu.tsx` (unused-file)
  - Static references: exact file-token search found no importer; the `dropdown-menu` token appears only in the file's own Base UI data-slot strings and an Item class string.
  - Build/runtime entry evidence: no generated renderer-graph module contains `dropdown-menu.tsx`; no fixture or generated catalog entry loads it.
  - Appears intentional: yes; it is a generated shadcn/Base UI primitive retained in the configured component inventory even though no current caller exists.
  - Proposed outcome: retain.
  - Required verification: focused shared-UI reachability test if a caller is approved; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: file `src/renderer/src/components/ui/item.tsx` (unused-file) plus `ItemGroup` `prefer-tag-over-role`
  - Static references: exact file-token search found no importer; exact symbol search found no external `Item`, `ItemGroup`, or related component caller. The current `ItemGroup` sets `role="list"` on a `div` at line 12.
  - Build/runtime entry evidence: no generated renderer-graph module contains `item.tsx`; no current `ItemGroup` caller makes the role/tag choice reachable.
  - Appears intentional: yes; it is a generated shared primitive retained as an available UI entry, but it is currently unreachable.
  - Proposed outcome: retain.
  - Required verification: focused shared-UI reachability test if the primitive becomes reachable; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.
  - Review trigger: replace `ItemGroup` with native `<ul>` before this primitive becomes reachable; do not change the role solely while it remains unreachable.

- Candidate: file `src/renderer/src/components/ui/toggle-group.tsx` (unused-file)
  - Static references: exact file-token search found no external importer; the file only imports Base UI `ToggleGroup` and local `toggleVariants`.
  - Build/runtime entry evidence: no generated renderer-graph module contains `toggle-group.tsx`; no fixture or runtime entry loads it.
  - Appears intentional: yes; it is a generated shared primitive retained in the configured component inventory, with no current caller.
  - Proposed outcome: retain.
  - Required verification: focused shared-UI reachability test if a caller is approved; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: file `src/renderer/src/components/ui/toggle.tsx` (unused-file)
  - Static references: exact file-token search found no external importer; `toggleVariants` appears only as an import from `toggle-group.tsx`, which is itself unreachable.
  - Build/runtime entry evidence: no generated renderer-graph module contains `toggle.tsx`; no fixture or runtime entry loads it.
  - Appears intentional: yes; it is a generated shared primitive retained in the configured component inventory, with no current caller.
  - Proposed outcome: retain.
  - Required verification: focused shared-UI reachability test if a caller is approved; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: file `src/renderer/src/format-byte-size.ts` (unused-file)
  - Static references: exact file-token search returned no result; no module imports the file. Its exported `formatByteSize` function has no exact caller.
  - Build/runtime entry evidence: no generated renderer-graph module contains `format-byte-size`; `pnpm build` and `pnpm test:bundle` passed without it.
  - Appears intentional: no; the file's comment describes a renderer consumer, but no current consumer exists.
  - Proposed outcome: remove file.
  - Required verification: focused byte-size formatting test if retained for a caller; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: file `src/renderer/src/hooks/use-mobile.ts` (unused-file)
  - Static references: exact file-token search returned no result; no module imports `useIsMobile`.
  - Build/runtime entry evidence: no generated renderer-graph module contains `use-mobile`; no fixture or runtime entry loads it.
  - Appears intentional: no; it is an unreferenced generated responsive hook.
  - Proposed outcome: remove file.
  - Required verification: focused responsive-layout test if retained for a caller; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: file `src/renderer/src/main.tsx` (unused-file)
  - Static references: the exact file search inside source/test/script/config paths returned no source import, but `src/renderer/index.html:10` is the runtime entry `<script type="module" src="/src/main.tsx">`.
  - Build/runtime entry evidence: `out/renderer/renderer-graph.json` records `/src/renderer/src/main.tsx` in entry chunk `assets/index-DENQ7j0L.js` with `isEntry: true`; the bundle check passed.
  - Appears intentional: yes; it is the live renderer bootstrap and must not be treated as dead code from module-import search alone.
  - Proposed outcome: retain.
  - Required verification: `pnpm build`; `pnpm test:bundle`; `pnpm exec playwright test`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: file `src/renderer/src/review-identity.ts` (unused-file)
  - Static references: exact file-token search returned no result; no module imports `reviewIdForSession`.
  - Build/runtime entry evidence: no generated renderer-graph module contains `review-identity`; no fixture or runtime entry loads it.
  - Appears intentional: no; the file explicitly describes an older in-memory projection path and has no current caller.
  - Proposed outcome: remove file.
  - Required verification: focused review identity/session tests if retained for a caller; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

## Task 5 Step 1–2 command record

- Exact symbol, file, and font searches from Task 5 Step 1 completed. The symbol output, candidate token output, package `pnpm why` output, and generated graph observations above are from this checkout.
- `pnpm --version` passed with `8.8.0`.
- `test ! -e pnpm-workspace.yaml` passed.
- `pnpm help config` passed and did not document `minimumReleaseAge` or `trustPolicy` for pnpm 8.8.0.
- `pnpm config get minimumReleaseAge` passed with empty output.
- `pnpm config get trustPolicy` passed with empty output.
- `pnpm build` passed; renderer entry was `assets/index-DENQ7j0L.js`, with `src/renderer/src/main.tsx` present as an entry module.
- `pnpm test:bundle` passed; Pierre theme parity and renderer bundle separation both passed (`separation: passed`).
- At the evidence-capture point before approval, no package versions, source files, tests, generated catalogs, or disposition outcomes had been changed by Task 5.

## Task 5 approved decision and execution record

The user explicitly approved the complete grouped decision set with “approve all”. The following removals were executed and verified:

- Removed dependencies: `@fontsource-variable/geist` and `@electron-toolkit/utils` from `package.json` and `pnpm-lock.yaml`.
- Removed export-only candidates: `src/adapters/storage/json-file.ts#appendJsonLine`, `src/domain/contracts.ts#reviewPrWorkflowOutputSchema`, `src/domain/contracts.ts#parseGitHubPullRequestDto`, `src/domain/contracts.ts#parseReviewPrWorkflowOutput`, `src/domain/contracts.ts#parseStartReviewRequest`, `src/domain/insight-provider.ts#parseInsightSelection`, `src/domain/insight-provider.ts#isInsightProvider`, `src/domain/log-entry.ts#fitsLogEntryBytes`, `src/domain/pending-review.ts#isPendingReviewConfirmed`, `src/domain/pull-request.ts#pullRequestInputSchema`, `src/renderer/src/components/pr-overview-sheet.tsx#PullRequestOverviewSheet`, `src/renderer/src/components/review-workbench.tsx#usePublishedFeedbackNavigation`, `src/renderer/src/flows/inbox-flow.tsx#InboxScreen`, `src/renderer/src/flows/inbox-flow.tsx#Pending`, `src/renderer/src/review-copy.ts#WALKTHROUGH_LIFECYCLE_KEYS`, `src/services/review-commit-service.ts#commitDiffFailureReason`, `src/services/review-preparation-journal.ts#promoteStagedArtifact`, and `src/services/walkthrough-operation.ts#walkthroughInputSchema` (local schema retained for `WalkthroughInput`).
- Removed files: `src/renderer/src/components/dashboard-empty-state.tsx`, `src/renderer/src/format-byte-size.ts`, `src/renderer/src/hooks/use-mobile.ts`, and `src/renderer/src/review-identity.ts`.

The following approved exceptions remain unchanged: `minimumReleaseAge` and `trustPolicy` remain absent under pnpm `8.8.0`; `src/renderer/src/main.tsx` remains the HTML-loaded renderer entry; generated UI files `src/renderer/src/components/ui/dropdown-menu.tsx`, `src/renderer/src/components/ui/item.tsx`, `src/renderer/src/components/ui/toggle-group.tsx`, and `src/renderer/src/components/ui/toggle.tsx` remain; and `ItemGroup` role remains unchanged while unreachable.

Verification completed: exact symbol searches, focused domain tests (40 tests), full `pnpm test -- --run` (112 files, 635 tests), `pnpm build`, `pnpm test:bundle`, `pnpm package:mac`, `pnpm test:package-smoke`, `pnpm lint`, `pnpm typecheck`, Oxfmt checks, `git diff --check`, no-staged check, and a complete React Doctor scan. The full 207-row audit remains ID-complete; removed rows are `fixed`, retained runtime/generated entries are `rejected-with-evidence`, the unreachable ItemGroup role remains `observation-with-owner`, and both pnpm hardening rows retain owner `package-manager maintenance` and their upgrade/policy review trigger.

## Second approval: cascaded static cleanup

The user explicitly approved removal of these three newly exposed exports. They were not part of the original 207-ID decision set and therefore do not create replacement baseline IDs:

- Candidate: `src/domain/contracts.ts#githubPullRequestDtoSchema`
  - Static references: only the export declaration remains after the approved removal of `parseGitHubPullRequestDto`; no source, test, fixture, or script caller.
  - Build/runtime entry evidence: `pnpm build` and `pnpm test:bundle` pass without a generated or runtime caller.
  - Appears intentional: no current caller remains after the approved parser removal.
  - Proposed outcome: remove declaration.
  - Required verification: focused domain contract tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/domain/contracts.ts#startReviewRequestSchema`
  - Static references: only the export declaration remains after the approved removal of `parseStartReviewRequest`; no source, test, fixture, or script caller.
  - Build/runtime entry evidence: `pnpm build` and `pnpm test:bundle` pass without a generated or runtime caller.
  - Appears intentional: no current caller remains after the approved direct-entry parser removal.
  - Proposed outcome: remove declaration.
  - Required verification: focused domain contract tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

- Candidate: `src/domain/log-entry.ts#LOG_MAX_ENTRY_BYTES`
  - Static references: only the export declaration remains after the approved removal of `fitsLogEntryBytes`; no source, test, fixture, or script caller.
  - Build/runtime entry evidence: `pnpm build` and `pnpm test:bundle` pass without a generated or runtime caller.
  - Appears intentional: no current caller remains after the approved byte-cap helper removal.
  - Proposed outcome: remove declaration.
  - Required verification: focused log-entry tests; `pnpm build`; `pnpm test:bundle`; `pnpm package:mac`; `pnpm test:package-smoke`.

These three post-removal diagnostics were reported by `.agents/research/2026-08-14-react-doctor-delta/task5-final.json`; the final scan after removal proves they are absent. They remain intentionally absent from the original 207-row audit because no replacement baseline IDs are invented. No artificial reference, compatibility shim, or suppression was added.
