# Research: Current user journeys

Date: 2026-08-01

Question: What are Patchdesk's main user journeys in the current implementation?

Method: Read the repository product overview, current renderer flows, local API
routes, service projections, and renderer/browser tests. This is a current-state
map, not a proposal.

## Summary

Patchdesk is a local-first workbench for a maintainer reviewing GitHub pull
requests. Its primary journey is not “ask a model to review code.” It is:

1. Set up or recover a workspace profile.
2. Triage the active watchlist in the Maintainer inbox, or open a known PR.
3. Prepare a pinned local review snapshot.
4. Inspect the PR and optionally start a model review.
5. Turn findings and local comments into one explicitly confirmed GitHub
   review.
6. Refresh readiness and, only when allowed, explicitly confirm a GitHub merge.

The narrative walkthrough is an optional, read-only branch from a prepared or
completed review. Settings and cleanup support the main loop; they are not a
destination in it. A prepared snapshot is not a permission-restricted view:
when freshness and readiness allow it, it also supports local comment drafting,
explicit GitHub review submission, and explicit merge confirmation. The
completed workbench's distinctive capability is the model-produced review
result and its finding-to-evidence navigation.

## Main journeys

### 1. First run, workspace setup, and recovery

User goal: make Patchdesk able to read the right GitHub work and local
workspaces.

Flow:

1. The user reaches the first-run/empty inbox state.
2. They open Settings, create or select a workspace profile, and configure its
   GitHub account/host, workspace roots, owner filters, rule paths, and watched
   repositories.
3. Patchdesk loads the dashboard and inbox for the selected profile. If GitHub
   authentication or loading fails, the recovery action routes back through
   Settings.

Evidence:

- `src/renderer/src/flows/settings-flow.tsx:54-65` defines the four Settings
  areas: General, Workspace, Review, and Data.
- `tests/renderer/profile-settings.test.tsx:24-118` covers creation, editable
  profile lists, validation, and save failure.
- `tests/renderer/dashboard.ui.test.tsx:195-214` covers the ordered first-run
  path and a real Settings action; `:336-365` covers missing GitHub
  authentication routing through Settings.
- `README.md:3-22` establishes the workbench and its Inbox, workbench,
  Settings, and confirmation surfaces.

### 2. Daily maintainer triage from the inbox

User goal: decide which open pull request needs attention next.

Flow:

1. The user refreshes the active profile's GitHub-backed watchlist.
2. They choose a queue, search/sort, or reopen a saved view.
3. They inspect the selected PR's priority, checks, review state, and
   recommended action.
4. They start a full review, review only updates, continue an in-progress
   review, open a saved review, or open its discussion/readiness state.

The queues are My inbox, Updated, Needs review, Waiting, Checks failing, Ready
to merge, and All open. Inbox preferences and saved views are profile-scoped.

Evidence:

- `src/renderer/src/components/maintainer-inbox.tsx:50-58` defines the queue
  set, and `:120-140` restores profile-scoped view preferences.
- `src/renderer/src/components/maintainer-inbox.tsx:386-392` maps each queue
  and recommended action to the next flow.
- `src/renderer/src/flows/inbox-flow.tsx:168-189` connects inbox actions to
  opening or resuming a workbench.
- `tests/renderer/maintainer-inbox.ui.test.tsx:82-217` covers refresh state,
  in-progress reviews, queue filtering, keyboard selection, and saved views.

### 3. Open a specific pull request, with profile guidance

User goal: review a PR that is not being selected from the current inbox.

Flow:

1. The user pastes an `owner/repository#number` reference or GitHub URL.
2. Patchdesk previews it before opening.
3. When another workspace profile is suggested, the user explicitly keeps the
   current profile or switches and opens the PR.
4. Patchdesk prepares and opens the resulting workbench.

Evidence:

- `src/renderer/src/flows/inbox-flow.tsx:119-147` performs preview and the
  explicit profile-switch choice.
- `src/renderer/src/flows/inbox-flow.tsx:98-116` opens the PR through
  `/v1/reviews/open`; `:150-159` reopens saved sessions.
- `tests/renderer/dashboard.ui.test.tsx:369-429` covers suggested-profile
  preview/switching and direct entry while keeping the current profile.

### 4. Prepare a stable review, then inspect or run it

User goal: safely understand a PR and, when wanted, start a review run.

Flow:

1. Patchdesk prepares a local review session for the PR and its current head.
2. The user reads normal PR context, changes, and checks without automatically
   invoking a model.
3. They choose an enabled model and a low/medium/high reasoning level, then
   explicitly start the review.
4. The UI shows owned progress, lets the user reconnect after interruption,
   and reloads the persisted workbench when the attempt finishes.
5. If GitHub reports a changed head, Patchdesk opens a new prepared session
   rather than continuing the old snapshot.

Evidence:

- `src/renderer/src/flows/inbox-flow.tsx:88-116` requests the prepared
  workbench through `/v1/reviews/open`.
- `src/services/review-execution-service.ts:24-44` defines supported reasoning
  levels and the execution boundary.
- `tests/renderer/prepared-review-flow.ui.test.tsx:59-130` proves normal PR
  context does not start a model review and that checks can refresh; `:190-274`
  covers start, interruption, head change, and reconnect.
- `tests/renderer/safe-run-panel.ui.test.tsx:26-91` covers completion,
  retry/reload, and disconnected progress.

### 5. Inspect findings and draft a GitHub review

User goal: examine evidence, author useful feedback, and publish it only by
choice.

Flow:

1. The completed workbench presents findings against the diff, PR context,
   checks, and discussion.
2. The user can create local inline comments from selected changed lines and
   organize them as a review batch.
3. They explicitly confirm submission; Patchdesk creates/submits the GitHub
   review rather than writing while the user is only reading.
4. If freshness changes, the workbench stays locally readable but removes
   GitHub write actions until it is current again.

The local review batch, explicit submission, and explicit merge controls are
also wired into the prepared snapshot. They are not gated on a completed model
run; the important gates are current GitHub freshness, available batch state,
and merge readiness. What the completed workbench adds is a review result and
its model findings.

Evidence:

- `tests/renderer/review-workbench.ui.test.tsx:52-464` covers findings,
  evidence navigation, incremental updates, PR context, walkthrough entry,
  and stale-head removal of GitHub write controls.
- `tests/renderer/review-diff-view.ui.test.tsx:18-94` covers local inline
  comment drafting from changed lines.
- `README.md:24-28` says reviews and comments require explicit confirmation.
- `src/renderer/src/flows/prepared-review-flow.tsx:398-476` wires batch
  actions, explicit submission, and merge into the prepared flow; `:686-700`
  enables inline local-comment authoring in its diff.

### Prepared snapshot versus completed model review

The two states share the main PR workbench rather than representing a
read-only-versus-write-enabled permission boundary. “Read-only” describes the
narrative walkthrough's generation contract: it reads the stored patch and
does not itself write to GitHub or restart a review run.

Available in both a prepared snapshot and a completed model review, subject to
current GitHub freshness and the available batch/readiness data:

- Read the Files diff, PR overview, existing threads, and checks.
- Refresh GitHub state.
- Draft/remove local inline comments, add thread replies, and resolve or reopen
  threads through the local review batch.
- Explicitly submit that batch to GitHub as a comment, approval, or request for
  changes.
- Open the merge confirmation flow when merge readiness is available.
- Generate and read a walkthrough; a walkthrough can also accept local inline
  comments when the local batch is writable.

Unique to the completed review:

- Model-generated review result, including findings and their evidence
  navigation in the diff.
- Review-result-specific scope/comparison information.
- Local walkthrough section and Support reviewed markers. The prepared flow
  displays the walkthrough, but its corresponding marker callbacks are no-ops.

Evidence:

- `src/renderer/src/flows/prepared-review-flow.tsx:398-510` wires prepared
  batch actions, explicit submission, merge, walkthrough comments, and
  no-op walkthrough markers.
- `src/renderer/src/flows/completed-review-flow.tsx:200-245` wires the same
  batch and merge actions after a run.
- `src/renderer/src/components/completed-review-workbench.tsx:536-574` keeps
  section/Support marker state and forwards those completed-workbench actions.

### 6. Read-only narrative walkthrough (optional branch)

User goal: learn the change as a guided story instead of navigating the raw
diff first.

Flow:

1. From a review workbench, the user chooses Generate walkthrough.
2. They explicitly choose model/reasoning and confirm generation.
3. Patchdesk reads the stored patch only; it does not write GitHub or restart a
   review run.
4. The user moves through chapters and supporting material, can open a local
   comment composer on a changed line, and returns to Files without losing its
   state.
5. Failure or staleness exposes Retry generation or a new Generate walkthrough
   action; the normal files review remains available.

Evidence:

- `tests/renderer/completed-review-flow.ui.test.tsx:145-180` proves generation
  is manual and read-only; `:236-276` covers retry and stale regeneration.
- `tests/renderer/narrative-walkthrough.ui.test.tsx:122-389` covers chapters,
  Files return, navigation, local comments, keyboard behaviour, and focus.

### 7. Refresh readiness and explicitly merge

User goal: land a reviewed PR only when the current GitHub state permits it.

Flow:

1. The user refreshes the remote PR state from either workbench state.
2. A changed head moves them to a new prepared session; stale/cached data
   blocks write actions.
3. When merge readiness is satisfied, the user selects a merge method,
   acknowledges warnings, and confirms the merge.
4. Patchdesk sends a SHA-pinned merge request and treats the result as a final
   GitHub write.

Evidence:

- `tests/renderer/completed-review-flow.ui.test.tsx:73-143` covers refresh
  opening a current prepared session after a changed head.
- `tests/renderer/merge-confirmation-dialog.ui.test.tsx:8-36` covers warning
  acknowledgement and one explicit merge action.
- `tests/adapters/github-adapter.test.ts:890-896` covers the SHA-pinned GitHub
  merge endpoint.
- `README.md:24-28` requires explicit confirmation for merges.

## Journey hierarchy

The essential product loop is:

`Profile setup/recovery -> Inbox or direct entry -> Prepared snapshot -> Review
workbench -> Explicit GitHub review -> Refresh readiness -> Explicit merge`

The walkthrough branches from the prepared/completed workbench and returns to
Files. Local-data cleanup, cache cleanup, profile switching, and recovery are
supporting journeys.

## Boundaries that shape every journey

- The renderer is sandboxed and cannot access Node.js directly.
- The local API is loopback-only and capability/origin protected.
- GitHub credentials are not persisted.
- GitHub reviews, comments, merges, and link opening are explicit user actions.

Evidence: `README.md:24-28`.

## Scope notes

- This map reflects the current source and test suite, including the existing
  uncommitted worktree. It does not claim that every listed surface has been
  exercised in a live Electron session today.
- The earlier `docs/research/2026-07-30-existing-review-flows-research.md`
  referenced in project memory is not present in this checkout, so this note
  replaces it with evidence available here.
