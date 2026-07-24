---
created_at: 2026-07-24
repos:
  - patchdesk
status: draft
depends_on:
  - .agents/PLANS/2026-07-23-patchdesk-ux-recovery-completion.md
---

# Patchdesk my PR maintenance workspace

## Purpose / Big Picture

Add a separate **My PRs** workspace for the active Patchdesk profile: a read-only
control plane for pull requests authored by that profile across watched repositories.
It must make the next maintainer action obvious without turning Patchdesk into a
GitHub writer or starting an AI review automatically.

At the end of this plan, a maintainer can open My PRs, see the pull requests they
own ordered by action needed, inspect review threads, checks, merge state, PR
description, and changes, keep a local reply draft or follow-up, and return to the
same item later. Existing review sessions, review drafts, and explicit GitHub write
confirmations remain the only paths that can produce remote changes.

This is Phase 2 work. It depends on the recovery-completion plan's truthful refresh,
safe workbench, and PR-description overview contracts. It must not delay or quietly
reimplement those milestones.

## Progress

- [ ] Confirm the recovery plan's Inbox freshness, read-only session, and PR
      overview contracts are available on the target branch.
- [ ] Prove the available GitHub review-submission commit data before implementing
      "commits since review" language.
- [ ] Add the read-only author projection and detail API.
- [ ] Add profile-local drafts and follow-ups.
- [ ] Build the My PRs route, queues, inspector, and navigation hand-offs.
- [ ] Add tests and package-level UI validation.

## Non-goals and safety constraints

- No GitHub write is added: no posting replies, resolving threads, requesting
  reviewers, marking ready, merging, pushing, or changing labels.
- No model call, Flue workflow, worktree operation, session mutation, or attempt
  mutation may occur while the My PRs list or inspector refreshes.
- A local reply draft is never represented as posted or pending on GitHub. It is
  editable/selectable local text only.
- Do not expose raw provider output, shell access, credentials, capability lists,
  private local paths, or unvalidated GitHub fields to the renderer.
- Do not add OS notifications or background jobs. A due follow-up becomes visible
  when Patchdesk is open; it does not wake the app or send a notification.
- Keep the fixed desktop geometry: 48px title bar, 232px application rail (48px
  collapsed), 208px queue rail, and 336px inspector. Preserve the existing narrow
  sheet behavior and all independent rail-restoration preferences.
- Keep the global appearance choices and Pierre code boundary from the recovery
  plan. My PRs uses Base Nova surfaces and status text/icons; it does not modify
  Pierre colors, code font, or 13px/20px diff metrics.

## Existing context

The current dashboard already scans watched repositories through the main process
and marks matching rows as `authored` when `summary.author` equals the active
profile's GitHub account. `MaintainerInbox` has categories for `authored`,
`checks_failing`, `ready_to_merge`, and local-review state, but the navigation has no
author-focused route and the row actions are optimized for reviewing other people's
PRs.

The GitHub boundary already exposes bounded read operations for a pull request,
review threads/comments, checks, diff, revision comparison, and the authenticated
account. Keep that boundary in the main process. The renderer continues to call only
the typed local API.

The current shared workbench opens or resumes a read-only session. That is the only
destination for full PR overview/description, diff, check inspection, and explicit
review execution. My PRs must hand off to it instead of duplicating its model-run or
GitHub-draft behavior.

## Product decisions

### Author queues and truthful next actions

Derive My PRs only from the existing per-profile Inbox snapshot. Do not run a second
watchlist scan and do not call GitHub from the renderer. A row belongs to My PRs when
the safe pull-request summary author exactly matches the active profile account.

Assign one primary next-action state, in this priority order:

1. `Changes requested`: GitHub review state is `changes_requested`.
2. `Reply to review`: a known open review thread has a latest comment from someone
   other than the active account.
3. `Fix failing checks`: checks have a terminal failure.
4. `Resolve merge conflict`: mergeability is `conflicting`.
5. `Wait for checks`: checks are pending or queued.
6. `Finish draft`: the pull request is a GitHub draft.
7. `Ready to merge`: current data says approved, checks passing, mergeable, and no
   known author action remains.
8. `Waiting for reviewer`: requested reviewers are known and no earlier condition
   applies.
9. `No immediate action`: the data is complete but does not support a stronger
   state.
10. `Status unavailable`: required review/check data could not be read.

Never infer an approval, reviewer request, review-thread ownership, check result, or
merge readiness from missing/partial data. In those cases show explicit text such as
`GitHub: partial data` or `GitHub: unavailable` and offer the existing read-only
refresh/open actions.

### Review updates are evidence-gated

Do not claim "N commits since reviewer X approved" until GitHub supplies a
submission-associated commit OID for that review. First add a narrow, read-only
discovery spike against the existing GraphQL adapter and fixture data:

- Determine whether a pull-request review node yields `submittedAt`, reviewer login,
  state, and `commit.oid` within the authenticated API permissions.
- Preserve only a bounded safe projection: reviewer login, state, submitted time,
  and a validated 40-hex commit OID. Do not expose review body text through this
  projection.
- If the commit OID is present, compare it with the current head through the existing
  revision-comparison boundary and display a textual delta such as `3 commits after
  approval`.
- If it is absent, display `Review activity recorded on <date>; commit delta
  unavailable`. Do not estimate from comment times or current branch history.

The implementation milestone may add review-update badges only after this discovery
has a passing API fixture and an explicit decision log entry. Otherwise the feature is
deferred, not approximated.

### Local author workspace state

Persist only profile-local state under a versioned Patchdesk storage key:

- `AuthorPrDraft`: canonical PR key, optional thread ID, body limited to 8 KiB,
  base head SHA, created/updated timestamps.
- `AuthorFollowUp`: canonical PR key, short note limited to 500 characters, optional
  due timestamp, `active | done` state, created/updated timestamps.

Use a strict parser at storage boundaries, reject malformed/oversized records, cap
the number of entries per profile, and migrate unknown versions by ignoring only the
invalid entry rather than the full profile. When a PR head changes, preserve local
drafts but mark them `Drafted for an earlier head` until the maintainer explicitly
edits or removes them. This avoids silently losing useful work or presenting a stale
reply as current.

No clipboard, shell, system-notification, GitHub, or model capability is required for
these records. The editor uses the existing Base Nova `Field` and `Textarea`; text
remains selectable for normal platform copy behavior.

## User experience and navigation

### Application route

Add a primary `My PRs` destination beside Inbox, Drafts, History, and Settings. It
uses its own persisted selected queue and inspector selection, while sharing the
profile's application-rail collapse state. Command palette results include `My PRs`,
`My PRs: Needs action`, and `My PRs: Ready to merge` with keyboard-accessible labels.

The Inbox refresh scheduler remains the single source of watchlist data. It is active
when either Inbox or My PRs is the visible route, and a route transition does not
create a second request. The main-process coordinator remains per-profile
single-flight. My PRs never resets the Inbox selection, workbench view settings, or
rail state.

### Three-rail workspace

At desktop widths, render the familiar 208px / fluid / 336px workspace:

- Queue rail: `Needs action`, `Changes requested`, `Checks failing`, `Waiting for
  reviewer`, `Ready to merge`, `Drafts`, `Follow-ups due`, and `All my PRs`, each with
  a truthful count. Queues with unavailable data still appear with an explanatory
  empty state rather than claiming zero.
- Main list: a compact keyboard listbox with PR number/title/repository on the left,
  one textual next action and icon in the middle, and updated time on the right.
  Search matches title, number, repository, and author action. Sort choices are
  `Action needed`, `Recently updated`, and `Pull request number`. Long metadata
  truncates with a full-value title/accessible label; page-level horizontal overflow
  is prohibited.
- Inspector: PR title and current status first, then a compact action checklist,
  reviewer/check/merge summary, review-thread summary, local follow-ups, and local
  draft status. Its explicit actions are `Open full pull request`, `View diff`,
  `Inspect checks`, and `Open review threads`. Each stays read-only. The first three
  open/resume the existing workbench in `overview`, `diff`, or `checks`; they do not
  run the model.

The overview is the first full-PR surface. Reuse the recovery plan's safe GFM PR
description renderer there before presenting the diff. `View diff` remains a direct
shortcut for experienced users. Do not duplicate the description renderer inside the
author inspector.

### Review threads and response drafting

`Open review threads` expands a Base Nova `Collapsible` section in the inspector (or
a narrow `Sheet` below the desktop breakpoint). Each thread shows safe state text
(`Open`, `Resolved`, `Outdated`, or `Unknown`), author, most recent timestamp,
validated file/line mapping when available, and the most recent visible comment.
Thread content remains bounded and plain text; it is not rendered as arbitrary HTML.

For an open thread, `Draft response` opens a local dialog using `Dialog`, `Field`,
and `Textarea`. The dialog has `Save local draft` and `Discard local draft` only. It
states: `This is local. Patchdesk will not post it to GitHub.` Existing drafts show
the current head/stale-head indicator and can be reopened or discarded. There is no
`Post`, `Reply`, or hidden submission handler.

Follow-ups use a compact `Card`/`Item` list. A maintainer can create, edit, complete,
or delete a local reminder. Due and overdue labels use icon and text in addition to
color. All operations write only the profile-local author-workspace store.

### Design system guard

Use the installed Base Nova shadcn components before creating anything custom:

- Existing: `Sidebar`, `Button`, `ButtonGroup`, `Badge`, `Card`, `Item`, `Alert`,
  `Empty`, `Field`, `InputGroup`, `Select`, `ScrollArea`, `Separator`, `Sheet`,
  `Dialog`, `Tabs`, `Table`, `Tooltip`, `Spinner`, and `Textarea`.
- Add `Collapsible` only after running `pnpm dlx shadcn@latest add collapsible
  --dry-run`, reviewing the diff, and then applying the generated primitive.

No custom visual primitive, global token override, generic card skin, or component
size override is allowed when Base Nova already supplies the needed primitive. Custom
classes may handle layout, responsive behavior, truncation, selected-state wiring,
and semantic status only. Preserve the current global light/dark/system appearance
and use text/icon/border distinction for every state so it remains understandable in
grayscale and forced-colors modes.

## Interfaces and data contracts

Add renderer-safe, strict contracts rather than exposing adapter objects directly.

```ts
type AuthorActionKind =
  | "changes_requested"
  | "reply_to_review"
  | "checks_failing"
  | "merge_conflict"
  | "checks_pending"
  | "finish_draft"
  | "ready_to_merge"
  | "waiting_for_reviewer"
  | "no_immediate_action"
  | "status_unavailable"

interface AuthorPrRow {
  ref: PullRequestRef
  title: string
  repository: string
  headSha: string
  updatedAt: string
  action: AuthorActionKind
  actionLabel: string
  freshness: "current" | "partial" | "cached" | "unavailable"
  isDraft: boolean
  reviewState: PullRequestSummary["reviewState"]
  checkSummary: CheckSummary
  mergeability: PullRequestSummary["mergeability"]
  requestedReviewerCount: number | null
  openThreadCount: number | null
  hasLocalDraft: boolean
  dueFollowUpCount: number
}

interface AuthorPrDetail {
  row: AuthorPrRow
  threads: SafeReviewThread[] | null
  threadsState: "current" | "partial" | "unavailable"
  checks: SafeCheckGroup[] | null
  checkpoints: ReviewCheckpoint[] | null
}
```

The local API parser validates repository owner/name/number, current profile identity,
relative source locations, external URLs, bounded strings/arrays, timestamps, SHA
shape, and enum values. Detail requests are authorized only for a PR present in the
active profile's watched-repository snapshot, unless a separately validated direct
open contract already exists. The endpoint only calls GitHub reads and storage reads.

Add a route destination such as:

```ts
{ kind: "my-prs", selectedQueue?: AuthorQueueId, selectedRef?: PullRequestRef }
```

Keep `workbench` destinations unchanged except using their existing
`initialSection: "overview" | "diff" | "checks"` hand-off. Do not add an author
mode to persisted review sessions, attempts, Flue prompts, or GitHub-write APIs.

## Implementation milestones

### Milestone 0: establish the boundary and fixtures

1. Read the recovery-completion plan's implemented contracts and current `AGENTS.md`,
   `brain/index.md`, package scripts, and clean/dirt state before edits.
2. Record the exact current Inbox response shape, active profile identity shape, and
   watched-repository snapshot ownership in a short discovery note within this plan's
   `Surprises & Discoveries` section.
3. Add adapter fixtures for authored PRs representing every primary action, complete
   and partial data, open/resolved/outdated threads, and current/changed heads.
4. Run the review-submission commit discovery described above. Record the GraphQL
   fields proved available, or record that the optional delta feature is deferred.

Exit criterion: every UI state has fixture proof; no implementation guesses about
review submission commits or partial GitHub data remain.

### Milestone 1: read-only author projection and detail service

1. Add `AuthorPrRow` derivation in the service layer from the existing Inbox snapshot
   and active profile account. It must be a pure projection with deterministic action
   precedence.
2. Extend the safe Inbox response with the derived author queues and active-review
   progress already available from durable attempts. Do not issue another GitHub scan
   or mutate sessions/attempts.
3. Add a typed detail controller/service that validates the PR reference, verifies it
   belongs to the allowed snapshot, and reads current PR/thread/check information via
   existing main-process adapters.
4. Group repeated checks using the same safe check-grouping policy as the recovery
   plan. Preserve explicit `No requirement metadata`, status text, and a read-only
   validated HTTPS link only when one exists.
5. Add the optional review checkpoint projection only when Milestone 0 proved its
   source. Otherwise return a safe absent state and render the truthful unavailable
   message.

Exit criterion: author list/detail requests are read-only, bounded, single-flight
with the existing Inbox scan, and cannot start/restart/change a review attempt.

### Milestone 2: local author drafts and follow-ups

1. Create a versioned profile-local store with strict schema parsing, size/count caps,
   canonical PR keys, and explicit delete/update operations.
2. Derive stale-head status at read time by comparing the stored base SHA and safe
   current row SHA. Never silently alter draft text.
3. Add a narrow local API/store facade if the renderer does not already have a typed
   profile-preference persistence path. Keep file I/O in the main process/preload
   boundary; renderer receives typed values only.
4. Test malformed storage, size caps, profile isolation, PR-key isolation, stale-head
   marking, and every local mutation. Confirm no call reaches the GitHub adapter,
   review controller, Flue workflow, or shell runner.

Exit criterion: author notes survive restart safely, remain local, and accurately
identify drafts created for an earlier head.

### Milestone 3: My PRs route and keyboard-complete workspace

1. Add the `my-prs` route, sidebar/command-palette entries, route serialization, and
   route restoration. Reuse the current shared shell and rail controls.
2. Build the queue rail, compact main listbox, and inspector from Base Nova components
   as described above. Keep row activation consistent: single click selects; Enter
   opens the current primary read-only action; explicit buttons handle alternate
   actions.
3. Add the shared refresh scheduler route predicate so Inbox and My PRs share one
   active scheduler/coordinator. Preserve last usable data while refresh is running.
4. Implement inspector actions as existing workbench hand-offs: Overview first,
   direct Diff, direct Checks, and no implicit model run.
5. Implement review-thread collapsible/sheet, local draft dialog, and follow-up UI.
   Announce save/discard/complete actions politely and keep focus restoration correct.
6. Supply clear empty states for no authored PRs, no items in queue, loading, partial
   data, and unavailable data.

Exit criterion: a maintainer can reach every state by keyboard, recover all rails,
and open a full PR without an automatic review or any GitHub write.

### Milestone 4: result integration and polish

1. Reuse the recovery plan's safe PR-description overview renderer in the workbench;
   test that `Open full pull request` lands on Overview before the diff.
2. Reuse its completed-review result/finding/fix queue presentation rather than
   building a parallel author-side review-result UI.
3. Confirm active-review progress remains informational: a My PR row with a durable
   `Starting` or `Running` attempt says `Review starting`/`Review in progress` and
   primary action becomes `View review progress`.
4. Review all generic call-site classes and remove visual substitutions that duplicate
   Base Nova defaults. Retain only geometry/responsive/truncation/semantic-state
   classes.
5. Verify light, dark, system, grayscale, and forced-colors appearance. Pierre remains
   unchanged except its configured appearance/theme pair.

Exit criterion: My PRs feels like one coherent Patchdesk surface, not a second custom
design system or a duplicate workbench.

## Concrete test plan

### Unit and service tests

- Action precedence, author matching, and all partial/unavailable states.
- No duplicate GitHub scan when Inbox and My PRs enter concurrently; existing
  coordinator remains single-flight per profile.
- Author detail validates reference/snapshot membership and performs only GitHub
  reads/storage reads; it never calls session preparation, attempts, Flue, worktree,
  shell, or GitHub writer paths.
- Thread ownership derives from the latest comment author only when thread/comment
  data is current; unknown/partial data cannot produce `Reply to review` or `Ready to
  merge` falsely.
- Check grouping, merge/review state labels, URL validation, and review-checkpoint
  positive/missing-source paths.
- Local draft/follow-up schema parsing, bounds, profile isolation, canonical keys,
  stale-head state, and deletion.

### Renderer tests

- Sidebar and command palette navigation; persisted queue/row restoration; all rail
  collapse/restore controls remain operable.
- Listbox roles, selection, arrow/typeahead behavior, Enter activation, and explicit
  action buttons.
- Search/sort/filter behavior; full accessible labels for truncated content; no
  color-only status meaning.
- Thread collapsible and mobile sheet keyboard/focus flows; local draft dialog saves,
  discards, and never offers a posting action.
- Overview/Diff/Checks workbench hand-offs preserve intended initial section and do
  not trigger a review run.
- Refresh state is shared with Inbox; an active review remains visible but unchanged
  through refresh.

### Browser and packaged Electron validation

Use the packaged Electron app through `agent-browser` over CDP, with an authored-PR
fixture and the saved customer-management PR #118 for shared-workbench validation.

- At 1920x1080 and 1280x800: capture My PRs queues/list/inspector, long title and
  repository truncation, fixed rails, collapsed rails, and no page-level horizontal
  overflow.
- At narrow/mobile breakpoint: verify sheet behavior, 40px-plus touch controls, list
  navigation, local-draft dialog, and inspector restoration.
- Inspect console and page errors. Verify system/light/dark, grayscale, and
  forced-colors labels retain text/icon meaning.
- Select a PR, inspect threads/checks, save/discard a local draft, create/complete a
  local follow-up, open Overview then Diff then Checks, and verify no model run starts
  without the existing explicit two-step review dialog.
- Do not enter any GitHub write-confirmation flow. Verify network/local API traces do
  not include GitHub writes during all My PRs interactions.

Run the full gate before handoff:

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm exec playwright test
pnpm package:mac
pnpm test:package-smoke
```

## Idempotence and recovery

- Reopening My PRs reuses the latest cached Inbox snapshot and shared in-flight read;
  it is safe to repeat.
- Detail reads are idempotent and discard obsolete renderer responses by request
  generation. A stale response may not overwrite a newer selection.
- Local saves are explicit, validated, and scoped to one profile/PR/thread. A failed
  local write keeps editor text in memory with a visible error; it does not retry a
  remote operation.
- Missing review-submission commit evidence leaves the optional delta unavailable;
  it does not block core My PRs queues or invent a result.
- If a cached snapshot becomes partial/unavailable, retain last safe rows only with
  explicit freshness wording and never promote them to `Ready to merge`.

## Surprises & Discoveries

Record implementation-time facts here. Each entry must include evidence, date, and
the plan consequence.

- 2026-07-24: Initial inspection found an existing `authored` inbox category and
  main-process GitHub read boundary, but no author-focused route. Consequence: derive
  My PRs from the Inbox snapshot rather than adding a parallel GitHub scan.
- Pending: whether GitHub review submissions expose a reliable commit OID in the
  current adapter/API permissions. Consequence: review-update counts remain deferred
  until fixture-backed proof exists.

## Decision log

- 2026-07-24: My PRs is a separate Phase 2 draft plan, dependent on recovery
  completion, not a scope increase to the current recovery implementation.
- 2026-07-24: All My PRs remote data is read-only. Existing explicit confirmation
  contracts remain the only remote-write routes.
- 2026-07-24: Local response drafts and follow-ups are retained locally and never
  masquerade as GitHub actions.
- 2026-07-24: The workbench Overview is the one rich PR-description surface; My PRs
  hands off to it rather than duplicating markdown rendering.
- 2026-07-24: Review-update deltas require GitHub submission commit evidence and are
  deferred rather than inferred from timestamps.

## Expected changed areas

- `src/domain/maintainer-inbox.ts` and new bounded author-workspace domain types.
- `src/services/maintainer-inbox-service.ts` or a dedicated pure author projection
  service, plus tests.
- Main-process local API/controller routes and safe renderer contracts.
- Profile-local storage facade for drafts/follow-ups and tests.
- `src/renderer/src/routes.ts`, `app.tsx`, sidebar/command palette, and a new My PRs
  renderer surface using existing Base Nova components.
- Existing workbench hand-off tests and package/browser test fixtures.
- `src/renderer/src/components/ui/collapsible.tsx` only if the shadcn dry-run is
  reviewed and explicitly applied.

No commit, push, GitHub write, or release artifact is part of drafting this plan.
