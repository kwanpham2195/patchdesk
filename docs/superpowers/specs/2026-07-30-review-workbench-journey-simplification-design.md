# Review workbench journey simplification

**Status:** Approved product design

Patchdesk will make the prepared snapshot the clear starting point for review work. Files and the diff remain the default surface. Analysis and walkthroughs remain optional readers of the same immutable snapshot. GitHub writes remain separate, explicit publish actions.

## Goals

- Remove the competing primary actions in the prepared and completed workbench headers.
- Use one consistent vocabulary for the review journey.
- Keep the read-only boundary clear without repeating it in every label and dialog.
- Make the next useful action obvious for prepared, running, failed, and completed review states.
- Keep walkthrough reading progress separate from the review batch and GitHub writes.

## Non-goals

- Changing the immutable prepared snapshot contract.
- Changing the snapshot-owned review batch or its provenance rules.
- Adding automatic analysis, automatic refresh, or unconfirmed GitHub writes.
- Migrating review storage or changing the local API contract.
- Rewriting the prepared and completed workbench controllers. Small shared renderer helpers are allowed when they prevent divergent labels or action behavior.

## Shared vocabulary

The workbench uses these terms consistently:

- **Snapshot** is the stored immutable PR diff that Patchdesk is currently reading.
- **Run analysis** starts optional model analysis for the snapshot. It can produce model-provenance review items.
- **Walkthrough** is an optional explanation of the snapshot for a human reader.
- **Publish** is the deliberate, confirmed step that writes a review batch or merges on GitHub.

`Run review`, `read-only review`, and `Show generate dialog` do not appear as primary user-facing actions in this journey.

## Prepared snapshot journey

Opening a prepared PR lands directly in Files. The file tree and diff are immediately usable. Patchdesk does not add a route, modal, or choice screen before the diff.

The header has four jobs:

- Show the PR identity and one compact trust label: `Snapshot · no GitHub writes`.
- Show a compact check status, such as `Checks · Failing`. Selecting it opens PR overview focused on checks.
- Offer walkthrough as a secondary action.
- Show exactly one primary analysis or recovery action.

`Refresh GitHub state` moves into PR overview. The overview contains refresh, PR description, checks, existing threads, local review-batch context, merge readiness, and publish entry points. The header no longer keeps separate persistent controls for refresh and PR overview.

When analysis is ready, the primary action is `Run analysis`. When a recovery state applies, its action takes the same position:

- `Reconnect` for an active same-process analysis with no attached view.
- `Restart interrupted analysis` when the previous analysis did not finish.
- `Retry failed analysis` for a retryable failure.
- `Prepare again` when the stored review data cannot prepare safely.

Patchdesk never shows a recovery action and `Run analysis` as competing primary actions. Recovery views always retain `Back to inbox`. They also show `View snapshot` when the stored diff is usable. The stored diff stays readable whenever its snapshot is usable.

## Walkthrough journey

Walkthrough is a secondary reader of the current stored patch. It never starts analysis, changes the review batch, or writes to GitHub.

The walkthrough action reflects its real state:

- `Generate walkthrough` when no current walkthrough exists.
- `Generating walkthrough…` while generation runs. Files remain available.
- `Open walkthrough` when a current walkthrough is ready.
- `Retry generation` after generation fails.
- `Regenerate walkthrough` when the current walkthrough is stale or the reviewer explicitly wants another one.

Only the action area shows this lifecycle action. Alerts explain the state and the safe next step, but do not repeat the same button.

The generation dialog starts with the enabled default model and reasoning from Review Settings. It resolves an unavailable saved choice to the runtime default or first enabled model. Per-run model and reasoning controls sit under `Advanced options`. Patchdesk keeps the existing enabled-model validation and never accepts a free-text model identifier.

The dialog uses a short explanation: Patchdesk reads the stored patch and does not write to GitHub. It does not repeat the same promise in the title, body, and confirm button.

Opening a walkthrough preserves the selected file and the focused diff location. `Back to files` restores that context. A stale walkthrough does not show chapters, support content, or annotations from the previous patch. It shows the stale explanation, `Regenerate walkthrough`, and `Back to files` until a current walkthrough is ready.

The walkthrough takeover is a reading surface. It does not show the local review batch, inline-draft composer, add-to-draft controls, review-item edits, or Publish actions. Chapter and support marks are local reading progress only. Their labels use reading language, such as `Mark support as read`. They do not use review-batch, GitHub-review, or publish language.

## Completed review journey

After analysis completes, the workbench remains Files-first. It groups available work by intent without adding a second workspace:

- **Understand** covers the diff, findings, and walkthrough.
- **Decide** covers local review items, edits, removals, and provenance.
- **Publish** contains the existing explicit submit and merge confirmations.

Findings continue to navigate to their source evidence. A ready walkthrough continues to open from the same snapshot. Local drafts remain visible and durable if a later analysis runs, in line with the snapshot-owned review batch decision.

No GitHub write appears in the ordinary workbench header. Publish actions remain inside their existing confirmation paths and continue to recheck the current GitHub head before writing.

Submit confirmation shows a concise summary of the exact saved batch before the user confirms: the count of new inline comments, replies, and thread-state actions. Merge confirmation names the actual blocking warning beside the acknowledgement checkbox, such as failing required checks or the number of unresolved high-severity findings. It does not use a generic `Merge warnings` label when a concrete warning is available.

## Renderer boundaries

The product change uses the existing renderer surfaces:

- `PreparedReviewFlow` owns the prepared and recovery action presentation.
- `CompletedReviewWorkbench` owns completed-state grouping and publish entry points.
- `NarrativeWalkthrough` owns reading navigation and local reading progress.
- `useWalkthroughController` remains the walkthrough lifecycle boundary.

Shared copy or a small shared action-presentation helper may serve both prepared and completed surfaces. It must not become a broad controller rewrite, storage migration, or service-layer redesign.

## Error handling

Each visible lifecycle state has one clear action. Error copy states what remains usable and what the user can do next.

- A failed walkthrough leaves Files and any existing analysis result usable.
- A failed or interrupted analysis leaves the snapshot readable and keeps walkthrough available when its stored patch is current.
- A stale GitHub head blocks publish only. It does not block reading, analysis, or walkthrough generation from the stored snapshot.
- An unavailable model disables walkthrough generation with an actionable explanation. It does not remove Files or analysis controls.
- A recovery screen never traps the maintainer. It always offers `Back to inbox` and offers `View snapshot` when that snapshot remains readable.

Patchdesk does not expose internal terms such as worktree, attempt ID, session, or runtime in these surfaces.

## Verification

Renderer and Design coverage must prove:

- A prepared snapshot opens directly in Files with one trust label, one primary analysis or recovery action, secondary walkthrough, and compact checks control.
- Check status opens PR overview focused on checks. Refresh is available in the overview, not as a persistent workbench-header action.
- Each recovery state replaces `Run analysis` rather than competing with it. Interrupted and failed analysis use distinct, self-explanatory action labels and retain a safe exit.
- Walkthrough uses Settings defaults, hides overrides until `Advanced options` opens, and reports an unavailable model safely.
- Opening and leaving a ready walkthrough preserves the selected file and focused evidence. Failed and stale walkthrough states expose only one lifecycle action and do not show stale patch explanations as current content.
- The walkthrough takeover has no review-batch editor, inline-comment composer, or add-to-draft action. Reading marks never create, remove, or publish review-batch items.
- Completed state exposes Understand, Decide, and Publish without moving GitHub writes outside existing confirmations. Submit and merge confirmation display concrete action and warning summaries before confirmation.
- Existing explicit confirmation, fresh-head checks, snapshot ownership, model-item replacement, and human-item preservation continue to pass.

Design and browser scenarios cover prepared, running, failed, walkthrough-ready, walkthrough-failed, and completed states. The final change runs the repository verification order for desktop and renderer work: `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run`, `pnpm build`, `pnpm exec playwright test`, `pnpm package:mac`, and `pnpm test:package-smoke`.

## Acceptance criteria

- A maintainer can understand the difference between Snapshot, Run analysis, Walkthrough, and Publish without reading repeated safety copy.
- A prepared snapshot opens to Files and never requires an intermediate choice screen.
- The header presents one primary next action and does not repeat refresh or PR overview controls.
- Walkthrough generation uses valid defaults with optional advanced overrides.
- Failed and stale walkthrough screens show a single recovery action and no stale content as if it described the current snapshot.
- Local reading progress cannot be mistaken for a review-batch or GitHub action. The walkthrough takeover cannot create or edit review items.
- Submit and merge confirmations state the exact actions or warnings that require confirmation.
- The change preserves every existing read-only and explicit-write safeguard.
