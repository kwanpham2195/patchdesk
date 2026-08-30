# Goal: complete the Patchdesk product description

You are working in the Patchdesk repository. Read `README.md`, `glossary.md`, `foundations/task-lifecycle-and-interruption.md`, and `settings/workspace-profile-editor.md` first. The README defines the scope, document template, method, structure, and coverage table. The other documents are the core foundation and pilot once drafted; match their depth, tone, vocabulary, and structure.

Complete every document in the README structure, run the consistency pass, build the verification checklists, and consolidate suspected defects in `bug-triage.md`.

## Source of truth

Patchdesk is checked out at `/Users/kwanpham/Work/patchdesk`. Describe the default macOS desktop app from `src/renderer/src/app.tsx`, with no fixture route active. Application behavior is pinned to committed source `3100615`; uncommitted application-source changes are not evidence for this pass. Fixture routes, release packaging, unsupported platforms, assistive-technology behavior, and exact model-generated wording are out of scope.

For each document, read in this order:

1. The renderer flow, hook, and component that own the feature in `src/renderer/src/flows/`, `src/renderer/src/hooks/`, and `src/renderer/src/components/`.
2. The domain types and transitions in `src/domain/`, then the service and local route in `src/services/` and `src/main/routes/` where the action crosses the local API.
3. Matching tests in `tests/domain/`, `tests/services/`, `tests/renderer/`, and `tests/browser/`. Use `docs/test-cases.md` to find the canonical case and avoid duplicating evidence.
4. Product language in `CONTEXT.md`, visible copy in the renderer, and the relevant public overview in `README.md`.
5. Defaults and limits in domain constants, renderer preference modules, service options, and route parsers.

Use a command such as `git show 3100615:src/main/electron-main.ts` instead of the working-tree file when a source path has uncommitted changes. Do not describe those uncommitted changes.

Do not describe code. Describe what the maintainer sees and does. Technical detail belongs only in `> Technical note:` block quotes, and only when the mechanism changes what the maintainer would expect.

## Writing rules

- Follow the eight-section template in the README for every feature document. Foundations and cross-cutting documents may adapt sections that have no extended task, but must cover every relevant variant and interrupt.
- Use the five task phases exactly: arrive, leave unchanged, begin an action, while the action runs, and settle.
- Variants and cancel/interrupt behavior go in tables split into `Before the action runs` and `While the action runs`. Use the fixed rows and order from README.md. Fill every cell, including `No effect.`
- Walk cross-cutting concerns in the fixed README order. Include a concern even when it has no interaction.
- Use glossary terms. Add a full glossary definition before using a missing term; do not coin a synonym for an existing term.
- Use sentence case headings and direct, concrete language. Do not hedge or market.
- State surprising behavior plainly. If it looks wrong, put it in Open questions and verification rather than smoothing it over.
- Cross-reference the document that owns a behavior instead of repeating it. `foundations/task-lifecycle-and-interruption.md` owns task phases and interrupts. `foundations/review-session-and-revision.md` owns freshness and represented-revision rules. `foundations/persistence-and-recovery.md` owns durable state and recovery.
- Every feature document ends with `## Open questions and verification`, then bullets, then `Verified against Patchdesk application source commit \`3100615\`.`
- Use one Mermaid `stateDiagram-v2` per interaction. Include only the states the maintainer passes through.
- Follow `/Users/kwanpham/.agents/skills/references/writing-guide.md` and `/Users/kwanpham/.agents/skills/references/docs-guide.md`. Preserve the canonical product wording in `CONTEXT.md`.

## Things already established

- The product surface is the supported Apple Silicon macOS desktop app with no fixture route active.
- A task has five phases: arrive, leave unchanged, begin an action, while the action runs, and settle.
- Patchdesk has two primary destinations: the Pull requests screen and one Review workbench. Settings is an overlay above either destination.
- The Pull requests screen represents one Selected repository at a time. GitHub owns listing membership, order, count, and pagination.
- A Review continues across pull-request revisions. A Review session represents exactly one pinned revision.
- Review freshness is Fresh, Revision changed, Remote state unavailable, or Terminal remote state. GitHub writes require current Fresh evidence unless a document names a narrower precondition.
- A GitHub pending review is the one authoritative editable Review draft. Patchdesk does not keep a second editable local copy.
- Patchdesk never retries an uncertain GitHub write automatically. It locks related writes until explicit reconciliation.
- An Insight remains bound to the represented revision and never writes to GitHub merely because it completed.
- The supported direct input is keyboard and mouse. Screen-reader, touch, and pen behavior are outside the supported product surface.
- Closing Settings with a dirty workspace-profile draft requires Save, Discard, or Cancel. Switching Settings sections alone keeps the draft.
- A profile save trims scalar and list values, rejects blank list entries, and keeps edits typed after the save request began as a newer dirty draft.
- Task state belongs to the feature that owns the action. Patchdesk has no global cancel command or single global operation queue.
- The titlebar busy bar is reference-counted for tracked loading actions. It stays visible until every overlapping tracked action settles, while feature-local controls show the action-specific state.
- Navigation state is clear, dirty draft, or GitHub write pending. A dirty draft offers an explicit choice; a pending GitHub write blocks navigation until its final result arrives.
- The two destinations are Pull requests and one keyed Review workbench. Settings is an overlay, not a third destination.
- The last destination and each Review's workbench position survive relaunch in local storage. An open Settings section survives renderer reload only in session storage and clears on normal close.
- Destination changes move keyboard focus to the new screen's first `h1`. Settings normally returns focus to its opener.
- Closing the window or quitting uses the same clear, dirty-draft, and write-pending state as renderer navigation. Dirty state can be discarded after confirmation; write-pending state cannot close until settlement.
- The first-run Default profile is derived from the active `gh` account and home directory when those checks succeed. Patchdesk never fabricates an account and does not persist an invalid empty-account profile.
- The first-run Pull requests card runs independent GitHub-access and local-tool probes on mount and on explicit Re-check. It reports missing tools, authentication, and probe failure separately; it never logs in or installs anything.
- Appearance is a global Settings preference with System, Light, and Dark values. Diff themes are a separate global light/dark pair, apply to mounted diffs immediately, and persist independently; a failed save leaves the visible choice active and retryable.
- Settings Review preferences are profile-scoped defaults for the next Analysis run. The screen lists Pi models and reasoning values, reports Codex CLI account availability, and does not overwrite a stored Codex Analysis preference merely by opening.
- An empty watchlist is a successful empty inbox state that makes no repository GitHub read. The first repository enters scope only through the explicit Workspace watchlist action.
- A workspace profile owns GitHub host and account, workspace roots, owner filters, rule paths, watched repositories, and the active-profile choice. It contains no credential.
- Repository discovery is read-only. A repository enters the watchlist only through an explicit checkbox action, and editing other profile fields preserves the watchlist.
- Repository discovery scans only saved workspace roots for supported Git origins, excludes already-watched identities from suggestions, preserves their rows in Workspace, and groups unmatched watched entries outside the current roots. A new root reports that it must be saved before scanning.
- The Pull requests screen scopes one GitHub listing to the active profile's Selected repository. A saved repository is used only while it remains watched; otherwise the first watched repository is selected, and an empty watchlist makes no repository read.
- Pull requests state, rows per page, labels, and Awaiting review from you are query state. State is Open or Merged, page size is 10, 25, or 50, labels are bounded to five values of 50 characters, and any query change clears pagination. Opaque page tokens are bound to the full query and previous-page history is bounded.
- A reusable inbox cache covers only a complete, fresh, unfiltered Open first page. Authentication failures may show cached Open rows as Cached after refresh failure or Stale by age; Merged results do not use that cache, and the screen does not retry automatically.
- Pull request rows show GitHub identity, state, labels, author, branches, change statistics, checks, update time, and local Review or Brief indicators. Recommended actions distinguish new, saved or updated Review sessions and merged terminal reads; the current source can prioritize Open Review over the Ready to merge action even when readiness evidence exists.
- Opening a Review is row-local and deduplicated. It can load a saved Review or fall back to Pull request identity, then prepares or resumes one exact represented revision with remote context, checks, comments, diff, and local worktree or snapshot evidence before entering the Review workbench. Changed identity or revision prevents adoption.
- A Review identity is profile, GitHub host, owner, repository, and pull-request number. A Review session adds one exact head and base revision and never changes revisions in place.
- Revision changed requires complete current head, base, and canonical patch-hash evidence. Incomplete or ambiguous evidence is Remote state unavailable, never a guessed change.
- Explicit refresh reads a stable GitHub revision, saves a remote snapshot, reuses the current session for the same revision, or prepares a new immutable session for a new revision. A head change during refresh aborts adoption.
- A non-open pull request becomes terminal only from authoritative merged or closed evidence. Terminal Reviews remain readable and reject further Review or merge writes.
- Patchdesk uses `~/.config/patchdesk` for profiles and global settings, `~/.local/share/patchdesk` for durable Review data and logs, and `~/.cache/patchdesk` for re-creatable inbox, avatar, and represented-worktree state.
- Durable JSON and artifact writes use sibling temporary files, file sync, atomic rename, and best-effort directory sync. Credential-shaped values are rejected on read and write.
- Corrupt or invalid durable entries are quarantined rather than loaded. Preparation journals clean or recover partial sessions; startup marks orphaned active Insight runs as retryable failures.
- Clear cache keeps durable Review history. Clear local review data removes non-running sessions, keeps active work protected, and leaves diagnostics. Terminal or orphaned sessions are retained for 14 days; quarantine entries for 30 days before background sweep.
- Data & recovery requires an active profile and confirms Clear cache separately from Clear local review data. Cleanup is local-only; successful cleanup reloads workspace data, failures keep action context, and automatic retention sweeps run at startup and every 24 hours while the app runs.
- Settings Logs is an app-wide main-plus-renderer tail with level/process filters, pause, a two-second poll, a 1,000-entry display bound, and credential masking. Review activity is a separate profile-scoped Diagnostic feed showing at most 40 redacted recent events; it does not show prompts, tokens, provider output, paths, or raw secrets.
- A confirmed failure and an uncertain write outcome are different settled states. Confirmed failures can be retried when the feature permits; uncertain writes require reconciliation and are never retried automatically.
- Documentation work may change only `docs/product-description/`. Other working-tree changes belong to other sessions and must remain untouched.
- Conversation and metadata writes accept only their exact typed confirmation. Confirmed writes enter the recent-write journal; an unknown outcome restores a durable write pause while reads and Refresh remain available.
- Diff hydration is owned by a patch generation and selected path. Duplicate requests coalesce, late old-generation responses are dropped, and local checkout or highlighting failures preserve a readable represented patch where possible.
- Direct inline comments and pending-review comments are separate GitHub paths. Speculative cards never confirm a write; comment-only receipts remain without thread controls, and unknown outcomes delegate settlement to durable recovery.
- Brief, Analysis, and Walkthrough remain bound to one represented session. Retained results survive failed regeneration. Generated content cannot write GitHub without a separate explicit maintainer action.
- Analysis Finding actions are row-local and cumulative. Exact run, Finding, session, head, patch, and pending-review identities are required before a Finding becomes pending review or published.
- Finish review uses GitHub's authoritative pending review. Its summary and decision are modal-local, submission is admitted once, Discard requires separate confirmation, and malformed or unknown results require recovery.
- Merge authority is bound to exact head, base, patch, refresh revision, readiness, and acknowledged warnings. A typed receipt commits terminal state before refresh; every other uncertain outcome is non-retryable until read-side recovery.

## State ownership in the Review workbench

- `review-workbench/conversation-and-metadata.md` owns the Conversation screen and metadata-rail writes.
- `review-workbench/files-diff-and-navigation.md` owns file, hunk, commit, tree, scroll, and keyboard navigation state.
- `review-workbench/inline-conversations.md` owns mapped thread display, inline comments, replies, and Resolve or Unresolve commands.
- `review-workbench/brief.md`, `analysis.md`, and `walkthrough.md` own their retained results and revision-bound actions.
- `review-workbench/pending-review-and-finish.md` owns the authoritative pending review, shared Review body, outcome choice, and submit or discard flow.
- `review-workbench/merge.md` owns merge readiness, warning acknowledgement, method selection, write, and reconciliation.
- `foundations/navigation-and-overlays.md` owns leaving the workbench and Settings overlay behavior.
- `foundations/review-session-and-revision.md` owns refresh, freshness transitions, and session replacement. Other workbench documents link to it.

## Order of work

1. Write `settings/workspace-profile-editor.md` as the pilot. Review it until it sets the tone, table wording, Mermaid shape, and depth.
2. Write foundations in this order: `task-lifecycle-and-interruption.md`, `navigation-and-overlays.md`, `workspace-profile-and-identity.md`, `review-session-and-revision.md`, then `persistence-and-recovery.md`. Add load-bearing facts to this file after each foundation.
3. Read all Review-workbench flow state before writing the eight `review-workbench/` documents in the ownership order above.
4. Write `first-run/`, `pull-requests/`, `settings/`, and `cross-cutting/`. These can be delegated only after the pilot and foundations exist. Each delegated writer must read this file, README.md, glossary.md, the pilot, and the relevant foundation; it may edit only its assigned document and necessary glossary entries.
5. Run the consistency pass: same term everywhere, one owner per behavior, resolved relative links and anchors, fixed table rows and ordering, all footers present, and exact README structure and coverage.
6. Build the four verification checklists and `verification/README.md`. Leave every Result as `—` until a live pass runs.
7. Build `bug-triage.md` from suspected defects in the documents. Deduplicate by root cause and cite committed source lines.

Update the README coverage table to `drafted` as documents land. Never mark a document `verified` from source, tests, or automated checks alone.

## Working rules

- The user explicitly chose an integrated documentation directory instead of the product-description skill's separate repository. Do not initialize a nested repository.
- Commit only files under `docs/product-description/`, with explicit paths. Use commit messages such as `docs(product-description): add workspace profile editor` or `docs(product-description): revise verification protocol`. Do not add AI attribution.
- Do not modify application source, tests, existing documentation outside this directory, or unrelated working-tree changes.
- If source and tests do not determine a behavior, write what they do determine, record the rest under Open questions and verification, and move on.
- The pilot target is roughly 150 to 200 lines. Hard Review-workbench documents can be longer. Completeness matters more than length.
- If the planned structure is wrong, update README.md structure and coverage before creating, removing, splitting, or merging a document.
- Run `python3 /Users/kwanpham/.agents/skills/product-description/references/check-links.py /Users/kwanpham/Work/patchdesk/docs/product-description` during the consistency pass.
- Run live verification only with the required Patchdesk dev and log panes observable. Insight runs cost provider usage; use the configured low-cost Codex CLI account model and do not run them merely to test fixed UI structure.

The documentation set is complete when no coverage row says `not started`, the consistency pass passes, the checklists and triage exist, live results are reported without overclaiming, and all product-description changes are committed.
