---
created_at: 2026-07-23
repos:
  - patchdesk
status: superseded
---

# Patchdesk UX and accessibility pass

## Purpose

Improve Patchdesk's maintainer and review workbench surfaces so state is understandable without domain knowledge, color is never the only status signal, and interactive controls behave as users expect.

This is a living plan. Add newly observed issues under **Issue log** before implementation slices are finalized.

## Goals

- Make review, GitHub freshness, and recommended-action states explicit in text.
- Support color-blind and low-vision users with text, icons, contrast, and accessible names—not color alone.
- Make PR rows and their actions discoverable and predictable.
- Preserve the fixed desktop geometry and renderer security boundaries.
- Verify the real packaged Electron surface, not only unit tests.

## Oracle review gate — 2026-07-23

The plan has the right product direction but is not ready for implementation until these contracts are explicit:

- PR navigation should create or resume a review session, but must not start model execution until the user explicitly clicks `Run review`.
- `Current` must mean a complete, successful GitHub snapshot with a visible timestamp; partial, failed, cached, paused, and refreshing states need separate language.
- A diff preview must carry the exact fetched head SHA into review start and revalidate it before starting.
- Run metadata and activity must use a strictly parsed, bounded, redacted projection sourced from the owned attempt—not hard-coded UI values or raw provider output.
- Pierre scrolling needs a packaged event-target/scroll-owner diagnosis before any wheel interception is added.

## Decisions made — 2026-07-23

- Badges use clear labels: `Review complete`, `Suggested action: Comment`, `GitHub: Current`, and `Submission: Not submitted`.
- Status colors must have accessible contrast and support the text/icon meaning; color is never the only signal.
- `Inspect failing checks` opens the shared workbench with Checks selected, stays read-only, and may provide `Open in GitHub` links.
- Severity labels are `P0 Critical`, `P1 High`, `P2 Medium`, and `P3 Low`, with non-color visual hierarchy.
- Freshness uses explicit states and timestamps: `Current`, `Refreshing`, `Partial`, `Changed since review`, and `Unavailable`.

## Issue log

### 1. Ambiguous review badges

Current badges include `comment` and `fresh`, which are difficult to interpret.

Approved language:

- `Review complete`
- `Suggested action: Comment`
- `GitHub: Current`
- `Submission: Not submitted`

Add supporting copy explaining that the review is local until the user explicitly submits it. Replace technical `fresh` terminology with explicit freshness states and timestamps.

### 2. Status depends too heavily on color

Red, green, yellow, and gray indicators are not sufficient for color-blind users.

Requirements:

- Every status communicates meaning through text or an accessible name.
- Use icons and/or labeled statuses in addition to color.
- Check foreground/background contrast for dark mode and forced-colors mode.
- Do not rely on colored dots alone for queue state or checks.
- Keep semantic state distinguishable when viewed in grayscale.

### 3. Severity hierarchy is visually indistinguishable

The finding rail shows `P0`, `P1`, `P2`, and `P3` labels, but the chips and cards use nearly identical gray styling. Users cannot quickly distinguish critical findings from lower-priority findings, especially in a grayscale or color-blind view.

Requirements:

- Preserve the visible `P0`–`P3` text labels.
- Add a clear non-color hierarchy using icon, border treatment, weight, grouping, or explicit severity text.
- Give P0/P1 findings stronger visual prominence without relying on red alone.
- Keep the selected finding state distinct from the severity state.
- Use the visible labels `P0 Critical`, `P1 High`, `P2 Medium`, and `P3 Low`.
- Verify the hierarchy in grayscale, dark mode, and forced-colors mode.

### 4. Check status is not visually scannable

The checks panel renders the overall `passing` state and each `success` result with nearly identical gray styling. The status is buried in long card text, and repeated entries such as `Requirement unknown` make the list noisy rather than informative.

Requirements:

- Make overall and per-check states scannable with text plus a consistent icon or shape.
- Use color only as supporting information; success, failure, pending, and neutral states must remain clear without it.
- Separate check name, requirement state, and result into distinct visual fields.
- Explain or suppress `Requirement unknown` when no requirement metadata exists.
- Deduplicate or group repeated checks when they represent the same check name and result.
- Allow an optional `Open in GitHub` link without making external navigation required for inspection.

### 5. PR row interaction is unclear

Maintainer inbox rows currently select on single click. The row's recommended action is shown as text, while the actual action is exposed through the inspector, double-click, or keyboard Enter.

Observed problems:

- Users expect clicking a PR title or row to open something.
- `Run review` is not a separate visible button in the row.
- Rows with `Inspect failing checks` currently have no action because `inspect_checks` is a no-op.
- The inspector can be collapsed, hiding the only obvious action control.

Chosen interaction model:

- Single click on any PR opens the shared PR detail/workbench screen.
- Double-click is not required and should not have separate behavior.
- The detail/workbench screen owns the available actions: `View diff`, `Run review`, `Inspect failing checks`, `Continue review`, `Edit review draft`, and merge/readiness actions when applicable.
- The initial screen state is determined by the PR state and recommended action, but all relevant actions remain discoverable there.
- `Inspect failing checks` opens the same screen with the Checks section selected.
- The checks-focused state remains read-only and does not create an empty review draft.
- Keyboard Enter on a focused PR mirrors single-click navigation.

### 6. Review-first workbench and diff/checks views

Opening a pull request should create or resume its review session, but must not start model execution automatically. Do not create a separate no-session PR context just to inspect a diff or checks.

The shared workbench should expose read-only views inside the started review session:

- PR identity and repository metadata.
- Exact fetched head SHA and refresh timestamp.
- Overview, diff, and checks sections.
- Initial section selected from the recommended action.
- Clear review progress and current phase.
- Explicitly separate read-only inspection from GitHub writes.

`View diff` and `Inspect failing checks` must not post to GitHub or create an empty draft, but they may operate within the review session that was started for the PR. Starting or entering the workbench must not silently review a different revision: carry the verified head context forward and revalidate it before execution or submission. If the head changed, require refresh/reopen.

Recommended flow:

1. Single-click or press Enter on a PR.
2. Create/resume its review session and enter the shared workbench.
3. Do not execute the model yet.
4. Show the relevant initial section: overview, diff, or checks.
5. Let the user explicitly click `Run review` to execute the model.
6. Keep diff/check inspection read-only and separate from GitHub write actions.
7. Identify the repository, PR number, branch pair, exact head SHA, and review state.

Use `View diff` rather than ambiguous labels such as `Preview` or `Review changes`. Handle unavailable diffs with a clear reason and preserve the existing read-only/security boundary.

### 7. Review navigator layout regression

The migrated Base UI Tabs wrapper used Radix-style orientation selectors even though the component exposes `data-orientation`. This rendered the tab list and file list side-by-side and clipped the navigator.

Current fix in working tree:

- Use `data-[orientation=horizontal]` and matching group variants.
- Regression coverage in `tests/browser/milestone-9.spec.ts`.

### 8. Agent execution is not visible

The in-progress screen shows only `running`, the current phase, and elapsed time. It does not tell the user which review agent or model is doing the work, what review mode is active, or what capabilities the run has.

The safe projection is a contract, not just a UI payload. Parse it at the API boundary and keep it bounded:

- Allowlisted event kinds and message templates.
- Server-generated timestamps.
- Validated relative paths and finding IDs only.
- Maximum event count, message length, and total bytes.
- Immutable attempt-owned agent, model, mode, and access metadata.
- Explicit retention and terminal-state behavior.
- No prompts, credentials, raw provider events, stdout, or chain-of-thought.

The renderer and service must agree on the same phase vocabulary before the panel is expanded.

Required always-visible run details, sourced from the owned attempt at runtime:

- Agent identity, or `Unknown agent` when unavailable
- Model identity, or `Unknown model` when unavailable
- Mode, such as `Full review` or `Review updates`
- Access capabilities, such as `Read-only repository inspection`
- Current phase and elapsed time
- Safe progress message when available

Expose this as safe, structured metadata in the run projection. Do not expose prompts, credentials, raw provider events, or unrestricted tool output. A later expandable activity view may show redacted inspection milestones such as files inspected and validation completed.

Implementation outline:

1. Define an allowlisted `ReviewActivityEvent` type with event kind, safe message, timestamp, and optional file/finding identifiers.
2. Give each owned run a bounded activity buffer with a maximum event count and message length.
3. Emit events from explicit workflow phases and read-only inspection tools, not by forwarding raw stdout or model output.
4. Add agent, model, review mode, current phase, and activity events to the safe run projection.
5. Keep the existing session/attempt ownership checks on `GET /v1/runs/:runId`.
6. Render an expandable `Activity` timeline in `SafeRunPanel` with status icons, timestamps, and clear progress labels.
7. If a human-readable rationale is needed, generate and validate a final summary; never expose hidden chain-of-thought.

### 9. Diff does not reliably respond to user scrolling

In the packaged Electron app, the diff has a nested scroll container and contains more content than its viewport, but a real wheel event can reach the diff without advancing its scroll position. Programmatic scrolling still works, so this is a user-scroll integration problem rather than missing content.

Before changing event handling, identify the actual wheel event target, Pierre `CodeView` scroll owner, virtualization viewport, and outer workbench scroll owner in the packaged app. The existing narrow `scrollBy` behavior after virtualized batches append must be reviewed rather than replaced blindly.

Requirements:

- Wheel and trackpad scrolling over the code surface must move the diff.
- The outer workbench must not swallow diff scroll input.
- Page Up, Page Down, Home, End, and focused keyboard scrolling must work.
- The scroll position must remain stable while virtualized files are appended.
- Keep the review toolbar and side rails usable without creating competing scroll containers.
- Verify with the packaged Electron app, not only the browser fixture.

Investigate the Pierre `CodeView` scroll event/virtualization integration before adding a manual wheel workaround.

### 10. Inbox freshness depends on manual refresh

The inbox currently relies on the user pressing `Refresh all` to see current GitHub state. That makes queue state, checks, and recommended actions easy to miss or become stale.

Define freshness as a snapshot contract, not a boolean. The projection should distinguish at least:

- Refreshing.
- Complete and current, with `refreshedAt`.
- Complete but aged.
- Partial or incomplete repository results.
- Failed refresh with usable cached data.
- No usable data.
- Paused because the app is hidden or inactive.

The UI must not label partial or failed data as `Current`. Preserve repository-level completeness and failure reasons where they affect queue actions.

Recommended policy:

- Refresh automatically when the inbox opens.
- Refresh when the app returns to the foreground.
- Poll while the inbox is visible, using a conservative interval such as 60 seconds.
- Pause polling when the app is hidden or inactive.
- Do not overlap refresh requests.
- Back off after repeated failures.
- Show `Updated just now`, `Updated 1m ago`, or `Refresh failed`.
- Keep `Refresh now` as a secondary manual escape hatch.

The freshness state must remain visible and must not imply current data when refresh failed or was paused.

### 11. Pointer affordance

Enabled buttons now use a pointer cursor globally. Verify this remains consistent for native row controls, Base UI buttons, disabled controls, and keyboard focus states.

### 12. Configurable review model and reasoning level

Current review execution hard-codes `opencode-go/deepseek-v4-flash` and `low` thinking in `src/workflows/review-pr.ts`. Flue beta.9 supports per-call `model` and `thinkingLevel` overrides on `session.prompt()`, with call-level values taking precedence over agent defaults.

Recommended flow:

1. Create or resume the review session without executing the model.
2. User clicks `Run review`.
3. Show a configuration dialog with an allowlisted model and reasoning-level selector.
4. Validate the selection at the local API boundary.
5. Persist the chosen model and thinking level on the review attempt before execution.
6. Pass them as per-call Flue overrides.
7. Display the actual attempt metadata in the run panel and completed result.

Contract requirements:

- Model IDs come from a main-process catalog of models supported/configured by Pi; do not accept arbitrary provider strings from the renderer.
- The API validates the selected model against the current runtime catalog before starting an attempt.
- Thinking level is a bounded value: `low`, `medium`, or `high`.
- Historical attempts retain their recorded model; do not rewrite them.
- Unknown historical/runtime values display as `Unknown model` or `Unknown reasoning level`.
- The local Flue type surface must include the prompt override fields or a narrowly justified local type.
- Model selection is per attempt, while user preference may be remembered per profile without changing historical attempts.

### 13. Adapt the pi-review prompt/rubric and expose richer results

Reference reviewed: `earendil-works/pi-review/review.ts`, commit `f1de050` (MIT), cached at `~/.cache/checkouts/github.com/earendil-works/pi-review`.

Useful upstream material to adapt:

- Scope-specific review instructions that identify the comparison base and expected diff.
- Evidence-first finding rules: flag only introduced, discrete, actionable issues with provable impact; avoid speculation and intentional behavior.
- High-signal rules for untrusted input, silent error recovery, fail-fast handling, duplication, unnecessary abstractions, operational risk, and back pressure.
- Comment-writing rules: explain why, name the scenario, keep it brief, use precise locations, and reserve suggestions for concrete replacements.
- Priority definitions P0–P3, an overall verdict, and non-blocking human callouts.
- A structured fix queue for turning review findings into implementation work.

Adapt rather than copy blindly:

- Keep Patchdesk's read-only inspector boundary; the upstream extension asks the agent to run shell/GitHub commands, which Patchdesk must not do.
- Keep Patchdesk's schema validation and post-processing ownership for diff mapping, lifecycle, freshness, and posting state.
- Do not expose upstream raw notes, prompts, credentials, command output, or hidden reasoning in the renderer.
- If substantial rubric text is copied, preserve the upstream MIT copyright notice in the appropriate source/notice location.

Richer result presentation should include more than severity chips:

- **Review summary:** verdict, change summary, confidence/coverage cues, and whether the result is submitted.
- **Finding queue:** group/filter by P0–P3, category, confidence, mapping state, and lifecycle state.
- **Finding detail:** title, priority meaning, category, confidence, exact file/line, diff side, why it matters, affected scenario, suggested change/comment, and mapping status.
- **Evidence:** expandable inspected context and linked diff location, without raw provider output.
- **Validation:** validation plan, assumptions, prior-finding assessments, and unresolved/unknown items.
- **Human callouts:** dependency, migration, auth, compatibility, destructive-operation, or configuration notes kept separate from fix findings.
- **Fix queue:** an ordered local checklist derived from actionable findings, never an automatic GitHub write.

The default screen should provide a scannable summary and priority queue, then let users expand a finding without losing the surrounding review context.

### 14. Global appearance and selectable Pierre diff themes

The renderer is currently dark-only, and `ReviewDiffView` hard-codes `github-dark-high-contrast` plus dark-only CSS overrides. Pierre supports paired themes and `themeType`, so Patchdesk can switch the diff with the global appearance setting while still allowing a user-selected theme family.

Recommended behavior:

- Add global appearance: `system`, `light`, and `dark`.
- Persist the appearance preference locally and apply it to the document root so all Patchdesk surfaces switch together.
- Define complete light and dark design tokens, including `color-scheme`, backgrounds, borders, text, status colors, forced-colors behavior, dialogs, rails, and controls.
- Add a diff-theme selector with curated accessible pairs, rather than exposing arbitrary Shiki theme IDs.
- Pass Pierre a paired theme object such as `{ dark, light }` and `themeType` derived from global appearance.
- When appearance changes to light, automatically render the selected pair's light theme; when it changes to dark, render its dark theme.
- Keep a high-contrast option and verify every pair in grayscale, dark mode, light mode, and forced-colors mode.
- Store global appearance separately from per-profile review-view preferences; preserve existing diff layout preferences.
- Re-render or reset Pierre's highlighter cache when the theme changes so stale token CSS cannot remain visible.

The theme selector should live in Settings and be reachable from the review workbench's Options menu. It must show the active global appearance and active diff theme in accessible text, not only a color preview.

### Typography reference: Plannotator

Reviewed `backnotprop/plannotator` at commit `fc25ddff` (2026-07-22), cached at `~/.cache/checkouts/github.com/backnotprop/plannotator`.

Relevant defaults:

- App font: `Inter, system-ui, sans-serif`.
- Base UI type: `1rem` / `16px`, line-height `1.55`.
- Small UI type: `0.875rem` / `14px`, line-height `1.45`.
- Code font: `JetBrains Mono, Fira Code, monospace`.
- Diff code: `13px`, line-height `20px`.
- File rows: `13px`.

Patchdesk currently uses Geist Variable for the app and Pierre code styling around `13px` / `20px`. Use Plannotator's values as a readability comparison, not a blind copy. The plan should test whether Inter improves body readability and whether a user-selectable code font size, such as `13px`, `14px`, or `15px`, improves long diff reading without violating the fixed desktop geometry.

### Visual system reference: Linear

Use [Linear's design analysis](https://github.com/voltagent/awesome-design-md/blob/main/design-md/linear.app/DESIGN.md) for Patchdesk's visual language, while adapting it from a dark-only marketing canvas to a light/dark desktop product.

Keep Plannotator's typography defaults: `Inter, system-ui, sans-serif`, `JetBrains Mono, Fira Code, monospace`, `16px` base UI text, `14px` small UI text, and `13px` / `20px` diff code. Linear's hierarchy may still guide weight, restrained tracking, and emphasis without changing those sizes.

Apply these Linear principles:

- Use a quiet surface ladder for hierarchy: canvas → surface 1 → surface 2 → surface 3, with 1px hairline borders instead of heavy shadows.
- Use Linear lavender-blue (`#5e6ad2`) sparingly for primary actions, focus rings, selected states, and links; do not turn it into a decorative background or compete with semantic status colors.
- Use a 4px spacing base with the practical scale `4 / 8 / 12 / 16 / 24 / 32 / 48`, subject to Patchdesk's fixed rail, title-bar, inspector, and compact-layout contracts.
- Use the radius scale `4 / 6 / 8 / 12 / 16px`; use `8px` for buttons and inputs, `12px` for cards/panels, and pills only for statuses or compact toggles.
- Define primary, secondary, tertiary, and inverse action treatments with clear hover, pressed, disabled, and keyboard-focus states. Button labels retain Plannotator's `14px` size.
- Keep elevation quiet: prefer surface changes and hairlines; avoid broad gradients, spotlight cards, and unnecessary drop shadows.
- Use explicit text tiers equivalent to Linear's ink, muted, subtle, and tertiary roles, while maintaining the contrast and color-independent status requirements in this plan.
- Preserve semantic colors for success, warning, error, and review severity. Linear's single-accent marketing restraint must not remove the distinct non-color labels/icons needed for Patchdesk status and findings.

Adaptations required for Patchdesk:

- Add a light counterpart for every dark token; Linear's source document does not define a light marketing theme.
- Keep the existing global `system` / `light` / `dark` appearance contract and make Pierre select the matching member of the chosen theme pair.
- Use Linear's product-like density and hierarchy, not its marketing-page layout, oversized display typography, or screenshot-led sections.
- Do not change the maintainer-surface geometry: 48px title bar, 232px application rail, 208px queue rail, and 336px inspector.
- Validate the resulting tokens in normal color, grayscale, forced-colors, keyboard focus, and packaged Electron surfaces.

## Decisions made — review execution selection

- The selector may offer any model supported by the active Pi runtime, subject to main-process validation.
- The default reasoning level is `medium`.
- The last model and reasoning-level selection is remembered per profile.
- Each review attempt stores the actual model and reasoning level used; historical attempts are not rewritten.
- Global appearance supports `system`, `light`, and `dark`.
- Switching global appearance switches the active Pierre diff theme to the matching light/dark member of the selected theme pair.

## Implementation progress — 2026-07-23

Completed and committed:

- `4b78b03`: explicit review configuration, Pi catalog adapter, head verification, read-only navigation, and initial appearance support.
- `fe214bc`: prepared review workbench with read-only diff and checks entry points.
- `a3450c2`: paired Pierre diff theme preference in Settings and workbench Options.
- `c9dab79`: truthful `Starting` attempt state; restart recovery never resumes a review automatically.
- `87e4ab6`: Base Nova global typography restored; Pierre code typography scoped to the diff surface.
- `dad8c23`: current Pi catalog lookup at review start, typed head-verifier failures, and compensated review-start persistence.
- `3ad6e83`: explicit completed-review and GitHub freshness labels.

In progress:

- Bounded, process-local coordinator activity is implemented as lifecycle-only events. Attempt-owned agent/model/mode/access metadata and its renderer contract remain incomplete.

Still required before this plan is complete:

- Automatic inbox freshness states, polling, foreground/visibility behavior, overlap protection, and backoff.
- Result filtering, mapped evidence, validation, typed callouts, and complete check grouping/link presentation.
- Allocated-attempt context artifacts instead of the current prepared-context `001` source.
- Packaged Pierre scroll-owner diagnosis/fix and full packaged Electron QA.
- Workspace-origin discovery rationale and traversal/safety coverage.

## Design decisions to settle

- Which actions are primary versus secondary on the shared PR detail/workbench screen.
- Whether queue counts and check states need a text label in compact desktop mode.
- Whether `View diff` should become the default initial section for every unreviewed PR.
- The exact head-SHA revalidation behavior between diff inspection and review start.
- How the runtime model catalog exposes availability and friendly labels for models supported by Pi.
- Whether model and agent labels come from immutable attempt metadata, with `Unknown model` when unavailable.
- Whether the default result view is summary-plus-priority queue or a findings-first list.
- Which evidence is safe and useful to expose beyond the mapped diff location.
- Whether a local Fix queue is persisted with the draft or derived from the current result.

## Implementation slices

1. Inventory all status badges, dots, check states, severity labels, action labels, and result fields.
2. Define shared status, freshness, severity, check, verdict, submission, and callout vocabulary.
3. Define the runtime model catalog, reasoning contract, and Run review configuration dialog.
4. Define global appearance tokens and curated paired Pierre themes.
5. Adapt the upstream review rubric into Patchdesk's read-only, schema-backed prompt and instruction layers.
6. Define the review-session-backed workbench state and its read-only diff/checks projections.
7. Implement single-click/Enter navigation and explicit `View diff`, `Run review`, and `Inspect failing checks` actions.
8. Add head-SHA carry-forward and revalidation before review execution.
9. Design and implement the summary, finding detail, evidence, validation, callout, and local Fix queue views.
10. Update badges, checks, severity hierarchy, and color-independent affordances.
11. Define and implement the bounded runtime metadata/activity projection.
12. Diagnose and fix packaged Pierre scrolling without broad event interception.
13. Implement automatic inbox refresh, visibility pause, overlap protection, backoff, and partial-state reporting.
14. Verify appearance switching and every curated diff theme in desktop, compact, keyboard, forced-colors, grayscale, and packaged Electron surfaces.

## Verification

Focused:

- `pnpm lint`
- `pnpm typecheck`
- Relevant renderer tests
- Relevant browser tests, including horizontal-overflow assertions

Full UI gate:

- `pnpm test -- --run`
- `pnpm build`
- `pnpm exec playwright test`
- `pnpm package:mac`
- `pnpm test:package-smoke`
- Launch packaged app with CDP on `9237` and verify the real surface with `agent-browser`.

Packaged QA must check:

- Load `agent-browser` core and Electron skills before testing.
- Snapshot before every interaction and re-snapshot after clicks because refs become stale.
- Badge meaning and color-blind readability in dark mode, grayscale, and forced-colors mode.
- PR selection and single-click navigation into the shared review session/workbench.
- PR navigation creates/resumes the expected review session without executing the model.
- `Run review` is the explicit model-execution transition.
- Diff/check inspection remains read-only and does not create an empty draft or GitHub write.
- Exact head SHA remains visible and stale transitions are blocked.
- Failing-check rows open the Checks section and expose a useful read-only action.
- Runtime agent/model/mode/access metadata matches the attempt projection.
- Activity output is bounded, redacted, and free of prompts or provider internals.
- Review navigator layout and real Pierre wheel/keyboard scrolling.
- Saved customer-management PR #118, rail restoration, and command palette.
- Console/page errors after each route or workflow.
- `document.documentElement.scrollWidth - document.documentElement.clientWidth === 0`.

Add contract tests for model allowlist and reasoning-level parsing, attempt persistence, per-call Flue overrides, appearance preference parsing, paired theme selection, global light/dark token rendering, review-session-backed navigation, read-only diff/check inspection, SHA revalidation, adapted rubric output, richer result fields, finding grouping/filtering, partial refresh, refresh overlap/backoff, status text, check grouping, and activity projection rejection/redaction. Axe checks are necessary but insufficient: visible labels and grayscale/contrast evidence are also required.

## Notes from Matthew

_Add observations here as they are found._
