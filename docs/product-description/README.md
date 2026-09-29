# Patchdesk product description

A written description of the Patchdesk user experience: what the maintainer sees, what they can do, and exactly what happens when they do it.

## Purpose

These pages describe what a maintainer sees and does in the default macOS desktop app. They describe tasks, not implementation or API details. See [architecture](../architecture.md) for the local API.

## Conventions

- Describe the experience, not the code. Write "The Save button stays disabled while Patchdesk waits for the profile update" rather than "the hook sets `savingProfile`."
- Technical detail goes in block quotes prefixed with `Technical note:`. Use it only when the mechanism changes what the maintainer would expect.
- Use sentence case for headings.
- Name the vocabulary consistently. The [glossary](glossary.md) owns terms such as _Pull requests screen_, _Selected repository_, _Review_, _Review session_, _Insight_, and _Fresh_.
- Every feature document ends with its baseline source commit, any scoped follow-up implementation commit, and a list of open questions.
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

### Verification

[Verification checklists](verification/README.md) record setup, steps, expected outcomes, and live results. Source and tests do not prove the desktop behavior. File defects in [bug triage](bug-triage.md) and non-defect friction in [UX friction](ux-friction.md). A page is verified only when its P1 and P2 checks pass or are filed.

### Scope decisions

- **Surface.** The whole default Patchdesk desktop app on supported Apple Silicon macOS is in scope. The maintainer uses one local app window, a keyboard and mouse, workspace profiles, local checkouts, GitHub CLI authentication, and optional configured Insight providers.
- **Source and verification.** Each feature page names its source commit and live-check limits. A live check does not verify later code.
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
ux-friction.md                     UX friction and dispositions

verification/
  README.md                        hand-verification protocol
  foundations-and-settings.md      foundations and Settings checklists
  pull-requests.md                 first-run and Pull requests checklists
  review-workbench.md              workbench and GitHub-write checklists
  insights-and-cross-cutting.md    Insight and cross-cutting checklists
  unblocking-notes.md              conditions for blocked rows

foundations/
  task-lifecycle-and-interruption.md  task phases, variants, interrupts, and operation states
  navigation-and-overlays.md         screens, Settings, restoration, focus, and leave guards
  workspace-profile-and-identity.md  profiles, GitHub identity, repositories, and local roots
  review-session-and-revision.md     Pull request, Review, session, worktree, and freshness
  persistence-and-recovery.md        saved local state, cache, journals, locks, and recovery
  visited-pull-requests.md           the column of opened pull requests beside every screen

first-run/
  setup-checklist.md                 workspace setup in place on the Pull requests screen
  repository-discovery.md            workspace-root scanning and watchlist selection

pull-requests/
  selected-repository.md              one repository as the listing scope
  filters-pagination-and-refresh.md   GitHub filters, pages, manual refresh, and freshness
  repository-listing.md               rows, indicators, and recommended actions
  opening-a-review.md                 preparation, progress, failure, and workbench entry
  opening-a-local-review.md           shared or commit Review from a local checkout
  coding-agent-over-mcp.md            a coding agent opening, refreshing, and reading a local Review over MCP

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
  workspace-profile-editor.md         pilot: the Workspace settings cards, per-control saving, and switching
  appearance-and-diff-theme.md         app appearance and embedded diff themes
  data-and-recovery.md                 cache and local-review-data cleanup
  logs-and-diagnostics.md              app logs, redacted activity, and support evidence

cross-cutting/
  write-safety-and-freshness.md         permission, revision checks, explicit writes, and locks
  errors-and-recovery.md                failure presentation, retry, reload, and uncertain outcomes
  local-storage-and-privacy.md          config, data, cache, logs, redaction, and credentials
  keyboard-focus-and-desktop.md         keyboard use, focus return, menus, window state, and limits
```

## Coverage

Status is one of `not started`, `drafted`, or `verified`. A document is `verified` only when every P1 and P2 checklist item for it has passed in a hand pass or has been filed in `bug-triage.md`; the automated and CDP passes to date leave every document `drafted`.

| Document                                        | Status  |
| ----------------------------------------------- | ------- |
| glossary.md                                     | drafted |
| bug-triage.md                                   | drafted |
| ux-friction.md                                  | drafted |
| verification/ (4 checklists + notes)            | drafted |
| foundations/task-lifecycle-and-interruption.md  | drafted |
| foundations/navigation-and-overlays.md          | drafted |
| foundations/workspace-profile-and-identity.md   | drafted |
| foundations/review-session-and-revision.md      | drafted |
| foundations/persistence-and-recovery.md         | drafted |
| foundations/visited-pull-requests.md            | drafted |
| first-run/setup-checklist.md                    | drafted |
| first-run/repository-discovery.md               | drafted |
| pull-requests/selected-repository.md            | drafted |
| pull-requests/filters-pagination-and-refresh.md | drafted |
| pull-requests/repository-listing.md             | drafted |
| pull-requests/opening-a-review.md               | drafted |
| pull-requests/opening-a-local-review.md         | drafted |
| pull-requests/coding-agent-over-mcp.md          | drafted |
| review-workbench/conversation-and-metadata.md   | drafted |
| review-workbench/files-diff-and-navigation.md   | drafted |
| review-workbench/inline-conversations.md        | drafted |
| review-workbench/brief.md                       | drafted |
| review-workbench/analysis.md                    | drafted |
| review-workbench/walkthrough.md                 | drafted |
| review-workbench/pending-review-and-finish.md   | drafted |
| review-workbench/merge.md                       | drafted |
| settings/workspace-profile-editor.md            | drafted |
| settings/appearance-and-diff-theme.md           | drafted |
| settings/data-and-recovery.md                   | drafted |
| settings/logs-and-diagnostics.md                | drafted |
| cross-cutting/write-safety-and-freshness.md     | drafted |
| cross-cutting/errors-and-recovery.md            | drafted |
| cross-cutting/local-storage-and-privacy.md      | drafted |
| cross-cutting/keyboard-focus-and-desktop.md     | drafted |

## Reference

The source of truth is Patchdesk at the repository root. Each feature page names its source commit. Relevant locations are:

- [`src/renderer/src/app.tsx`](../../src/renderer/src/app.tsx): root screen routing, Settings overlay, profile switching, and leave guards.
- [`src/renderer/src/flows/`](../../src/renderer/src/flows/): Pull requests, Review workbench, Settings, and their interaction hooks.
- [`src/renderer/src/components/`](../../src/renderer/src/components/): visible screens, dialogs, readers, pickers, diff, conversations, and status surfaces.
- [`src/domain/`](../../src/domain/): user-visible state words and invariants for Reviews, sessions, Insights, writes, freshness, merge readiness, and listings.
- [`src/services/`](../../src/services/): preparation, refresh, observation, Insights, GitHub writes, recovery, storage management, and listing orchestration.
- [`src/main/routes/`](../../src/main/routes/): local API actions requested by the renderer.
- [`tests/renderer/`](../../tests/renderer/), [`tests/services/`](../../tests/services/), and [`tests/browser/`](../../tests/browser/): executable behavior evidence at the UI, orchestration, and built-app boundaries.
- [`CONTEXT.md`](../../CONTEXT.md): canonical product vocabulary and words to avoid.
