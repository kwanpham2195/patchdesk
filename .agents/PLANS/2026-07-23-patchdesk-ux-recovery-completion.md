---
created_at: 2026-07-23
repos:
  - patchdesk
status: complete
plan: .agents/PLANS/2026-07-23-patchdesk-ux-recovery-completion.md
supersedes:
  - .agents/PLANS/2026-07-23-patchdesk-ux-accessibility.md
---

# Patchdesk UX recovery completion

This ExecPlan is a living document. Keep **Progress**, **Surprises & Discoveries**, **Decision Log**, and **Outcomes & Retrospective** current as work proceeds.

## Purpose / Big Picture

Finish the incomplete parts of the Patchdesk UX and accessibility pass without weakening its review-safety boundary. A maintainer will be able to open a pull request, inspect its immutable local diff and checks before a model runs, explicitly configure and start one review, understand its safe progress, inspect a complete structured result, refresh the Inbox without disturbing the review, and choose any bundled Pierre/Shiki light theme and dark theme independently.

The finished product remains read-only until a separate existing GitHub-write confirmation is accepted. The Electron renderer remains isolated: it never runs shell commands, sees no credentials, and receives only validated local API projections.

This replaces the remaining work in `.agents/PLANS/2026-07-23-patchdesk-ux-accessibility.md`. Keep that earlier plan unchanged as an audit record; update its status only after this plan is fully accepted.

## Progress

- [x] 2026-07-23: Audited the prior plan against `feat/patchdesk-phase-1`; recorded the gaps that this plan resolves.
- [x] 2026-07-23: Replaced the fixed two-family theme assumption with direct, independently saved light/dark selections from Pierre's public bundled catalog; new defaults are `pierre-light` and `pierre-dark`.
- [x] 2026-07-23: Replaced the planned separate Collapse and Expand toolbar actions with one stateful unchanged-context toggle, matching the compact Wrap control.
- [x] 2026-07-23: Removed the planned workbench Options menu. Theme selection belongs in Settings; direct diff controls remain visible only when they change the current review surface.
- [x] 2026-07-23: Added a PR-first Overview briefing so maintainers read a safe, rich GitHub-flavored Markdown pull-request description before explicitly entering the diff.
- [x] 2026-07-24: Corrected Pierre's controlled CodeView integration: collapsed-file state now flows through controlled items, all-files appends scroll through Pierre after its layout update, and large-patch selection remains responsive without wheel/touch interception.
- [x] 2026-07-24: Added readable added/deleted syntax tokens inside Pierre's shadow root through its documented `unsafeCSS` option; refreshed the verified split-view visual baseline.
- [x] 2026-07-24: Verified the packaged customer-management PR #118 pre-run workbench over CDP. It opened read-only, exposed the compact toolbar, selected a tree file, switched Split, rendered appended files, and showed no page overflow or console/page errors. No review was started and no GitHub write confirmation was opened.
- [x] 2026-07-24: Milestone 0: Added focused regression seams and a preload-gated Pierre scroll diagnostic; browser coverage proves native scrolling and virtualized append behavior.
- [x] 2026-07-24: Milestone 1: Made review start allocation truthful, session-owned, retry-safe, and recoverable.
- [x] 2026-07-24: Milestone 1.5: Added the safe PR-description Overview briefing before diff navigation.
- [x] 2026-07-24: Milestone 2: Made Pi model selection authoritative, current, profile-scoped, and safely rendered.
- [x] 2026-07-24: Milestone 3: Completed bounded run metadata/activity and visible active-review state.
- [x] 2026-07-24: Milestone 4: Adapted the agreed pi-review rubric and completed structured results, finding navigation/detail, local Fix queue, and checks presentation.
- [x] 2026-07-24: Milestone 5: Completed Inbox freshness, full paired Pierre theme selection, appearance changes, and non-color status presentation.
- [x] 2026-07-24: Milestone 6: Resolved virtualized Pierre scrolling, real expandable unchanged hunks, and Settings-only discovery limits from packaged diagnostics.
- [x] 2026-07-24: Milestone 7: Ran focused, full, and packaged acceptance; updated this and the superseded plan status.

## Surprises & Discoveries

- Observation: a saved PR patch can be inconsistent with its recorded immutable head when it was created from GitHub's mutable `gh pr diff` endpoint.
  Evidence: the saved customer-management PR #118 patch had a `main.go` hunk incompatible with the recorded head's exact source; Pierre raised `trailing context mismatch` while estimating its virtual height.

- Resolution: normal session preparation now creates the patch only from immutable refs or GitHub's immutable `base...head` comparison. Exact source hydration reads only those session-owned refs and rejects a legacy mismatch as unavailable context instead of passing impossible metadata to Pierre.
  Evidence: `src/services/review-worktree-service.ts`, `src/adapters/github/github-adapter.ts`, and `src/services/review-diff-source-service.ts`; regression coverage is in `tests/services/review-worktree.test.ts`, `tests/adapters/github-adapter.test.ts`, and `tests/services/review-diff-source-service.test.ts`.

- Observation: Inbox refresh scheduling is already implemented. The remaining freshness gap is visible time text and complete package-level proof, not polling mechanics.
  Evidence: `src/renderer/src/inbox-refresh-scheduler.ts` implements entry, foreground, polling, backoff, and single-flight behavior.

- Resolution: the append-time outer scroll nudge was removed. The QA-only diagnostic is enabled only by the typed preload flag; normal wheel, trackpad, key, and virtualized all-files interactions remain owned by Pierre.
  Evidence: `src/renderer/src/components/review-diff-view.tsx`, `src/preload/index.ts`, and `tests/browser/milestone-9.spec.ts`.

- Observation: Patchdesk requests Pierre's `line-info` hunk separator, but its files come from `parsePatchFiles` over the raw GitHub patch. Pierre therefore marks them `isPartial` and deliberately removes separator expansion controls because it has no omitted base/head lines to reveal.
  Evidence: `src/renderer/src/components/review-diff-view.tsx` sets `hunkSeparators: "line-info"`; `src/renderer/src/review-diff-data.ts` calls `parsePatchFiles`. Installed `@pierre/diffs@1.2.12` exposes `processFile(rawPatch, { oldFile, newFile })`, which creates non-partial metadata and enables the built-in `data-expand-button` controls.

- Observation: Patchdesk has not yet adapted the detailed review rubric from the agreed upstream reference. Its prompt has only general evidence-first sentences, and its result schema cannot represent the upstream callouts or the complete explanation of a finding.
  Evidence: `src/services/model-review-runner.ts` builds the prompt inline; `src/domain/review-result.ts` lacks callouts, affected scenario, why-it-matters, suggested change, unresolved items, and coverage. The reviewed upstream source is `earendil-works/pi-review` commit `f1de050`, `review.ts`, cached at `~/.cache/checkouts/github.com/earendil-works/pi-review/review.ts`.

- Observation: Patchdesk currently persists only the two fixed `github` and `high_contrast` theme families. It passes only the active member to Pierre, even though the installed public API accepts a `{ light, dark }` pair.
  Evidence: `src/renderer/src/diff-theme-preferences.ts` defines only `DiffThemeFamily`; `review-diff-view.tsx` calls `diffThemeFor(themeFamily, appearance)`. Installed `@pierre/diffs@1.2.12` declares `theme?: DiffsThemeNames | ThemesType`, where `ThemesType` is a light/dark pair.

- Observation: Pierre's supported catalog already contains its five light and five dark themes plus 65 classified Shiki themes with lazy loaders. The authoritative catalog package is available at the current `@pierre/theming@0.0.2` release and is maintained in the Pierre source tree.
  Evidence: `@pierre/theming/themes` exports `themes`; cached `pierrecomputer/pierre` source at `~/.cache/checkouts/github.com/pierrecomputer/pierre/packages/theming/src/themes.ts` combines the Pierre and Shiki collections. `pnpm view @pierre/theming version time --json` reports `0.0.2`, published 2026-06-26.

## Decision Log

- Decision: Treat a prepared review snapshot as session-owned, not as a synthetic attempt `001`.
  Rationale: a prepared snapshot must exist before any review attempt and must be reusable safely by attempts `001`, `002`, and later retries.
  Date/Author: 2026-07-23 / Codex and Matthew.

- Decision: Allocate an attempt only after model catalog validation and an immediate current-head check, then serialize allocation per `(profileId, sessionId)`.
  Rationale: it prevents duplicate starts and prevents an unavailable model or changed PR head from leaving persistent attempt state.
  Date/Author: 2026-07-23 / Codex and Matthew.

- Decision: Preserve `medium` as the product default reasoning level. A valid saved per-profile selection wins; historical attempt metadata is never rewritten.
  Rationale: it matches the approved UX contract while keeping runtime catalog data safe and current.
  Date/Author: 2026-07-23 / Codex and Matthew.

- Decision: A model review result is a safe structured document. Missing optional rich fields from old sessions render as `Not provided by this review`; raw provider output never becomes a fallback UI.
  Rationale: stored reviews stay readable without exposing prompts, hidden reasoning, logs, or provider-specific data.
  Date/Author: 2026-07-23 / Codex and Matthew.

- Decision: Adapt the review instructions and rubric from `earendil-works/pi-review@f1de050` into a Patchdesk-owned, schema-backed instruction module. Do not copy its UI, shell commands, GitHub CLI calls, session implementation, or arbitrary project-file discovery.
  Rationale: the rubric has the desired review quality bar, but Patchdesk must keep its read-only inspector boundary, constrained tools, and Electron privilege separation. If substantial wording is retained, add the upstream MIT notice and copyright to a new `THIRD_PARTY_NOTICES.md`.
  Date/Author: 2026-07-23 / Codex and Matthew.

- Decision: Human reviewer callouts are structured informational records, not findings, and never change a verdict by themselves.
  Rationale: migrations, dependency churn, auth, compatibility, destructive operations, feature flags, and configuration changes matter to maintainers even when they are not independently defective.
  Date/Author: 2026-07-23 / Codex and Matthew.

- Decision: Pierre scroll changes follow a packaged CDP diagnostic. Do not add wheel/touch `preventDefault` handlers or outer-container nudges.
  Rationale: CodeView owns virtual scroll state; guessing the scroll owner caused prior regressions.
  Date/Author: 2026-07-23 / Codex and Matthew.

- Decision: Replace fixed diff-theme families with one global, versioned, independently selectable pair: one light-scheme theme and one dark-scheme theme. New or malformed preferences default to `pierre-light` and `pierre-dark`; global Patchdesk appearance remains a separate `system | light | dark` preference.
  Rationale: a maintainer should be able to keep, for example, a Pierre light theme and a different Shiki dark theme while the product appearance decides which one is rendered. An explicit existing v1 family choice is migrated faithfully rather than silently discarded.
  Date/Author: 2026-07-23 / Codex and Matthew.

- Decision: Depend directly on Pierre's public `@pierre/theming`, `@pierre/theme`, `@shikijs/themes`, and `shiki` packages at versions compatible with the installed `@pierre/diffs`; use its bundled `themes` catalog and lazy loaders rather than importing transitive package files or maintaining a hand-written list.
  Rationale: the selection is exhaustive for the installed Pierre-supported catalog, stays type-safe as its catalog changes, does not eagerly load every syntax theme, and avoids an unsupported dependency on pnpm's transitive layout.
  Date/Author: 2026-07-23 / Codex and Matthew.

- Decision: Remove the Review workbench Options menu rather than relocating its settings. Keep only direct, review-local toolbar controls: layout, Wrap, and Context. Appearance and both diff-theme selectors belong only in Settings; compact density remains the product default; accessible text remains an automatic fallback rather than a manual view toggle.
  Rationale: the menu hides low-value global configuration in the active review path and consumes scarce diff width. The surviving controls have immediate, reversible effects on the visible diff.
  Date/Author: 2026-07-23 / Codex and Matthew.

- Decision: Render pull-request descriptions as safe GitHub-flavored Markdown (GFM), not pre-wrapped plain text. Use `marked@18.0.7` only as a bounded GFM lexer and map its allowlisted tokens to React/shadcn elements; never use Marked's HTML compiler output. Raw HTML, images, embeds, and unsafe links are excluded. A maintainer may explicitly open a validated HTTPS link through the typed main/preload boundary.
  Rationale: descriptions commonly use headings, lists, task lists, tables, links, and code to explain review intent. Marked is the selected mature parser, while token-to-React rendering preserves Patchdesk's Base Nova composition and avoids an untrusted HTML injection/sanitizer boundary in Electron.
  Date/Author: 2026-07-23 / Codex and Matthew.

- Decision: Compose every new or changed product surface from the installed shadcn Base Nova registry before writing product markup. A focused renderer adapter is allowed only when it adds behavior the registry cannot provide, such as parsing untrusted Markdown; it must compose primitives rather than define a competing visual primitive.
  Rationale: Patchdesk already uses Base Nova. Reusing `Card`, `Collapsible`, `ScrollArea`, `Table`, `Alert`, `Empty`, `Button`, `ButtonGroup`, `Badge`, `Separator`, `Tabs`, and `ToggleGroup` preserves supported interaction, semantics, tokens, and accessibility instead of recreating them with styled `div`s.
  Date/Author: 2026-07-23 / Codex and Matthew.

## Outcomes & Retrospective

Complete. The recovery pass is accepted with an immutable-diff correction for legacy snapshots: Patchdesk now refuses inconsistent exact source context rather than crashing the Pierre renderer. Fresh sessions are created from immutable base/head content, never from a mutable PR-diff snapshot.

2026-07-24 final verification:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test -- --run` — 53 files, 253 tests passed.
- `pnpm build`
- `pnpm exec playwright test` — 31 tests passed, including forced-colors, reduced-motion, native all-files scrolling, 1,000-file / 10 MB responsiveness, pre-run navigation, and immutable browser-snapshot coverage.
- `pnpm package:mac`
- `pnpm test:package-smoke`
- Packaged CDP evidence: `/tmp/patchdesk-final-overview-1402.png`, `/tmp/patchdesk-final-diff-1402.png`, `/tmp/patchdesk-final-diff-1920.png`, and `/tmp/patchdesk-final-diff-1280.png`.

The QA package was launched as `release/mac-arm64/Patchdesk.app` with a temporary Chromium user-data directory and CDP port 9240. Patchdesk's own app paths intentionally remain profile-owned under the configured home directory, so the real saved customer-management PR #118 was available. Its legacy inconsistent snapshot displayed the explicit unavailable-context control instead of throwing. The packaged app opened the read-only Overview and Diff only; `Run review` remained available but was not invoked, and no GitHub write confirmation was opened. At 1920×1080 and 1280×800, `document.documentElement.scrollWidth - clientWidth` was `0`; after clearing the diagnostic buffer, the normal History → #118 → Overview → View diff route produced no page or console errors.

## Context and Orientation

Patchdesk is an Electron application. `src/main/` owns privileged operations and starts a loopback local API. `src/renderer/src/` is the unprivileged React application. `src/preload/` exposes only the approved bridge. Keep `nodeIntegration: false` and `contextIsolation: true`.

The review lifecycle is intentionally split:

1. `ReviewWorkbenchController.open` fetches a PR, prepares or resumes a session, and saves its read-only patch/check context. It does not start a model.
2. A user opens the Base Nova Run review dialog and confirms `Start review`.
3. The main process validates the selected model and current PR head, allocates one durable attempt, then starts the workflow.
4. `ReviewRunCoordinator` exposes only bounded state to `SafeRunPanel` while the run is alive.
5. The completed structured result can create a local draft; a separate existing confirmation is still required for every GitHub write.

Relevant current modules:

- `src/services/review-workbench-controller.ts`: prepares or projects a session and its read-only diff/checks.
- `src/domain/github-context.ts` and `src/adapters/github/github-adapter.ts`: validated GitHub pull-request summary. They currently omit the REST `body` field, so the description cannot reach the workbench.
- `src/services/review-execution-service.ts`: validates model/reasoning, head freshness, allocates attempts, and currently contains the `001` source bug.
- `src/adapters/storage/review-session-store.ts`: atomic JSON storage and recovery compensation.
- `src/services/review-workflow-starter.ts`, `src/services/review-run-coordinator.ts`, and `src/services/run-projection.ts`: workflow invocation, safe live state, and renderer-safe run projection.
- `src/adapters/pi/pi-runtime-model-catalog.ts`: reads the local Pi runtime settings in the main process.
- `src/domain/review-result.ts` and `src/services/model-review-runner.ts`: validated model-output shape and prompt/rubric use.
- `src/services/review-rubric.ts` (new): the sole trusted source of the adapted pi-review instructions. It must build the trusted instruction layer separately from prepared PR data.
- `src/renderer/src/components/review-workbench.tsx`, `safe-run-panel.tsx`, and `maintainer-inbox.tsx`: maintainer-facing screens.
- `src/renderer/src/components/review-diff-view.tsx`: Pierre CodeView/PatchDiff integration.
- `src/renderer/src/appearance-preferences.ts`: global product `system | light | dark` preference and resolved-appearance event. It must follow an OS mode change while System is selected.
- `src/renderer/src/diff-theme-preferences.ts`: currently fixed v1 theme-family local storage. It will become the strict v2 independent light/dark pair preference.
- `src/renderer/src/pierre-theme-catalog.ts` (new): the public `@pierre/theming/themes` catalog adapter, first-party/non-Pierre loader registration, selector groups, and ID validation. It is renderer-local and contains no theme content or external fetch.
- `src/renderer/src/app.tsx`: Settings theme controls and app-level preference ownership.
- `src/renderer/src/review-diff-data.ts`: patch parsing and file-level visual metadata. It will retain the raw-patch projection and accept a validated hydrated projection for one changed file.
- `src/services/review-worktree-service.ts` and the local review API: the main-process-only path that can read exact base/head blobs for an already prepared session. The renderer must request a changed file by validated session/path; it must never receive a repository path or run git.
- `src/renderer/src/inbox-refresh-scheduler.ts` and `src/services/inbox-refresh-coordinator.ts`: automatic read-only Inbox refresh behavior.
- `src/adapters/github/workspace-origin-finder.ts`: Settings-only local repository discovery.

At desktop widths of 1280px or more, keep the product geometry unchanged: 48px title bar, 232px application rail (48px collapsed), 208px queue rail, and 336px inspector. Use the current shadcn Base Nova primitives and their generated defaults. Keep Inter/system UI at 16px base and 14px small UI text. Keep Pierre code text, colors, and line metrics scoped to the diff surface at 13px/20px with `JetBrains Mono, Fira Code, monospace`.

## Plan of Work

First make persistence and execution truthful. A prepared snapshot must not masquerade as attempt `001`, a stale model choice must never allocate a run, and two Start review clicks must resolve to one attempt. Then adapt the agreed `pi-review` rubric into an explicit, tested Patchdesk instruction layer and complete the safe result contract and presentation so the product has enough structure to show meaningful review conclusions without exposing raw provider output. After that, replace the fixed diff-theme families with the complete installed Pierre catalog, preserve app appearance separately from the selected light/dark pair, finish freshness behavior, and use packaged Electron diagnostics to remove the Pierre scroll workaround safely.

Do not change GitHub write APIs, review draft contracts, renderer privilege, or fixed desktop geometry. Do not add a generic light/dark component override layer; use existing Base Nova tokens and product semantic labels. Before any UI implementation, inspect `pnpm dlx shadcn@latest info --json`, search the explicit `@shadcn` Base registry, read the relevant component docs, and reuse the installed primitive; if it is absent, inspect `--dry-run`/`--diff` before adding it through the shadcn CLI. Use `className` for layout constraints only, built-in variants for visual state, semantic tokens for product state, `gap-*` for spacing, and `cn()` for conditional layout. Do not introduce a custom visual primitive where shadcn supplies one. Do not broaden external navigation except for an explicit, user-activated validated HTTPS link from a check source URL or PR-description GFM link; both use the same typed main/preload opener, never renderer navigation. “All themes” means every light or dark descriptor bundled by the explicitly installed Pierre theming catalog at build time, not arbitrary user-entered theme JSON, URLs, or unreviewed runtime files.

## Milestones

### Milestone 0 — Establish regression seams and the real Pierre scroll owner

Goal: prove the current behavior before replacing fragile scrolling code.

Work:

- Add a shadcn composition guard before visual work: record the Base Nova component inventory, search the Base registry for a missing semantic primitive, read its current docs before use, and use `pnpm dlx shadcn@latest add <name> --dry-run` plus `--diff` before any add. The current inventory already contains `Card`, `ScrollArea`, `Table`, `Alert`, `Empty`, `Button`, `ButtonGroup`, `Badge`, `Separator`, `Tabs`, and `ToggleGroup`; `@shadcn/collapsible` is available but absent, so add it with `pnpm dlx shadcn@latest add collapsible` only after its dry-run is reviewed. Do not overwrite a generated primitive without explicit approval.
- Add unit seams for attempt allocation, model catalog parsing, result parsing, check grouping, freshness labels, and workspace discovery limits before behavior changes.
- Add a QA-only diagnostic hook in `review-diff-view.tsx`. It must activate only in development or when an explicit packaged QA flag is supplied by the main/preload boundary. It may expose structural diagnostics through CDP only: event type, target/tag, composed-path element roles/classes, DOM scrollable ancestors, CodeView logical offset/height, viewport dimensions, and outer workbench offset. It must never include diff text, local absolute paths, tokens, prompts, model output, or credentials.
- Launch the packaged app with the saved customer-management PR #118. Record wheel, trackpad, Page Down, Home, End, finding selection, and append behavior in the plan's Artifacts section.

Commands, from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx tests/renderer/inbox-refresh-scheduler.test.ts
    pnpm exec playwright test tests/browser/milestone-9.spec.ts

Expected result: existing behavior is covered, and the package diagnostic identifies one CodeView scroll owner plus any competing outer scroll containers.

Why it reduces risk: the next milestone can remove a workaround based on measured ownership rather than making input handling broader.

### Milestone 1 — Truthful session-owned preparation and recoverable attempt allocation

Goal: pressing Start review creates exactly one durable attempt with assets derived from that attempt ID, while retries and crashes remain understandable and safe.

Work:

- Introduce `PreparedReviewArtifacts` for immutable session snapshot inputs, stored beside the session rather than in an attempt `001` directory. It contains only the validated context and review-input paths needed to create an attempt.
- Update session preparation in `ReviewSessionService` and `PatchdeskPaths` to create these session-owned files. Add a read-only compatibility loader for existing sessions whose prepared files still live under `001`; migrate/copy only when opening or starting that existing local session succeeds. Do not retain a second normal write path after compatibility is proven.
- Replace `prepareAllocatedAttemptArtifacts(... sourceAttemptId)` with `prepareAttemptArtifacts(prepared, attemptId)`. Every target context, review input, and debug path must use the actual allocated ID.
- Replace the current caller-computed `beginAttempt` with a store/service-owned operation such as `beginAttempt(input: BeginAttemptInput)`. It must serialize by `(profileId, sessionId)`, reload current session and attempts inside the boundary, reject a Running/Merged/non-runnable session, allocate the next ID, and persist the session's `Running` transition plus `Starting` attempt as one recoverable operation.
- Because filesystem JSON cannot form a database transaction, use a narrow in-process keyed mutex plus current atomic file writes. If the attempt write fails after the session write, save `Stale/orphaned_run`; if that compensation also fails, return `storage` and retain a diagnostic-free recoverable state for startup reconciliation.
- Keep `Starting` until an actual workflow/provider run ID exists. Never persist a fake Flue identifier. Startup recovery turns `Starting` or `Running` attempts without an owned live coordinator into `Stale/orphaned_run` plus a terminal interrupted attempt; it never invokes a model.
- Keep head verification immediately before allocation. Return distinct typed outcomes for profile missing, storage, GitHub read unavailable, and head changed. A changed head disables Run review and offers Refresh and reopen review.

Tests:

- Start two requests concurrently for the same session and prove only one attempt is created.
- Retry after an existing attempt and prove artifacts use `002`, never `001` as their target or source dependency.
- Simulate every write failure in the begin operation and verify the persisted session is either unchanged or visibly stale, never falsely runnable.
- Simulate restart recovery and prove no workflow invocation occurs.
- Verify head changed and GitHub-read errors occur before any attempt write.

Expected result: attempt records and their paths are honest, unique, durable, and safe to recover.

### Milestone 1.5 — Show the PR briefing before the diff

Goal: opening a pull request presents its title, identity, and a safe rich Markdown description in an Overview first. The maintainer chooses when to enter the local diff; description content never gains execution, remote-fetch, or renderer-navigation capability.

Work:

- Extend `PullRequestSummary` with `description?: PullRequestDescription`. Parse GitHub REST's nullable `body` field into that bounded projection in `github-adapter.ts`: normalize line endings, preserve source Markdown, reject a non-string response, and cap stored/rendered Markdown at 32 KiB with an explicit `Description truncated` marker. The maintainer Inbox list query need not fetch descriptions; `getPullRequest` is the one already-issued detail read for opening a review.
- Extend the session's immutable `prContext` and its storage schema with the bounded description captured at preparation. Read/projection code prefers the fresh validated GitHub description when available and falls back to the saved session description when GitHub is unavailable. Existing sessions lacking it render `Description was not saved for this review`, never fetch a moving PR solely to fill the UI or invent an empty description.
- Keep the description as untrusted prepared data for the model rubric. It remains after the trusted instruction block and cannot override review criteria, trigger commands or model tools, or affect draft/GitHub-write behavior.
- Make `overview` the initial workbench section for every single-click, Enter, direct PR entry, prepared session, active review, and completed review. `View diff` is the only action that selects the diff section; `Inspect failing checks` selects Checks. Preserve an already chosen section only when restoring the same active workbench route, not when opening a new PR.
- Add `marked@18.0.7` as the sole direct production Markdown dependency only after recording its current upstream provenance, MIT license, release age, and package metadata in the implementation notes. Use the cached upstream checkout at `/Users/kwanpham/.cache/checkouts/github.com/markedjs/marked` to verify `Marked.lexer()` and exported `Token`/`TokensList` types. Create one module-scoped `new Marked({ gfm: true, breaks: false })` instance; do not mutate global `marked` settings, call `marked.use()`, install Marked extensions, use a custom HTML renderer, or call `parse()`/`parseInline()` for this surface.
- Create a focused renderer-only `PullRequestDescriptionPreview` adapter, not a new visual primitive. It passes the bounded Markdown source to the isolated Marked lexer, then exhaustively maps only safe token types to React/shadcn elements: headings, paragraphs, emphasis, strong, delete, line breaks, escaped/plain text, ordered/unordered lists with disabled task checkboxes, block quotes, tables, inline code, and fenced code. `html`, `tag`, `image`, definitions, unknown extension tokens, and parser-error output are omitted or rendered as escaped plain text—never compiled to HTML. The adapter never uses `dangerouslySetInnerHTML`, `DOMPurify`, raw HTML components, a custom Marked HTML renderer, remote image loading, or arbitrary Marked extensions. The Overview host owns the installed shadcn shell: `Card` composition, `Collapsible`, `ScrollArea`, `Empty`, `Alert`, and `Button` behavior. The adapter renders Markdown tables with the installed `Table` composition and a local overflow-only wrapper; it renders fenced code as semantic `pre > code` in a `ScrollArea`, with no custom card or color treatment. Use only semantic Base tokens and layout classes; no custom component colors, radii, typography, shadows, or `dark:` overrides.
- Add a compact `Pull request` briefing at the top of Overview using full installed `Card` composition: PR identity goes in `CardHeader`/`CardTitle`, metadata and the description in `CardContent`, and `View diff`, `Inspect failing checks`, and `Run review` in `CardFooter` through `ButtonGroup`/`Button` variants. The Description `Collapsible` is open by default and contains `PullRequestDescriptionPreview` in the bounded `ScrollArea`. Long descriptions start at twelve visual lines with its local `Show more` / `Show less` control; rendered content remains selectable and keyboard reachable. Empty bodies use `Empty` with `No description provided`.
- Link policy is explicit and shared with check-source links: resolve relative URLs against the immutable PR page URL, allow only parsed `https:` destinations, and call a typed main/preload `openExternalHttps(url)` after exact validation. Render invalid, `http:`, `javascript:`, `data:`, `file:`, `mailto:`, malformed, or unresolved URLs as inert text. Do not use `target`, browser-native navigation, webviews, image tags, iframes, videos, forms, or any network-fetching Markdown node. Images and raw HTML are omitted rather than fetched or rendered.
- Place the three read-only/review actions below the description in clear hierarchy: `View diff`, `Inspect failing checks`, and `Run review`. The overview must not eagerly mount Pierre's CodeView, fetch unchanged-context blobs, shift rails, or run a model. This preserves a fast briefing and makes entering the diff an intentional step.
- Keep the same Description section in the completed and active-review Overview states. If the user reaches a diff/check deep link, Overview remains available as the first section in the navigation rail; no description is duplicated above the diff toolbar.

Tests:

- Adapter/domain tests for nullable, malformed, newline-normalized, boundary-sized, and over-limit GitHub bodies; storage migration/read tests for existing sessions without descriptions and a saved-description fallback during GitHub read failure.
- Renderer tests for default Overview routing after click/Enter/direct entry; Marked GFM token coverage for headings, lists, task lists, tables, block quotes, inline/fenced code, valid HTTPS and relative GitHub links; empty/truncated/show-more states; and keyboard operation. Assert the description uses the installed `Card`, `Collapsible`, `ScrollArea`, `Table`, `Alert`, `Empty`, `ButtonGroup`, and `Button` seams rather than custom equivalents. Use malicious fixtures with raw `<script>`, `<img>`, `<iframe>`, event attributes, `javascript:`/`data:` URLs, nested links, and malformed Markdown to prove no HTML node, remote image, external navigation, or console error occurs. Unit-test the isolated Marked lexer has `gfm: true`, no global extensions, bounded input, and a finite result for the largest accepted fixture. Stub the typed opener to prove a valid explicit HTTPS click is the sole navigation path. Assert Overview does not mount CodeView or invoke a model.
- Browser/package test with customer-management PR #118: open from Inbox, capture Overview with the rich description visible before the diff, verify no Pierre scroll target exists until `View diff`, then exercise View diff, Checks, and Overview return without page overflow or console errors. Add a local controlled description fixture to prove a wide GFM table and fenced code scroll only inside their own containers.

Expected result: a maintainer receives the PR's own explanation before inspecting changes, while the diff remains an explicit, fast, read-only next step.

### Milestone 2 — Current Pi runtime choices and profile preferences

Goal: the dialog only offers models enabled by the active local Pi runtime, and a stale selection cannot start a review.

Work:

- Replace the catalog's static fallback behavior with a strict main-process `PiRuntimeModelCatalog.get()` projection. Parse only the allowlisted Pi fields needed for the product: enabled model IDs, default model, and validated default thinking data. Do not return providers, settings JSON, capability values, or credentials.
- Treat an unavailable, invalid, or empty enabled-model catalog as `catalog_unavailable`; return a 503 for model listing and Start review. Do not silently advertise `opencode-go/deepseek-v4-flash` unless it is explicitly enabled by the active runtime.
- Place the catalog's default model first only when it is enabled. Preserve `medium` as the Patchdesk default reasoning level when the profile has no valid saved choice.
- Load the catalog both when opening the Run review dialog and immediately before allocation. If a remembered selection disappeared, render a clear “Choose an available model” state; do not create an attempt.
- Move `ReviewExecutionPreference` into a focused renderer module with strict parsing and profile-scoped keys. Store only `{ model, reasoning }`; validate the reasoning as `low | medium | high`.
- Keep actual model/reasoning, agent identity, review mode, and read-only access on the immutable attempt. Historical unsupported values render as `Unknown model` or `Unknown reasoning level`, never as a substituted current default.
- Ensure workflow input forwards only the stored per-attempt `model` and `reasoning` overrides to Flue. Do not log the request body, settings, prompt, stdout, provider events, or credentials.

Tests:

- Catalog with a disabled default, empty enabled list, invalid settings, and a catalog that changes between dialog load and Start review.
- Per-profile restore, invalid persisted preference fallback, and historical unknown display.
- Local API rejects an unavailable model before `beginAttempt`.

Expected result: model selection is current, deliberate, profile-local, and cannot produce an orphan attempt.

### Milestone 3 — Bounded activity and visible review progress

Goal: a maintainer can see a run start, progress, finish, or interruption without seeing provider internals.

Work:

- Extend `ReviewActivityEvent` with optional validated repo-relative `path` and `findingId`; reject absolute paths, unknown event kinds, bad timestamps, overlong labels, more than 40 events, and payloads exceeding 6 KB.
- Emit only owned milestones: Preparing snapshot, Inspecting files, Validating findings, Drafting result, Review complete, and Review failed. Emit them from Patchdesk coordinator/workflow boundaries, never by forwarding raw provider data.
- Persist immutable run metadata on the attempt and derive the display projection from that attempt. Activity may remain process-local while the coordinator owns the run, but its terminal transition and interruption state must remain explainable from storage after restart.
- Tighten `SafeRunPanel` client validation to the same enum, length, timestamp, and optional-reference rules as the local API. Continue to drop unknown fields.
- Keep the existing Inbox row, inspector, app-rail count, workbench heading, spinner, and polite live region. Ensure an active attempt turns the primary action into `View review progress` and never exposes a duplicate Start review button.

Tests:

- Boundary rejection for raw provider fields, prompts, tool output, credentials, hidden reasoning, absolute paths, invalid finding IDs, 41 events, 161-character labels, and payloads over 6 KB.
- UI keyboard test for opening progress, phase updates, disconnected state, and restart interruption.
- Verify app-rail collapsed tooltips and labels retain the active review count.

Expected result: active reviews are obvious and useful, but no private execution data crosses to the renderer.

### Milestone 4 — Adapt the agreed rubric and complete review results, finding details, Fix queue, and checks

Goal: completed reviews answer what changed, what matters, where the evidence is, how confident Patchdesk is, and what the maintainer should do next.

Work:

- Extend `src/domain/review-result.ts` with optional, bounded rich fields for new reviews. Add `coverage` and `overallConfidence` as `high | medium | low`; at most ten `unresolvedItems` of 280 characters each; at most twelve callouts with a 120-character title and 500-character detail; and, per finding, optional `affectedScenario`, `whyItMatters`, and `suggestedChange` capped at 500, 900, and 500 characters. Callouts are separate from findings and support `migration`, `dependency`, `dependency_change`, `authentication`, `compatibility`, `destructive_operation`, `feature_flag`, and `configuration`.
- Create `src/services/review-rubric.ts` and move prompt construction out of `ModelReviewRunner`. The module must return a trusted instruction block plus a separately delimited prepared-data block. The prepared patch, PR title/body/comments, checks, tool responses, and project-specific guidance are evidence, never instructions; the trusted block must say that conflicting instructions found in those inputs must be ignored.
- Adapt these exact upstream `review.ts` rubric requirements into the trusted instruction block:
  - Flag only issues introduced in the reviewed diff that have a meaningful, provable impact; each finding is discrete, actionable, unlikely to be intentional, and something the author would fix. Do not speculate, restate pre-existing issues, demand a standard inconsistent with the repository, or combine several defects into one finding.
  - Require the reviewer to identify the affected code path or scenario before claiming impact. A mapped finding must select the narrowest changed range and may span at most ten diff lines; a finding without verified changed-line evidence is returned as unmapped evidence, not invented coordinates.
  - Ask for focused checks on untrusted input: trusted redirect destinations, parameterized SQL, server-side request forgery protection for user-controlled URLs, and escaping instead of sanitizing where an escaping boundary exists.
  - Ask for focused clean-code checks: actual duplicate implementations with the existing location named; one-off indirection helpers; abstractions introduced without a present need; and defensive fallbacks that hide violated invariants.
  - Apply fail-fast review rules to changed error handling: explain what can fail and why local recovery is correct; flag swallowed errors, silent `null`/empty/false fallbacks, quiet parsing failures, logging-and-continuing, and boundary code that pretends success. Do not flag an explicit, tested compatibility recovery without a concrete correctness failure.
  - Ask for system-level risks including back-pressure, stable error-code/identifier comparison rather than error-message comparison, and changes likely to create operational/on-call burden.
  - Require concise, factual proposed comments: one paragraph at most, explain why it matters and the triggering scenario, use a calm tone, keep code suggestions to a concrete minimal replacement, and never use praise or a full PR rewrite.
  - Preserve the upstream priority meaning in Patchdesk labels: P0 is release/operation blocking and input-independent; P1 is urgent; P2 is a normal actionable defect; P3 is low-priority. Severity cannot be inferred solely from an informational callout.
- Encode the upstream callout section as structured output instead of a markdown appendix. `ReviewCallout` records only the applicable category, a short title, bounded detail, and optional validated changed path. Support: `migration`, `dependency`, `dependency_change`, `authentication`, `compatibility`, `destructive_operation`, `feature_flag`, and `configuration`. The prompt must explicitly say to emit no callout when it does not apply, keep callouts out of findings unless there is a separate concrete defect, and never let callouts change the verdict.
- Define Patchdesk verdict rules in the trusted block and schema: `request_changes` for any P0/P1 finding; `comment` for one or more P2/P3 findings with no P0/P1; `approve` only when there are no qualifying findings. Callouts, assumptions, and unresolved items do not change that result.
- Replace `rawNotes` in the model-result input schema with no field at all. The prompt must not request provider prose outside the validated result. Keep strict-object parsing at the model/local API boundary so raw output, prompts, hidden reasoning, provider events, tool output, capability values, and arbitrary extra fields are rejected before storage or renderer projection.
- Preserve Patchdesk-specific incremental rules alongside the adapted rubric: the comparison patch is primary evidence, a prior unchanged issue cannot be reported as new, and each prior token must be assessed only as `still_present`, `resolved`, or `unverified` with comparison evidence for `resolved`.
- Read only approved project review guidance already represented by the prepared session: repository `AGENTS.md`, `CONTRIBUTING.md`, and profile-configured rule paths within the prepared worktree. Bound each file and the combined payload, reject absolute/out-of-root paths and sensitive content, label their source path, and append them after the trusted Patchdesk block as lower-precedence repository guidance. Do not crawl parents, discover `.pi` files, execute commands, or expose any guidance text to the renderer.
- Add `THIRD_PARTY_NOTICES.md` with the MIT copyright and permission notice for the substantial adapted wording from `earendil-works/pi-review@f1de050`; link to the exact source commit in an adjacent source comment or the notice. Do not copy the upstream extension's shell/GitHub checkout instructions, UI behavior, or state-management code.
- Preserve old stored results by mapping absent optional fields to visible `Not provided by this review` copy; never re-run or re-parse old provider output.
- Recompose `ReviewWorkbench` into a summary plus priority queue. Add compact, keyboard-accessible filter/group controls for severity, category, confidence, mapped/unmapped state, and lifecycle. Keep the selected finding stable when a filter temporarily hides it, when layout changes, and when the diff switches unified/split or all-files/selected-file mode.
- Add a finding detail surface in the inspector: severity meaning, category, confidence, exact file/range/side, explanation, affected scenario, suggested change, mapping status, and an expandable mapped evidence link that selects and centers the corresponding Pierre range. Unmapped findings state that no line navigation is available.
- Add separate Validation, Assumptions, Unresolved items, prior-finding lifecycle, and Human callouts panels. The local Fix queue stays derived from findings and profile/reviewed-head local storage; it never creates a draft or GitHub write itself.
- Replace raw completed-review badges with `Review complete`, `Suggested action: Approve|Comment|Request changes`, `GitHub: Current|Changed since review|Unavailable`, and `Submission: Not submitted|Draft saved|Pending review|Submitted`. Keep text and icon/shape distinctions in addition to semantic color.
- Extend `CheckRunSummary` and GitHub adapters with an optional, validated source URL only when GitHub supplies one. Rebuild checks into grouped/deduplicated rows with a state icon, explicit Name / Requirement / Result fields, `No requirement metadata` wording, and a read-only `Open in GitHub` action only when the validated URL exists.
- Recompose the Checks surface to match the compact reference: one Base Nova collapsible section headed `Checks` with a chevron and a single hairline separator beneath the header. Do not show a large header-level `passing` pill or a card around each check. The closed state still states the aggregate outcome and check count in accessible text; opening it reveals the rows without changing review navigation or scroll ownership.
- Render each grouped check as a compact, borderless two-column row: a fixed leading status icon plus check name at left, and a right-aligned explicit result (`Failed`, `Passed`, `Pending`, or `Unknown`) at right. Use the same baseline and quiet secondary result tone as the reference, while retaining text and an accessible label in addition to red/green color. Keep 12px vertical row gaps, no row-card padding/radius/shadow, and stable alignment across the inspector's full width. At narrow widths, preserve the icon/name row and place the result immediately beneath it; do not create a separate card.
- Keep requirement metadata out of the default row. Show `No requirement metadata` only in a compact, keyboard-reachable row detail when it is relevant, along with an optional safe GitHub link and duplicate/source information. A normal passing check should read simply as its name and `Passed`.
- Group exact duplicate checks by normalized name, requirement state, result, and source URL. Show one row with `×N` rather than repeating the same `check-test-coverage`, `lint`, or `init-sonarcloud-project` card. Sort failing/required checks first, then pending, then passing. Collapse the all-passing group behind a compact `N passing checks` disclosure when the list has more than five rows; its explicit text remains available to keyboard users and non-color readers.
- Render absent requirement metadata as the short secondary label `No requirement metadata`, never the visually noisy `Requirement unknown · success` sentence. Keep a result word such as `Passed`, `Failed`, `Pending`, or `Unknown` beside the status icon, so the row remains understandable in grayscale and forced-colors mode.

Tests:

- Add a `review-rubric.test.ts` contract suite that asserts every rule above is present in the trusted instruction block, while upstream `git diff`, `gh`, shell execution, provider configuration, and raw-output instructions are absent from that block. Include an adversarial prepared-patch/project-guidance fixture that says to ignore the rubric; prove it remains data after the trusted instruction block.
- Update `model-review-runner.test.ts` to assert the prompt contains the adapted rubric before delimited prepared data, retains only the four read-only inspector tools, carries incremental prior-finding rules, and cannot request or accept `rawNotes`.
- Result parser accepts complete new output and safely renders legacy output with missing fields. Include verdict consistency tests: P0/P1 requires `request_changes`, only P2/P3 requires `comment`, and no findings requires `approve`; callouts alone cannot alter the verdict.
- Callout categories, bounded text, mapping, scenario, impact, suggested-change, ten-line range, and structured repository-guidance validation reject invalid data.
- Filters, groups, selected finding persistence, evidence navigation, and local Fix queue updates.
- Check deduplication, no-requirement text, source-link visibility, and no external navigation without a source URL.
- Renderer and browser tests for the compact Checks section: header chevron opens/closes by click and keyboard; duplicate fixtures render once with `×N`; a normal-width row is icon/name left and result right with no card surface; more than five passing rows use the disclosure; failures stay visible; long names truncate safely; and requirements/results remain readable with color disabled.
- Grayscale and forced-colors renderer assertions prove severity/check text remains meaningful without color.

Expected result: Patchdesk applies the agreed high-signal review rubric to every model run, safely presents its structured outcome, and never turns upstream execution instructions or provider text into renderer capability.

### Milestone 5 — Finish freshness, full paired Pierre theme selection, appearance, and non-color status behavior

Goal: the Inbox truthfully communicates how current its GitHub data is, and the user can independently choose any installed Pierre-supported light and dark diff themes. Patchdesk appearance decides which saved side is active; it never overwrites either choice.

Work:

- Keep the existing renderer scheduler and main-process per-profile coordinator. Confirm one canonical full-Inbox read path; delete any remaining duplicate manual refresh route only after call-site and test removal.
- Render the snapshot time visibly beside the freshness label as `Updated just now`, `Updated 1m ago`, or `Updated 2h ago`, with an ISO `time` element/title for the exact value. Keep `Refreshing`, `Aged`, `Partial`, `Cached after refresh failure`, `Unavailable`, and `Paused` as explicit text.
- Preserve the last complete snapshot during a request. A partial response must not claim `Current`; a failed scan with last good data must say cached after refresh failure; no usable data must say unavailable. Do not let a stale response generation overwrite a newer manual/foreground response.
- Keep `Refresh all` disabled only while the shared request is active and keep a running review visible/unchanged during every refresh.
- Add direct production dependencies compatible with `@pierre/diffs@1.2.12`: `@pierre/theming@0.0.2`, `@pierre/theme@1.1.0`, `@shikijs/themes@4.3.1`, and `shiki@4.3.1`. Before changing `package.json`, record the local lockfile versions, `pnpm view` release metadata, licenses, active upstream repository, and the package's lazy-loader interface. Do not rely on the current transitive pnpm locations.
- Add `src/renderer/src/pierre-theme-catalog.ts`. Build its catalog from the public `themes` export in `@pierre/theming/themes`, which contains every bundled first-party Pierre and Shiki descriptor. Keep the catalog order and the descriptor's own `colorScheme`, display name, and lazy loader; do not infer light/dark from a string prefix, scrape `node_modules`, accept typed arbitrary theme IDs, or fetch themes at runtime.
- Register only the catalog's non-Pierre descriptors with Pierre's public `registerCustomTheme(name, loader)` once per renderer lifetime. The built-in Pierre descriptors are already resolved by `@pierre/diffs`; skipping them avoids duplicate-registration console errors. Register loaders, not resolved themes, so the application does not download or initialize every theme at startup.
- Replace `DiffThemeFamily` with a strict renderer-only `DiffThemePreference` version 2, containing `lightTheme` and `darkTheme`. Store it under `patchdesk.diff-theme.v2`. Its parser must accept only catalog IDs whose declared color scheme matches the field, default a missing/corrupt value to `{ lightTheme: "pierre-light", darkTheme: "pierre-dark" }`, and never expose raw local-storage data to a component.
- Migrate a valid explicit v1 family once: `github` becomes `{ github-light, github-dark }`; `high_contrast` becomes `{ github-light-high-contrast, github-dark-high-contrast }`. Do not write a v2 preference when v1 is absent, so a new user receives the required Pierre pair. Delete the v1 key only after a successful v2 write. Invalid or unknown v1 data takes the Pierre pair and removes no valid preference.
- Keep `patchdesk.appearance.v1` as the sole global `system | light | dark` preference. Extend `appearance-preferences.ts` with one guarded `matchMedia("(prefers-color-scheme: dark)")` subscription while System is selected, so an operating-system change updates both Base Nova's resolved class and the active Pierre side without changing stored theme names. Dispose the listener on app unmount and keep a light fallback where `matchMedia` is unavailable.
- Pass the complete pair to Pierre everywhere: `theme: { light: preference.lightTheme, dark: preference.darkTheme }`; pass the resolved `themeType: "light" | "dark"` from the same appearance event. Include both names and resolved appearance in CodeView/PatchDiff reset keys and invalidate only the current highlighter cache when a pair member or system resolution changes. Preserve selected range, virtual stream position when possible, collapsed files, hunk expansion state, `13px/20px` code metrics, and semantic changed-line emphasis.
- Remove the hard-coded light/dark syntax and generic surface color overrides that mask a selected Shiki/Pierre theme. Keep only layout geometry, the existing selected-finding treatment, additions/deletions semantic layers, and forced-colors overrides expressed through Pierre/Base tokens. A selected theme must visibly control code foreground/background and syntax colors; forced-colors may use OS colors but retains text/icon status meaning.
- Replace the Settings `Diff theme` family select with two Base Nova Select controls: `Light diff theme` lists only catalog light themes, and `Dark diff theme` lists only catalog dark themes. Each includes Pierre and Shiki groups using catalog labels. The card states `Current appearance: Light/Dark — using <theme>` and explains that the product Appearance control chooses which saved side is active. Defaults visibly read `pierre-light` and `pierre-dark`.
- Remove the ReviewDiffView Options button, its DropdownMenu content, and its menu-only theme, compact-density, unchanged-context, wrapping, and manual accessible-text controls. Do this only after moving the active review effects to their explicit destinations: the visible Wrap toggle controls wrapping; the visible Context toggle controls unchanged context; Settings owns appearance and both theme selectors; the compact-density default remains fixed; and accessible text activates only as the existing non-Pierre/browser fallback. Delete dead preference/callback/import paths instead of leaving hidden option behavior behind.
- If a catalog loader fails, retain the last successfully applied pair and show a compact, text-readable `Theme unavailable; using <last theme>` state. Never persist the failed selection, silently substitute an unrelated theme, or log a resolved theme object/content. A user can recover by reopening the two selectors or clearing the v2 key.
- Do not restore the removed global enabled-button cursor override. Use Base Nova defaults; add local pointer style only where a non-button Patchdesk-specific interactive element demonstrably needs it.

Tests:

- Fake-timer scheduler tests for entry, foreground, hidden, retry, manual, overlap, stale response generation, and an active review during refresh.
- Unit-test the direct dependency/catalog boundary: every `@pierre/theming/themes` descriptor appears once in the appropriate light/dark selector; Pierre defaults are present; non-Pierre loaders are registered exactly once; and no selector accepts an arbitrary or wrong-scheme ID. Mock loaders in unit tests so no complete Shiki catalog is eagerly resolved.
- Preference tests for missing/corrupt v2 defaults, valid independent selections, v1 `github` and `high_contrast` migration, no-v1 default behavior, write-failure preservation, and catalog upgrade removal of a previously selected ID.
- Renderer tests for Settings keyboard flow, immediate active-side updates, System media-query changes, live text, no appearance mutation from a theme selection, selected-line preservation, renderer-safe loader errors, and the absence of the Review workbench Options button/menu.
- Browser tests for visible relative freshness time, default `pierre-light`/`pierre-dark`, a non-Pierre light/dark pair, keyboard focus, zero page overflow, grayscale labels, and forced-colors labels. Use Playwright media emulation to prove System applies each configured side.

Expected result: `Current` has a visible time and a precise meaning. A user can set any bundled light theme and any bundled dark theme independently, defaults receive `pierre-light`/`pierre-dark`, and system/light/dark appearance reliably activates the matching saved side without compromising diff readability or color-independent status meaning.

### Milestone 6 — Pierre scroll repair, real expandable unchanged hunks, and Settings-only discovery hardening

Goal: virtualized all-files CodeView scrolls naturally in the packaged app, and local repository discovery remains clearly bounded and private.

Work:

- Use the Milestone 0 diagnostic against the packaged app to identify the actual CodeView scroll owner. Record the evidence before changing `review-diff-view.tsx`.
- Remove the raw wheel/touch/pointer/key capture continuation and append-time `scrollTo` nudge once CodeView's own `onScroll` is confirmed sufficient. Retain only a narrow CodeView-owner continuation that appends the next batch without altering the outer workbench scroll offset.
- Ensure all-files behavior appends progressively; selected-file mode does not append unrelated files; finding/file-tree selection expands a target file and centers its selection. Native wheel/trackpad, Page Up/Down, Home/End, keyboard focus, and accessible text diff anchors must work without `preventDefault` event interception.
- Keep Pierre's built-in `line-info` separator as the default hunk style. It shows an unchanged-line count plus expand-up/down controls, and Pierre shows an `Expand all` control for a large omitted region. Do not use Pierre's deprecated `custom` separator variant. `metadata` and `simple` may remain internal comparison styles, but they must not replace the default because they do not expose expand controls.
- Extend the PR/session snapshot and managed worktree reference with the exact base SHA needed for the prepared review diff. At preparation, fetch both immutable refs into Patchdesk-owned namespaced refs: `refs/patchdesk/reviews/<profile>/<session>/base` and `.../head`. The detached worktree remains checked out at head. Existing sessions without a stored base ref stay safely viewable as partial patches and display `More unchanged context is unavailable for this saved review`; they must not fetch a moving branch or silently substitute current repository state.
- Add a main-process `ReviewDiffHydrationService` and a strictly parsed read-only local API endpoint for one changed file. It accepts only `{ sessionId, path }`, reloads the session, verifies the session owns a worktree with exact base/head refs, validates a repository-relative path against the saved patch, and reads only the two immutable blobs from those refs. It must use argv-array git reads, never interpolate shell text, never read an arbitrary worktree path, and never persist file content.
- Hydrate using Pierre's public `processFile(rawFilePatch, { oldFile, newFile, throwOnError: true })`, not `parseDiffFromFile`. Before returning it, verify every raw-patch context/deletion/addition line against the corresponding full base/head line at the hunk's exact GitHub coordinate; a mismatch returns `patch_mismatch`. This preserves the stored GitHub patch's hunks, line coordinates, rename metadata, and finding mapping while supplying the full old/new line arrays Pierre needs to expand collapsed context. For renamed files, use `prevName` for the base blob and `name` for head; for added/deleted files, provide an empty opposite-side file; for binary, missing, too-large, malformed, or mismatched blobs, retain the partial patch and return a typed unavailable reason.
- Limit hydration to a maximum of 1 MiB per side and 2 MiB combined after decoding. Fetch it lazily for the selected file and each CodeView batch before it is appended, with at most two in-flight requests; cache validated hydrated metadata only in renderer memory for the lifetime of the open session. Show a compact non-error `Loading unchanged context…` state while it resolves. Do not preload every file, persist source text, log content, send it to GitHub, or use hydration for model execution.
- In `ReviewDiffView`, replace the affected `CodeView` item with its hydrated `FileDiffMetadata` without rebuilding the entire stream or moving the outer scroll position. Preserve file collapse state, selected finding range, current diff style, all-files/selected-file mode, wrapping, and loaded-file count. When a selected finding is in an omitted region, hydrate its file first, expand only the required Pierre hunk/range, then center the selected line.
- Replace the separate `Collapse` and `Expand` toolbar buttons with one compact Base Nova toggle beside `Wrap`, backed by one `showUnchangedContext` state. Its visible label is `Context`; its pressed treatment matches Wrap; `aria-pressed` exposes whether unchanged context is expanded; and its accessible name/tooltip changes between `Expand unchanged context` and `Collapse unchanged context`. A click expands or collapses all currently hydrated, loaded files without changing file mode, finding selection, outer scroll owner, or wrapping. It is disabled only when no rendered file has expandable unchanged context, with a precise `No additional unchanged context is available` explanation. Do not add two adjacent action buttons or a nested menu for this state.
- Keep the native Pierre separator controls and styling boundary. Apply only token-based CSS for Patchdesk light/dark themes, visible focus, non-color text such as `19 unchanged lines`, and an unavailable explanation. Do not simulate hunk expansion by inserting DOM rows or intercepting pointer/wheel/touch events.
- Keep both workbench toolbars sticky and all rails independently restorable. Do not create a second vertical page scroll owner.
- Document Workspace discovery in Settings: it searches only user-configured roots, limits depth to four directory levels, applies five-second command timeouts, performs main-process-only command execution, and sends discovered local paths only to the existing Settings suggestion flow—not to GitHub or other renderer routes.
- Add direct tests for root forwarding, depth/timeout command arguments, remote URL parsing, duplicate suppression, invalid origins, command failures, and the Settings-only local path boundary.

Tests:

- Unit-test the new hydration service with a raw patch plus exact old/new contents: changed, newly added, deleted, renamed, binary, missing-base, out-of-patch path, path traversal, content-size limit, and blob/patch mismatch. Assert that successful hydration uses `processFile`, yields `isPartial: false`, retains the original hunk line coordinates, and performs no writes.
- Renderer-test the `line-info` separator in unified and split modes: it renders `N unchanged lines`, expands upward/downward and Pierre's native `Expand all` when applicable, and retains selection/file state. Verify the single `Context` toolbar toggle mirrors the Wrap control's pressed style and keyboard activation, expands/collapses hydrated loaded files, and reports accurate disabled/help text. Verify partial legacy or unavailable files have no false expand control and explain why; verify a finding inside collapsed context hydrates, expands, and centers its exact line.
- Browser-test selected-file and all-files streams with a two-file fixture containing more than the collapsed-context threshold. Assert the first file hydrates before display, the next virtualized batch hydrates on append, only two requests may run at once, and file/tree/finding navigation does not reset the scroll owner or outer page offset.
- Browser fixture tests for wheel, trackpad-equivalent wheel, Page Up/Down, Home/End, selection navigation, file collapse, and appended all-files continuity.
- Packaged CDP test with customer-management PR #118 that records diagnostics before removal and proves the final normal path has no diagnostics-enabled behavior. Open a diff with an omitted unchanged region, capture its `data-unmodified-lines`/expand controls, expand it in unified and split modes, confirm the added context is visible, and confirm no page-level overflow, console/page error, or GitHub write confirmation.
- Unit tests for workspace-origin finder traversal and Dashboard/Settings serialization.

Expected result: code review scrolling feels native and reliable, and every current review with exact base/head blobs can reveal omitted context through Pierre's own hunk controls without sacrificing immutable diff coordinates; repository discovery stays transparent, bounded, and local.

### Milestone 7 — Full acceptance and plan reconciliation

Goal: prove the whole maintainer workflow in the packaged Electron app and leave a trustworthy record.

Work:

- Run the focused tests after each milestone, then the complete repository gate only after all source changes are complete.
- Package the app and use `agent-browser` over CDP with a temporary QA profile containing the saved customer-management PR #118. Do not invoke a GitHub-write confirmation.
- In the packaged app, capture the default pair first, choose one non-Pierre light theme and one non-Pierre dark theme, switch Appearance through Light, Dark, and System, then reopen the app to prove both independent selections persisted. Use Playwright to enumerate every catalog option and force each side independently; the packaged run proves the real Electron integration, not every visual permutation.
- Update this plan's Progress, Surprises & Discoveries, Decision Log, Outcomes & Retrospective, and artifact paths with actual results. Update the superseded UX plan's status and implementation-progress section so it no longer claims completed work is missing.

Commands, from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm lint
    pnpm typecheck
    pnpm test -- --run
    pnpm build
    pnpm exec playwright test
    pnpm package:mac
    pnpm test:package-smoke

Expected result: every command exits zero. Any unrelated pre-existing failure is recorded verbatim with a focused proof for the changed behavior.

## Concrete Steps

1. Read `AGENTS.md`, this ExecPlan, `PLAN.md`, and `git status -sb`. Preserve unrelated `.migration/`, `skills-lock.json`, and other user changes.
2. Add tests for each current gap before changing its source module. For every UI surface, first follow the shadcn composition guard in Milestone 0; use existing Vitest unit/service patterns and `tests/browser/milestone-9.spec.ts` for Pierre behavior.
3. Before Milestone 1.5, verify the selected Markdown dependency's parser-only integration rather than a moving branch tip or generated HTML path:

       bash /Users/kwanpham/.agents/skills/librarian/checkout.sh https://github.com/markedjs/marked --path-only
       pnpm view marked version time license repository --json
       git -C ~/.cache/checkouts/github.com/markedjs/marked rev-parse HEAD
       sed -n '1,240p' ~/.cache/checkouts/github.com/markedjs/marked/src/Tokens.ts
       sed -n '250,340p' ~/.cache/checkouts/github.com/markedjs/marked/src/Instance.ts

   Expected result: `marked@18.0.7` is the current MIT direct dependency; `Marked.lexer()` exposes typed tokens; the implementation can ignore HTML/image/unknown tokens and never call the HTML parser. Record the checkout commit, version, license, and test evidence in `THIRD_PARTY_NOTICES.md` and the implementation notes.
4. Before Milestone 4, verify the upstream source is the pinned revision, not a moving branch tip:

       bash /Users/kwanpham/.agents/skills/librarian/checkout.sh https://github.com/earendil-works/pi-review --path-only
       git -C ~/.cache/checkouts/github.com/earendil-works/pi-review rev-parse --verify f1de050
       sed -n '120,310p' ~/.cache/checkouts/github.com/earendil-works/pi-review/review.ts

   Expected result: the cached source resolves `f1de050`, and the reviewed text is the rubric/callout section described in Milestone 4.
5. Before Milestone 5, re-check the supported Pierre theme interface and the direct dependency health; do not import a dependency through `node_modules/.pnpm`:

       bash /Users/kwanpham/.agents/skills/librarian/checkout.sh https://github.com/pierrecomputer/pierre --path-only
       pnpm view @pierre/theming version time license repository --json
       pnpm why @pierre/diffs @pierre/theming @pierre/theme @shikijs/themes shiki
       sed -n '1,220p' ~/.cache/checkouts/github.com/pierrecomputer/pierre/apps/diffshub/lib/theme/diffThemeProps.ts
       sed -n '1,220p' ~/.cache/checkouts/github.com/pierrecomputer/pierre/packages/theming/src/themes.ts

   Expected result: the public `themes` catalog, its lazy descriptors, and the pair-shaped Pierre options are available at direct compatible versions. Record source commit/version, license, and exact catalog counts before adding the direct dependencies.
6. Implement Milestones 1 through 6 in order. Do not begin the next milestone until its focused test command passes.
7. Before each commit, run `git diff --check`, stage explicit source/test/doc paths only, and use the repository's conventional commit style. Do not commit generated package output or unrelated working-tree files.
8. For packaged QA, load the agent-browser core and Electron skills, then run:

       open -n release/mac-arm64/Patchdesk.app --args --remote-debugging-port=9233
       agent-browser --session patchdesk-qa --cdp 9233 snapshot -i
       agent-browser --session patchdesk-qa --cdp 9233 errors
       agent-browser --session patchdesk-qa --cdp 9233 console
       agent-browser --session patchdesk-qa --cdp 9233 eval 'document.documentElement.scrollWidth - document.documentElement.clientWidth'
       agent-browser --session patchdesk-qa --cdp 9233 screenshot /tmp/patchdesk-ux-recovery.png

   Use a different port only if 9233 is occupied. Take a new snapshot after every click because accessibility references become stale.

## Validation and Acceptance

Acceptance is behavior, not just passing tests:

- Opening PR #118 creates or resumes a prepared session and shows Overview first: PR title, identity, bounded safe GFM Description preview, View diff, Inspect failing checks, current/reviewed SHA, and a refresh time. It does not mount Pierre or invoke a model until the maintainer explicitly selects View diff or starts a review.
- View diff exposes the stored local patch before review execution. Inspect failing checks opens the same session's Checks view without creating a draft or GitHub write.
- Run review opens a Base Nova dialog. Starting twice results in one durable attempt. A changed head, unavailable GitHub read, empty runtime model catalog, or vanished selected model creates no attempt and tells the user how to recover.
- Every new review uses the adapted `pi-review@f1de050` criteria: only introduced, discrete, evidence-backed issues become findings; priority has the stated P0–P3 meaning; changed error handling, untrusted input, duplication/indirection, operational risk, and back-pressure receive focused inspection; and no prompt/data instruction can override those rules.
- A live review shows Review starting or Review in progress in the row, inspector, application rail count, workbench, and safe activity panel. Restart interruption is visible and never auto-restarts the model.
- Completed review surfaces use the approved labels, show rich findings and evidence safely, preserve old reviews with explicit missing-data text, and keep Fix queue changes local. Human callouts are visibly separate from findings and do not alter the suggested action.
- Checks show grouped name/requirement/result states with text and icon; GitHub links appear only when supplied and safe.
- Inbox visibly moves `Current → Refreshing → Current`, pauses off-route/hidden, uses backoff after failure, retains its last good data, and leaves an in-progress review unchanged.
- Patchdesk defaults to the independent pair `pierre-light` and `pierre-dark`. Settings can choose every bundled catalog light or dark theme for its matching side, including Pierre, GitHub high contrast, and the other bundled Shiki themes. System, light, and dark appearance activate the matching saved side without altering the other one. Grayscale and forced-colors preserve readable labels and focus indication.
- Pierre wheel/trackpad, Page Up/Down, Home/End, finding selection, file-tree navigation, unified/split, all-files/selected-file, file collapse, and accessible text diff work in the packaged app at 1920×1080 and 1280×800.
- A raw GitHub patch begins with concise unchanged-context separators. Clicking a separator reveals exact immutable base/head context through Pierre; `Expand all` works for a large region. New, deleted, renamed, binary, legacy, or unavailable files retain accurate partial-diff behavior and never pretend omitted source is available.
- No console/page errors occur; no page-level horizontal overflow occurs; all app/sidebar/queue/details rails collapse and restore; command palette remains operable.

## Idempotence and Recovery

Refreshing Inbox is safe to repeat and never writes review sessions, attempts, worktrees, Flue state, or GitHub. The main-process per-profile refresh coordinator shares concurrent reads; renderer generation tokens ignore stale responses.

Opening a PR is safe to repeat. It may prepare or reuse immutable read-only session artifacts but never starts a model. Starting a review is idempotent per session/attempt ownership; duplicate requests return the owned progress view instead of another attempt. If persistence fails partway through allocation, compensate to a stale session. On app restart, stale/interrupted attempts remain inspectable but require a fresh session to run again.

All theme, filter, rail, and Fix queue controls are local preferences. A malformed, removed, or failed theme ID never crashes the diff: retain the last successfully applied pair for the current session, then fall back to `pierre-light`/`pierre-dark` on the next clean load. Clearing `patchdesk.diff-theme.v2` is the safe recovery for a theme preference; never delete review storage, local worktrees, package artifacts, or user changes as a recovery shortcut.

## Artifacts and Notes

Record these during execution:

- Packaged CDP diagnostic before/after scroll trace: `/tmp/patchdesk-pierre-scroll-before.json` and `/tmp/patchdesk-pierre-scroll-after.json`.
- Hunk-expansion proof: `/tmp/patchdesk-hunk-collapsed.png` and `/tmp/patchdesk-hunk-expanded.png`, plus the base/head SHA, selected file, separator line count, and CDP assertion output showing no horizontal overflow.
- Packaged screenshots: `/tmp/patchdesk-ux-recovery-1920.png`, `/tmp/patchdesk-ux-recovery-1280.png`, `/tmp/patchdesk-ux-recovery-light.png`, `/tmp/patchdesk-ux-recovery-dark.png`, `/tmp/patchdesk-ux-recovery-forced-colors.png`.
- Exact package/app version, CDP port, profile fixture source, and console/page error output.
- Theme-catalog proof: upstream Pierre commit, direct package versions/licenses, catalog count by color scheme, default pair, chosen non-Pierre pair, loader-registration output, and screenshots for default/light/dark/System/forced-colors surfaces.
- Rubric provenance: cached checkout path, verified upstream commit `f1de050`, the exact local `THIRD_PARTY_NOTICES.md` notice, and the focused rubric/model-runner test command/output.

## Interfaces and Dependencies

Add or revise these contracts. All are main-process or renderer-local unless explicitly named otherwise.

```ts
type PreparedReviewArtifacts = {
  readonly contextPath: AbsolutePath
  readonly reviewInputPath: AbsolutePath
}

type BeginAttemptInput = {
  readonly profileId: WorkspaceProfileId
  readonly sessionId: ReviewSessionId
  readonly model: string
  readonly reasoning: "low" | "medium" | "high"
  readonly metadata: ReviewRunMetadata
}

type RuntimeModelCatalog = {
  readonly models: ReadonlyArray<{ readonly id: string; readonly label: string }>
  readonly defaultModel?: string
}

type ReviewActivityEvent = {
  readonly at: IsoTimestamp
  readonly elapsedMs: number
  readonly step: "preparing" | "inspecting" | "validating" | "drafting" | "complete" | "failed"
  readonly label: string
  readonly path?: RepoRelativePath
  readonly findingId?: FindingId
}

type ReviewCallout = {
  readonly category: "migration" | "dependency" | "dependency_change" | "authentication" | "compatibility" | "destructive_operation" | "feature_flag" | "configuration"
  readonly title: string
  readonly detail: string
  readonly path?: RepoRelativePath
}

type ReviewRubric = {
  readonly trustedInstructions: string
  readonly repositoryGuidance: ReadonlyArray<{ readonly path: RepoRelativePath; readonly text: string }>
}

type PullRequestDescription = {
  readonly markdown: string
  readonly truncated: boolean
}

type HydratedReviewDiffFile = {
  readonly path: RepoRelativePath
  readonly status: "ready" | "unavailable"
  readonly reason?: "legacy_session" | "binary" | "missing_blob" | "too_large" | "patch_mismatch"
  readonly fileDiff?: FileDiffMetadata
}

type ReviewDiffHydrationRequest = {
  readonly sessionId: ReviewSessionId
  readonly path: RepoRelativePath
}

type ReviewWorktreeRefs = {
  readonly baseSha: GitSha
  readonly headSha: GitSha
  readonly baseRef: string
  readonly headRef: string
}

type PierreThemeId = string & { readonly __brand: "PierreThemeId" }

type PierreThemeDescriptor = {
  readonly id: PierreThemeId
  readonly label: string
  readonly source: "pierre" | "shiki"
  readonly colorScheme: "light" | "dark"
}

type DiffThemePreference = {
  readonly version: 2
  readonly lightTheme: PierreThemeId
  readonly darkTheme: PierreThemeId
}

type DiffThemePair = {
  readonly light: PierreThemeId
  readonly dark: PierreThemeId
}
```

`ReviewResult` gains optional richer fields for compatibility. `ReviewFinding` gains optional scenario, impact, and suggested-change fields. `CheckRunSummary` gains an optional validated GitHub source URL. Local API schemas must reject unknown or malformed boundary input. Renderer schemas must accept only the safe projected subset and never access provider objects.

`PullRequestSummary.description` and `ReviewSession.prContext.description` use the bounded `PullRequestDescription` projection. It is GitHub REST source Markdown tokenized only by an isolated Marked GFM lexer and rendered through `PullRequestDescriptionPreview`'s explicit token allowlist; it is not raw HTML, a remote-content source, or renderer capability. User-activated valid HTTPS links alone cross the typed main/preload external-open boundary.

`PierreThemeCatalog` exposes `lightThemes`, `darkThemes`, `defaults`, `isKnownForScheme`, and a once-only `registerNonPierreLoaders()` operation. `ReviewDiffView` receives one validated `DiffThemePair`, not a family enum, and passes it unchanged as Pierre's `ThemesType`. The appearance preference supplies only the resolved `themeType`; it does not select or persist a diff theme.

Dependencies include installed `@pierre/diffs`, direct `@pierre/theming`, `@pierre/theme`, `@shikijs/themes`, and `shiki` versions compatible with it; direct `marked@18.0.7` for safe parser-only PR-description tokenization; shadcn Base Nova components, Base UI adapters, Electron, and local Pi/Flue runtime. Do not add a dependency unless it passes the recorded health check and is required for this demonstrated capability.
