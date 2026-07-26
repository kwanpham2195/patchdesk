# Global Settings redesign

**Status:** Proposed; awaiting review

## Summary

Patchdesk Settings currently behaves as a long, full-page form that mixes
global appearance, profile configuration, workspace paths, GitHub access,
watchlist management, and local review cleanup. That forces a user to leave the
inbox or a review workbench to change a theme or profile and makes the page hard
to scan and scroll.

This design turns Settings into a centered modal that can be opened from any
screen. It always opens on **General**, keeps the current route visible behind
it, owns its own scroll region, and closes back to the exact underlying state.
Global preferences apply immediately. Profile/workspace edits remain explicit,
while changing the active profile applies immediately when there are no
unsaved edits.

The redesign also incorporates the approved recovery cleanup contract: Settings
does not expose saved-review lists, older-version lists, quarantine controls, or
per-review cleanup. Data & recovery exposes only **Clear cache** and **Clear
local review data**, with concise confirmations and safe retry behavior.

## Goals

- Open Settings globally from the gear button, `⌘,`, or Navigate without
  navigating to Home.
- Keep the current inbox, PR, diff, review run, or workbench visible underneath
  the modal and restore it unchanged on close.
- Always open on General; do not remember or infer the last section in V1.
- Fix scrolling by giving the modal an explicit, independently scrollable
  content region.
- Separate global preferences from profile/workspace configuration and
  profile-scoped review data.
- Apply appearance and diff-theme changes immediately.
- Switch the active profile immediately when there are no unsaved edits, then
  reload profile-scoped workspace data without leaving stale PR state visible.
- Require explicit Save profile for profile/workspace edits.
- Make unsaved changes, profile switching, and closing behavior predictable.
- Remove internal storage-management concepts from normal Settings UI.
- Preserve the renderer sandbox, main-process API boundary, and strict config
  ownership rules in `AGENTS.md`.

## Non-goals

- Adding a second settings persistence system or moving profile data into the
  global config file.
- Storing credentials, tokens, workspace paths, watchlist entries, searches,
  saved views, or review model choices in global config.
- Auto-saving profile/workspace edits on every keystroke.
- Opening Settings on a context-specific section in V1.
- Managing watched repositories inside Settings after the redesign; Watchlist
  remains a dedicated PR-management surface.
- Showing saved-review lists, older-version review lists, quarantine folders,
  worktrees, sessions, attempts, runtime names, or raw diagnostics.
- Changing GitHub data when a user only changes a local setting.

## Product contract

### Global entry and modal behavior

The app shell provides three equivalent entry points:

- the persistent gear button;
- `⌘,` on macOS (and the platform equivalent where applicable);
- the existing Navigate/command surface.

Every entry point opens the same centered Settings modal on **General**. The
entry point never changes the current `AppDestination`, clears a workbench, or
returns the user to Home. Existing settings navigation state is migrated to
the overlay state so a stale deep link cannot replace the underlying route.

The modal has:

- a title, close button, and current profile context in the sticky header;
- a left section rail on wide screens;
- a compact section selector on narrow screens;
- a scrollable content pane with `min-height: 0` and bounded max height;
- a footer that shows only actions relevant to the current section.

The modal is viewport-bounded, for example `min(960px, calc(100vw - 32px))`
wide and `calc(100vh - 32px)` tall. On small screens it becomes a full-screen
dialog while retaining the same section and focus behavior. The underlying
page does not scroll while the modal is open.

On close, focus returns to the control that opened Settings. Escape and the
close button work when there are no unsaved profile edits. If a profile draft is
dirty, close shows a confirmation with **Keep editing**, **Discard changes**,
and **Save profile** where saving is valid. A pending network operation blocks
close until it settles or returns a retryable error.

### Sections

The modal contains these sections in this order:

1. **General** — global appearance and diff theme.
2. **Profiles** — active profile selection and profile create/edit flow.
3. **Workspace** — roots, owner filters, rule paths, and profile-scoped
   workspace settings.
4. **GitHub access** — configured host/account status and explicit access test.
5. **Review preferences** — per-profile default model/reasoning choices and
   review behavior that can be restored by generation dialogs.
6. **Data & recovery** — global cleanup actions and optional support-safe
   diagnostics entry points when the diagnostics service is available.

Watchlist is removed from Settings and remains in its dedicated queue/sidebar
surface. Repository discovery and local path editing belong there because they
change the PR manager’s working set, not the application’s configuration.

All invocations begin on General. Section clicks are local modal state and do
not change the underlying application route.

### Scope labels

Every setting that is not global carries a short scope label:

- `Global` for appearance, diff theme, and app-level behavior;
- `Profile: <label>` for GitHub host/account, workspace roots, owner filters,
  rules, and review defaults;
- `Local review data` for cleanup actions scoped to the selected profile or
  app-owned local storage.

The scope label is explanatory UI. It does not change the storage contract.

## Section behavior

### General

Appearance offers `System`, `Light`, and `Dark`. The selected value applies to
the modal and the underlying app immediately, then persists through the
existing global settings API.

Diff theme keeps separate Light and Dark Pierre theme choices. Changing either
choice applies to visible diff surfaces immediately and persists through the
existing `diffTheme` global setting. Invalid theme IDs are rejected at the
renderer and main-process boundaries.

General contains no Save button. A failed persistence request leaves the last
accepted value in place and shows a concise retryable message.

### Profiles

The active profile selector is visible at the top of the section and in the
modal header. Selecting another existing profile is immediate when the current
profile draft is clean. Patchdesk:

1. confirms the profile is valid;
2. persists the selected profile ID through the existing profile-selection API;
3. reloads profile-scoped dashboard, inbox, watchlist, and workspace data;
4. clears any stale profile-scoped workbench that cannot belong to the new
   profile;
5. keeps the Settings modal open on General or returns to General after the
   reload, never to a broken route.

If a profile draft is dirty, switching offers **Save and switch**, **Discard
changes and switch**, and **Cancel**. A profile switch never silently loses
edited roots, filters, or rule paths.

Creating a profile opens a clean draft in Profiles. Editing an existing profile
keeps its immutable ID. **Save profile** validates required fields, absolute
workspace/rule paths, owner filters, GitHub host/account, and repository shape
before calling the existing profile API. A successful save reloads the active
profile’s workspace. A failed save keeps the draft and error visible.

### Workspace

Workspace owns profile-scoped configuration only:

- absolute workspace roots;
- owner filters;
- rule paths such as `AGENTS.md` locations.

Each list has an accessible add/remove editor, directory picker where
appropriate, validation feedback near the offending field, and one explicit
Save profile action. The modal never displays raw environment paths outside the
profile editor or sends them to GitHub.

### GitHub access

GitHub access shows the configured host and account as profile-scoped values and
provides an explicit **Test GitHub access** action. The result is a concise
status such as `Connected`, `Needs sign-in`, or `Unavailable`, with a retry
action. Credentials and tokens never appear in the modal or renderer state.

Connection failure does not prevent changing appearance or editing a profile
draft. Profile save reports GitHub configuration validation separately from
network access failures.

### Review preferences

Review preferences are profile-scoped defaults, not global config. They include
the default model and reasoning level used to preselect the existing Run review,
Generate walkthrough, and Generate PR description dialogs. The choices remain
`Low`, `Medium`, and `High`.

Changing a default does not start a review or generation request. Individual
action dialogs may override the default and persist that explicit per-profile
choice through the existing preference mechanism. If the configured model is
disabled or unavailable, Settings shows the value as unavailable and the
action dialog requires a valid selection.

### Data & recovery

Data & recovery contains one compact local-data card with exactly two global
actions:

- **Clear cache** — removes rebuildable local cache while keeping saved reviews
  and diagnostics.
- **Clear local review data** — removes disposable local review data while
  preserving running and recoverable reviews.

The UI does not show saved-review lists, older-version lists, quarantine names,
session IDs, or byte-level storage internals. Each action has a confirmation
that explains its user-visible effect, disables controls while pending, keeps
the confirmation context after failure, and closes only after success. Missing
disposable data is already-clean success.

If the diagnostics service exposes a support-safe feature, this section may
offer **Copy incident ID** or **Export debug bundle**. Any bundle is sanitized
and contains no credentials, absolute paths, raw stack traces, full diffs, or
untrusted PR text. This is a support action, not a storage browser.

The cleanup service still evaluates protected review states at execution time,
uses app-owned path checks, and treats missing disposable data as success. Those
retention and filesystem details remain internal implementation behavior rather
than Settings copy.

## Architecture and state ownership

### Application shell

Move Settings invocation state to the app shell boundary:

- `src/renderer/src/app.tsx` owns `settingsOpen`, the opener reference, and
  profile/workspace reload coordination;
- `src/renderer/src/components/app-shell.tsx` renders the persistent gear
  trigger, keyboard shortcut handling, and Navigate command action;
- `src/renderer/src/components/settings-modal.tsx` owns the centered dialog,
  section navigation, focus return, scroll containment, and close guard;
- `src/renderer/src/flows/settings-flow.tsx` becomes a section coordinator or is
  split into focused section components rather than one long page.

The modal receives the same existing callbacks for global settings, profile
selection, workspace reload, repository refresh, and authenticated requests.
It must not gain Node.js or direct filesystem access.

The old `destination.kind === "settings"` full-page path may remain as a
temporary compatibility entry during migration, but it must normalize to
`settingsOpen=true` over the current safe destination. Once all callers and
tests use the overlay, delete the full-page settings route and its special
`overflow-y-auto` main-pane branch.

### Persistence boundaries

Keep the existing ownership rules:

- `~/.config/patchdesk/config.json` contains only strict global state such as
  appearance, diff themes, and the selected profile ID;
- `~/.config/patchdesk/profiles/<profile-id>.json` contains profile label,
  GitHub host/account, owner filters, workspace roots, rule paths, and repos;
- review preferences use their existing profile-scoped preference storage;
- local review data and cleanup remain behind storage-management services;
- watchlist data remains in watchlist controls and APIs.

Do not move profile or review data into global config to simplify the modal.

### Local API and capability boundary

The modal continues to use authenticated preload requests. The redesign may
remove old Settings-only storage routes when the recovery cleanup migration is
complete, and adds `POST /v1/storage/clear-local-data` while retaining
`POST /v1/storage/cache/clear`.

No Settings route is published from `src/app.ts`. All route changes must update
`src/main/local-api.ts`, `src/main/desktop-bridge.ts`, and authorization tests
together.

## Migration and compatibility

- Opening the old Settings destination resolves to the modal over the current
  safe route during migration.
- Existing global appearance and diff-theme values continue to load through
  `/v1/settings` and legacy renderer preference migration remains intact.
- Existing profile IDs remain fixed; New profile creates another profile.
- Existing profile fields and absolute-path validation remain compatible.
- Saved-review lists, older-version lists, per-review discard, and quarantine
  deletion are removed with the approved recovery cleanup migration.
- Watchlist entries and repository paths are preserved but rendered in their
  dedicated Watchlist surface.
- A modal close does not mutate navigation history except for removing a
  temporary legacy settings destination when one was used to open it.

## Verification

### Renderer tests

Add or update tests to prove:

- gear, `⌘,`, and Navigate open Settings from dashboard, inbox, and workbench;
- every entry opens General;
- the underlying route and workbench selection remain unchanged after close;
- modal content scrolls independently and the underlying page does not scroll;
- focus enters the dialog and returns to the opener;
- Escape/close confirmation protects dirty profile drafts;
- appearance and diff-theme changes apply immediately;
- profile switching is immediate when clean and offers save/discard/cancel when
  dirty;
- profile save errors keep the draft visible;
- Settings has no saved-review lists, older-version lists, or quarantine
  controls;
- Data & recovery exposes only Clear cache and Clear local review data;
- model/reasoning defaults remain profile-scoped.

Likely suites include `tests/renderer/profile-settings.test.tsx`,
`tests/renderer/app-shell.ui.test.tsx`, and new focused modal/keyboard tests.

### API and service tests

Keep capability/origin coverage for the modal’s global settings, profile,
watchlist, GitHub access, and cleanup requests. Verify profile selection
reloads safely, cleanup protects running/recoverable data, and obsolete
Settings-only storage routes are removed or rejected after migration.

### Browser and packaged tests

Use fixtures to open Settings from a dashboard, PR inbox, and active review;
change theme without leaving the underlying route; switch profiles; scroll a
long workspace form; attempt to close with unsaved edits; run both cleanup
confirmations; and return to the same workbench.

Run the required desktop/package gate from `AGENTS.md`. Interactive packaged
UI verification is performed by the dedicated tester subagent, not the primary
agent.

## Acceptance criteria

- Settings opens from any supported surface as a centered modal without a Home
  round-trip.
- Every invocation starts on General.
- The modal has independent scrolling and does not lock or lose the underlying
  route.
- Appearance and diff theme apply immediately and persist as global settings.
- Profile switching applies immediately when clean and never silently discards
  a dirty profile draft.
- Profile/workspace edits require explicit Save profile and preserve existing
  profile IDs and path validation.
- Watchlist management is no longer buried in Settings.
- Data & recovery exposes only Clear cache and Clear local review data, with
  the approved preservation/removal semantics.
- No credentials, paths, storage internals, or lifecycle internals leak into
  ordinary Settings UI.
- Existing review, narrative walkthrough, PR-description generation, comment,
  and Files-mode state remains intact when Settings opens and closes.
- Renderer, API, browser, package, and accessibility evidence proves the
  behavior on the real desktop surface.
