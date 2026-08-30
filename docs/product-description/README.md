# Patchdesk product description

A written description of the Patchdesk user experience: what the maintainer sees, what they can do, and exactly what happens when they do it.

## Purpose

Patchdesk is, from the maintainer's point of view, a large state chart. The maintainer moves through it with screens, dialogs, form edits, clicks, keyboard commands, refreshes, GitHub writes, and optional Insight runs. Most of that behavior is defined implicitly across React flows and hooks, domain transitions, services, Electron routes, and tests. There is no single place that says, in plain language, what happens when a maintainer starts an action and what happens if the action is interrupted.

This directory is that place. It describes the default Patchdesk desktop experience on macOS, from first run through pull-request review, with the normal local configuration and no fixture route active.

The documents are for designers, engineers, writers, testers, and anyone deciding whether a behavior is intentional. They are written from the outside in. They describe the experience, not the implementation.

### What this is not

- Not API documentation. The local API boundary is described in [`docs/architecture.md`](../architecture.md) and its routes live under [`src/main/routes/`](../../src/main/routes/).
- Not organized by package. Renderer, domain, service, and adapter modules are evidence for one user experience; they are not separate documentation areas here.
- Not a technical design document. Critical mechanisms appear only in block quotes labeled `Technical note:`.

## Conventions

- Describe the experience, not the code. Write "The Save button stays disabled while Patchdesk waits for the profile update" rather than "the hook sets `savingProfile`."
- Technical detail goes in block quotes prefixed with `Technical note:`. Use it only when the mechanism changes what the maintainer would expect.
- Use sentence case for headings.
- Name the vocabulary consistently. The [glossary](glossary.md) owns terms such as *Pull requests screen*, *Selected repository*, *Review*, *Review session*, *Insight*, and *Fresh*.
- Every feature document ends with the Patchdesk application-source commit it was checked against and a list of open questions.
- State surprising behavior plainly and give the reason when the source or a comment supplies one.

## The work to be done

Each document describes one feature. Features can be large, such as finishing a GitHub review, or small, such as changing a diff theme. Each document covers the common path, visible states, variants, interrupts, related systems, and edge cases.

### Document template

Every feature document follows the same eight-section skeleton so documents can be compared and omissions are visible.

1. **Summary.** One paragraph that names the feature, where the maintainer reaches it, and when it is available.
2. **The simple case.** The common path in prose.
3. **The task, event by event.** The five phases of a maintainer task: **arrive**, **leave unchanged**, **begin an action**, **while the action runs**, and **settle**. Each document includes one small Mermaid `stateDiagram-v2` with only the states the maintainer passes through.
4. **Variants.** Every document uses these rows, in this order:
   - Workspace profile and GitHub account.
   - Pull request and Review state.
   - GitHub permissions and merge readiness.
   - Network, local tool, and Insight provider availability.
   - Input path: mouse, keyboard, or desktop menu.
5. **Cancel and interrupt.** Every document uses these rows, in this order:
   - Cancel, Stop, or Escape.
   - Navigate to another Patchdesk screen, Review, Settings section, or workspace profile.
   - Start another action or request a refresh.
   - GitHub, the network, a local tool, or an Insight provider fails or times out.
   - Close Settings, reload the renderer, close the window, or quit Patchdesk.
   - The pull request, represented revision, pending review, permission, or other target changes elsewhere.
   - macOS focus, a file or folder picker, or another input path takes control.
6. **Interactions with other systems.** Every document walks these concerns in this order:
   - Workspace profile and identity.
   - Review revision and freshness.
   - Local persistence and recovery.
   - GitHub permissions and write authority.
   - Network, local tools, and Insight providers.
   - Concurrent operations and locking.
   - Feedback, errors, and diagnostics.
   - Preferences, keyboard commands, and desktop integration.
   - Supported input and accessibility limits.
7. **Edge cases.** Empty states, boundaries, repeated actions, unusual ordering, and other visible cases not covered above.
8. **Open questions and verification.** Behavior not confirmed in the running app, suspected defects, assumptions, and the pinned source commit.

The interrupt table matters most. Asking the same questions of every feature makes gaps and inconsistencies visible.

### Method

For each document:

1. Read the renderer flow, hook, or component that owns the interaction and the domain values it displays.
2. Read the service and route that perform the action where the task crosses the local API.
3. Read matching domain, service, renderer, and browser tests. The canonical user-facing cases are indexed in [`docs/test-cases.md`](../test-cases.md).
4. Draft the document from that evidence.
5. Try ambiguous behavior in the running desktop app over CDP port 9233. Code and tests settle what happens; the running app settles what appears, what receives focus, and how intermediate states feel.
6. Record the source commit.

### Verification

Drafting reads the code; verification watches the product. The `verification/` directory will hold one checklist per cluster of documents. Each item is one observable claim with setup, steps, expected result, priority, required condition, and result.

A tester runs the checklists in the default macOS desktop app and records `pass`, `fail`, or `blocked`. A failure goes into `bug-triage.md` with the checklist ID. A document moves from `drafted` to `verified` only when every P1 and P2 item has passed or has been filed.

`bug-triage.md` consolidates suspected defects raised by the documents. It will name the user-visible behavior, reproduction, source cause, severity, and decision needed. An automated or static pass alone does not confirm live desktop behavior.

### Order of work

1. **Pilot: the workspace profile editor.** It is a bounded form with validation, a save operation, a dirty-draft guard, and a failure path.
2. **Foundations.** Task lifecycle and interruption, navigation, workspace identity, Reviews and sessions, and persistence own the facts every later document links to.
3. **The Review workbench.** This is the hardest area. Its navigation, diff, conversations, pending review, and merge states hand off to each other.
4. **Everything else.** First run, the Pull requests screen, Insights, Settings, and cross-cutting behavior follow after the exemplars. The final passes check consistency, hand verification, and bug triage.

Progress is tracked in the [coverage table](#coverage).

### Scope decisions

- **Surface.** The whole default Patchdesk desktop app on supported Apple Silicon macOS is in scope. The maintainer uses one local app window, a keyboard and mouse, workspace profiles, local checkouts, GitHub CLI authentication, and optional configured Insight providers.
- **Source snapshot.** Application behavior is pinned to committed source `3100615`. Uncommitted source changes in the checkout are not evidence for this pass. Documentation-only commits after that snapshot do not change the pinned application behavior.
- **Runtime.** Development verification uses `REMOTE_DEBUGGING_PORT=9233 pnpm dev` and `agent-browser` over CDP 9233. The raw app log is `~/.local/share/patchdesk/logs/patchdesk.jsonl`.
- **Fixture routes.** Browser and performance fixture routes are test harnesses, not maintainer-facing product surfaces, so they are out of scope.
- **Installation and release production.** Downloading a release, Gatekeeper recovery, packaging, signing, notarization, and release publication are out of scope. Startup after installation and single-instance behavior remain in scope where they affect the running app.
- **Unsupported platforms and assistive technology.** Intel macOS, Windows, Linux, touch, pen, and screen-reader behavior are out of scope because Patchdesk does not support them. Keyboard and focus behavior remain in scope.
- **External products.** GitHub, `git`, `gh`, Codex, model APIs, and macOS pickers are described only where Patchdesk invokes them or presents their result.
- **Generated wording.** Insight content is nondeterministic. Documents describe the fixed structure, provenance, lifecycle, and controls, not exact model wording.
- **Interaction shape.** The unit is a maintainer task. Its phases are arrive, leave unchanged, begin an action, while the action runs, and settle. The variant rows, interrupt rows, and cross-cutting order are fixed as written above.
- **Numbered rules.** These are prose documents, not a numbered specification. Stable heading anchors are enough for cross-references.
- **Repository layout override.** The skill normally creates a separate repository. The maintainer explicitly chose `docs/product-description/` in the Patchdesk repository. Application source remains read-only for this work; only this directory may change.

## Structure

```text
README.md                          this file
goal.md                            standing drafting instructions
AGENTS.md, CLAUDE.md               entry points for future drafting sessions
glossary.md                        shared vocabulary
bug-triage.md                      consolidated suspected defects

verification/
  README.md                        hand-verification protocol
  foundations-and-settings.md      foundations and Settings checklists
  pull-requests.md                 first-run and Pull requests checklists
  review-workbench.md              workbench and GitHub-write checklists
  insights-and-cross-cutting.md    Insight and cross-cutting checklists

foundations/
  task-lifecycle-and-interruption.md  task phases, variants, interrupts, and operation states
  navigation-and-overlays.md         screens, Settings, restoration, focus, and leave guards
  workspace-profile-and-identity.md  profiles, GitHub identity, repositories, and local roots
  review-session-and-revision.md     Pull request, Review, session, worktree, and freshness
  persistence-and-recovery.md        saved local state, cache, journals, locks, and recovery

first-run/
  setup-checklist.md                 GitHub access, required tools, and first repository
  repository-discovery.md            workspace-root scanning and watchlist selection

pull-requests/
  selected-repository.md              one repository as the listing scope
  filters-pagination-and-refresh.md   GitHub filters, pages, manual refresh, and freshness
  repository-listing.md               rows, indicators, and recommended actions
  opening-a-review.md                 preparation, progress, failure, and workbench entry

review-workbench/
  conversation-and-metadata.md        PR conversation plus reviewers, assignees, and labels
  files-diff-and-navigation.md        file tree, changed lines, commits, and keyboard movement
  inline-conversations.md             diff comments, replies, thread state, and annotations
  brief.md                            deterministic and model-backed reading orientation
  analysis.md                         findings, evidence, dismissals, and review commands
  walkthrough.md                      guided narrative tied to a represented revision
  pending-review-and-finish.md        GitHub pending review, review body, outcome, and submit
  merge.md                            readiness, warnings, method selection, and reconciliation

settings/
  workspace-profile-editor.md         pilot: create, edit, validate, save, discard, and switch
  appearance-and-diff-theme.md         app appearance and embedded diff themes
  review-defaults.md                   default Insight model and reasoning preferences
  data-and-recovery.md                 cache and local-review-data cleanup
  logs-and-diagnostics.md              app logs, redacted activity, and support evidence

cross-cutting/
  write-safety-and-freshness.md         permission, revision checks, explicit writes, and locks
  errors-and-recovery.md                failure presentation, retry, reload, and uncertain outcomes
  local-storage-and-privacy.md          config, data, cache, logs, redaction, and credentials
  keyboard-focus-and-desktop.md         keyboard use, focus return, menus, window state, and limits
```

## Coverage

Status is one of `not started`, `drafted`, or `verified`.

| Document | Status |
| --- | --- |
| glossary.md | drafted |
| bug-triage.md | not started |
| verification/ (4 checklists) | not started |
| foundations/task-lifecycle-and-interruption.md | not started |
| foundations/navigation-and-overlays.md | not started |
| foundations/workspace-profile-and-identity.md | not started |
| foundations/review-session-and-revision.md | not started |
| foundations/persistence-and-recovery.md | not started |
| first-run/setup-checklist.md | not started |
| first-run/repository-discovery.md | not started |
| pull-requests/selected-repository.md | not started |
| pull-requests/filters-pagination-and-refresh.md | not started |
| pull-requests/repository-listing.md | not started |
| pull-requests/opening-a-review.md | not started |
| review-workbench/conversation-and-metadata.md | not started |
| review-workbench/files-diff-and-navigation.md | not started |
| review-workbench/inline-conversations.md | not started |
| review-workbench/brief.md | not started |
| review-workbench/analysis.md | not started |
| review-workbench/walkthrough.md | not started |
| review-workbench/pending-review-and-finish.md | not started |
| review-workbench/merge.md | not started |
| settings/workspace-profile-editor.md | drafted |
| settings/appearance-and-diff-theme.md | not started |
| settings/review-defaults.md | not started |
| settings/data-and-recovery.md | not started |
| settings/logs-and-diagnostics.md | not started |
| cross-cutting/write-safety-and-freshness.md | not started |
| cross-cutting/errors-and-recovery.md | not started |
| cross-cutting/local-storage-and-privacy.md | not started |
| cross-cutting/keyboard-focus-and-desktop.md | not started |

## Reference

The source of truth is Patchdesk at `/Users/kwanpham/Work/patchdesk`, pinned to application-source commit `3100615`. Relevant locations are:

- [`src/renderer/src/app.tsx`](../../src/renderer/src/app.tsx): root screen routing, Settings overlay, profile switching, and leave guards.
- [`src/renderer/src/flows/`](../../src/renderer/src/flows/): Pull requests, Review workbench, Settings, and their interaction hooks.
- [`src/renderer/src/components/`](../../src/renderer/src/components/): visible screens, dialogs, readers, pickers, diff, conversations, and status surfaces.
- [`src/domain/`](../../src/domain/): user-visible state words and invariants for Reviews, sessions, Insights, writes, freshness, merge readiness, and listings.
- [`src/services/`](../../src/services/): preparation, refresh, observation, Insights, GitHub writes, recovery, storage management, and listing orchestration.
- [`src/main/routes/`](../../src/main/routes/): local API actions requested by the renderer.
- [`tests/renderer/`](../../tests/renderer/), [`tests/services/`](../../tests/services/), and [`tests/browser/`](../../tests/browser/): executable behavior evidence at the UI, orchestration, and built-app boundaries.
- [`docs/test-cases.md`](../test-cases.md): canonical automated and manual cases for user-facing flows.
- [`CONTEXT.md`](../../CONTEXT.md): canonical product vocabulary and words to avoid.
