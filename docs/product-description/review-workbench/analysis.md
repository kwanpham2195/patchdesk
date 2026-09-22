# Analysis

## Summary

Analysis presents a model-backed review of the represented patch. It leads with a verdict card, then lists Findings grouped by severity, a summary of what changed, a Verification checklist, and supporting details. The maintainer reaches it from the Analysis tab or card in Insights. Reading is always separate from acting: a Finding reaches GitHub only after the maintainer explicitly adds its suggested comment to the pending review, and a Finding is dismissed only after an explicit reason and confirmation. A Finding may also carry exact replacement code for the lines it cites. Patchdesk shows that replacement before the maintainer acts and publishes it, under the same single explicit action, as a GitHub suggested change.

## The simple case

The maintainer generates or opens a retained Analysis. If none exists, a borderless empty state centers the Analysis icon, the heading "No analysis yet", a one-line explanation, and the Generate analysis action in the available reader space. With a retained Analysis, they read the verdict card, then the Findings that need attention, expand a Finding's complete containing hunk, and tick off the Verification steps as they check them. For an actionable Finding mapped to the represented diff, they choose Add to review. Patchdesk starts or extends the pending review with the original suggested comment, then labels the Finding pending review or published from the exact receipt-derived state. A Finding carrying a verified replacement reads Add suggestion to review instead, and what reaches GitHub is that Finding's comment followed by one suggestion block. The maintainer can instead choose Dismiss, provide a reason, and confirm.

## The task, event by event

```mermaid
stateDiagram-v2
    [*] --> reading : open retained Analysis
    [*] --> configuring : Generate analysis
    configuring --> running : Start run
    running --> reading : retain completed result
    reading --> adding : Add to review
    reading --> dismissing : Dismiss and enter reason
    adding --> represented : exact pending-review projection
    dismissing --> dismissed : confirmed dismissal
    adding --> recovery : outcome unknown
```

### Arrive

Analysis opens in the Insights slot for the represented Review session. Above the reader, the shared Insight header says Current or Outdated, how long ago the Analysis was retained, and the provider and model, with a Regenerate button.

The reader shows its cards in a fixed order.

- **Verdict card.** A verdict badge reads Ready to approve, Changes requested, or Comment recommended. Beside it, one badge counts the Findings that still need attention, or says "No findings need attention", and one badge gives the CI state as Passing, Failing, Pending, Skipped, or Unknown; Failing is drawn as destructive. A heading follows the verdict: "The change is ready for your final review.", "Resolve the blocking findings before approval.", or "Review the highlighted concern before you finish." The generated summary sits below the heading. When Patchdesk allows finishing with an Analysis summary, the card carries a Finish review button.
- **Findings card.** Its title is Needs attention, No findings need attention, or No findings, with a matching description, and its header carries Copy as markdown prompt.
- **What changed.** The generated change summary for this retained Review snapshot.
- **Verification.** One checkbox per generated verification step, under "N of M checked. Ticks are not saved and reset when you leave Analysis." The card is absent when Analysis generated no steps.
- **Supporting details.** A collapsed card that counts its details and groups, with Show details. The groups are Reviewer callouts, Open questions, and Assumptions. Duplicate supporting details are removed before grouping.

Findings are grouped by severity. P0 and P1 Findings are listed first and always shown. P2 and P3 Findings sit behind a collapsed Lower severity disclosure that counts them. When every Finding is in one group, all of them are listed with no disclosure. Each Finding shows its severity badge, title, explanation, file and line, and a state badge: actionable, pending review, published, locked, dismissed, or unavailable when Patchdesk has no action state for it. When the Analysis is current and the Finding maps to the represented diff, the file and line is a link that opens the Diff at that location.

When generation returns zero Findings, the Findings card says "Analysis generated no findings for this Review." and "There is nothing to add to review or dismiss." Generated Markdown keeps its original structure while the reader applies safe rendering.

A Finding that carries a verified replacement also shows a Suggested change panel under its file and line, above View evidence. The panel heads itself with the file and the new-side line range, then draws the replacement with the same diff view the evidence uses: the cited lines removed, the replacement added. It is read-only and resizable, mounts no editor, and offers no action of its own.

> Technical note: Patchdesk keeps a generated replacement only after checking it against the represented patch. The Finding has to be mapped on the new side, its whole cited range has to sit in one hunk of that patch, the code has to carry no Markdown fence, and it has to be at most 4096 bytes. A replacement that fails the check is dropped on its own and the Finding is kept.

Evidence detail stays collapsed until requested. View evidence reveals the complete containing hunk and highlights the mapped Finding range.

### Leave unchanged

Reading, expanding evidence, opening Lower severity, switching Findings, or leaving Insights records nothing on GitHub. Generated prose and suggestions are not commands. Copy as markdown prompt copies the Findings that are not dismissed, the change summary, and the verification steps as a Markdown prompt for a local coding agent, and records nothing on GitHub; it reads Copied for about 1.5 seconds and is disabled when every Finding is dismissed. A Finding that carries a replacement contributes it to that prompt as a fenced code block under "Suggested replacement for" its file and lines. Closing a Dismiss form before confirmation leaves the Finding actionable.

Ticking a Verification checkbox records nothing anywhere. The ticks belong to the reader on screen: switching to another Insight tab, leaving Insights, or reloading clears them.

> Technical note: the Verification ticks are held only in the mounted Analysis reader, with no save request.

### Begin an action

Generate analysis or Regenerate opens the shared Insight run dialog described in [Brief](brief.md#begin-an-action), seeded with the saved Analysis provider, model, and reasoning preference. Both are disabled unless the Review is open and an Insight provider is available.

Add to review appears only when the Analysis is current, the Finding has a location on the represented diff, the projected Analysis action state is actionable, and GitHub writes are not paused. Dismiss appears on open Findings of a current Analysis.

Add to review sends the Finding's original suggested comment together with its Analysis run ID, Finding ID, session ID, head SHA, patch hash, and diff anchor. On a Finding with a verified replacement the same control reads Add suggestion to review and sends less: the Analysis run and Finding identity and the revision the reader expects, with no comment text and no anchor. Dismiss opens a small form titled Dismiss finding; Confirm dismissal stays disabled until the reason is non-blank.

Finish review in the verdict card opens Finish review with an Analysis-built summary. It prefills only the modal-local review summary and leaves Comment selected; it does not silently submit or change pending comments.

A Finding card's Open in Analysis opens Insights on the Analysis reader, opens Lower severity when the target is a P2 or P3 Finding, and scrolls to and focuses that Finding's row.

### While the action runs

Each Finding owns its pending and error state. Add to review reads Adding… and Confirm dismissal reads Dismissing… while their requests run. Add or Dismiss is admitted once synchronously for that Finding, while another Finding can remain usable. Reverse settlement of concurrent Finding actions does not move an error or confirmation to the wrong Finding.

Add to review passes through the detect-before-write gate and pending-review coordinator. A malformed success or unknown outcome never marks the Finding confirmed. Dismissal applies only the exact returned Finding ID and status.

Add suggestion to review takes the same path, with the comment composed away from the reader. Patchdesk rereads the retained Analysis and the represented patch, rechecks the run, session, head SHA, and patch hash, takes the replaced lines and the anchor from the patch itself, and writes the Finding's suggested comment or explanation followed by one fenced `suggestion` block holding the exact replacement. A Finding whose range no longer resolves in the represented patch sends nothing.

A generation run follows the lifecycle described in [Brief](brief.md#while-the-action-runs), including the running panel and the Codex activity trace a Codex CLI account run shows in it.

### Settle

An exact pending-review projection updates the canonical workbench immediately without an advisory full Review load. A Finding becomes pending review only when the projection's unresolved Finding identity matches the run, Finding, session, head, patch, and pending-review node. It becomes published only from matching recent-write evidence. A suggestion is confirmed against the comment Patchdesk composed and returned, not against text the reader assembled, and its cited range is preserved whole whether the write started the pending review or appended to one. Once the review is submitted, GitHub renders that comment as a suggested change the pull request author can commit or add to a batch; Patchdesk neither applies it nor tracks what the author does with it.

A confirmed dismissal patches the retained Analysis locally and removes its Add action. A failed Finding action shows "The Finding action could not be saved. Try again." under that Finding, keeps it retryable, and preserves the dismissal reason. Unknown pending-review outcome locks mutation and delegates settlement to Check GitHub again or manual GitHub inspection; a locked Finding says Patchdesk cannot safely change it because its exact GitHub comment is not confirmed.

A Finding that no longer maps to the represented diff, or an Add while the pending review needs recovery, sends nothing and says the Finding no longer matches the current diff or pending review, with Check GitHub again or refresh as the next step. A malformed or stale response to Add or Dismiss is worded as unconfirmed: the row says GitHub could not confirm the Finding action and to check GitHub before repeating it. The row keeps that sentence until the maintainer starts another action on the same Finding.

## Variants

| Variant                                                | Before the action runs                                                                                                                                                                                                                                                                                                                                                                            | While the action runs                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace profile and GitHub account                   | Profile rules and provider configuration shape generation; the configured GitHub identity owns later review writes.                                                                                                                                                                                                                                                                               | A profile switch leaves the session. A result or receipt from the former session cannot confirm the new Review.                      |
| Pull request and Review state                          | Retained Analysis can be read for terminal or outdated Reviews. Generate analysis and Regenerate need an open Review; on a merged or closed Review, a muted line above the reader says so and describes the two disabled buttons. Add to review needs an open, Fresh, patch-backed Review and available pending-review state. An outdated Analysis shows no Add, Dismiss, evidence, or Diff link. | Revision or terminal change discovered before the write prevents it. Generated evidence stays bound to the old represented revision. |
| GitHub permissions and merge readiness                 | Analysis generation needs no GitHub write permission. Add to review needs comment authority; merge readiness is separate.                                                                                                                                                                                                                                                                         | A permission rejection leaves the Finding actionable and does not change merge readiness.                                            |
| Network, local tool, and Insight provider availability | Reading a retained Analysis needs no provider. Generation needs an available provider; Add to review needs GitHub.                                                                                                                                                                                                                                                                                | Provider failure leaves the retained Analysis. GitHub uncertainty pauses writes without relabeling the Finding as published.         |
| Input path: mouse, keyboard, or desktop menu           | Reader, evidence controls, checkboxes, dialogs, and buttons support mouse and keyboard.                                                                                                                                                                                                                                                                                                           | Both paths use row-local admission guards. Desktop menus do not add or dismiss Findings.                                             |

## Cancel and interrupt

| Event                                                                                                 | Before the action runs                                                                                                             | While the action runs                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cancel, Stop, or Escape                                                                               | Closing run or dismissal controls before confirmation records nothing.                                                             | Cancel affects only the Insight run. The Dismiss form cannot close while its request runs. A GitHub pending-review write has no Stop after submission. |
| Navigate to another Patchdesk screen, Review, Settings section, or workspace profile                  | Reading can leave without a guard. A dismissal draft and Verification ticks are renderer-local and are lost on leaving the reader. | A GitHub write reports write-pending and blocks navigation until settlement. A provider run remains bound to its session.                              |
| Start another action or request a refresh                                                             | Independent Findings can be inspected; only eligible actions appear.                                                               | Same-Finding duplicates are ignored. Reverse completion of different Findings preserves cumulative confirmed state.                                    |
| GitHub, the network, a local tool, or an Insight provider fails or times out                          | Retained output stays readable when generation is unavailable.                                                                     | Deterministic errors stay row-local and retryable. Unknown GitHub outcome locks pending-review mutation.                                               |
| Close Settings, reload the renderer, close the window, or quit Patchdesk                              | Settings changes defaults for the next run. Retained Analysis and confirmed dispositions are durable; Verification ticks are not.  | Run identity and unknown-write recovery survive renderer reload; dismissal text does not have documented restart persistence.                          |
| The pull request, represented revision, pending review, permission, or other target changes elsewhere | A mismatched revision or missing pending review removes Add eligibility.                                                           | Exact cumulative projections prevent a lower, stale receipt from erasing a newer confirmed Finding.                                                    |
| macOS focus, a file or folder picker, or another input path takes control                             | Focus can move among Findings and evidence without acting.                                                                         | Focus loss does not cancel a run or write. Focus return after a row error needs live verification.                                                     |

## Interactions with other systems

**Workspace profile and identity.** The profile supplies local rules, provider defaults, and GitHub identity. Generated content is not identity proof.

**Review revision and freshness.** Analysis provenance and every actionable Finding are tied to the represented session, head, and patch. Update detection can make the artifact read-only.

**Local persistence and recovery.** Retained Analysis and confirmed dismissal dispositions are saved. Pending-review receipts and unknown outcomes use the Review's durable recovery state. Verification ticks and the Lower severity disclosure are not saved.

**GitHub permissions and write authority.** Add to review is the explicit authority boundary. The suggested comment is never sent merely because it was generated or displayed. Add suggestion to review is that same boundary for a replacement: reading the preview publishes nothing. Patchdesk never edits the replacement, never changes the local worktree or the pull request branch, and never publishes a suggestion without the maintainer's click, as [ADR 0015](../../adr/0015-authorize-finding-review-commands-from-analysis.md) and [ADR 0048](../../adr/0048-publish-finding-suggestions-from-the-main-process.md) record.

**Network, local tools, and Insight providers.** Generation uses the selected provider and local Review context. Acting on a Finding is a separate GitHub operation. The verdict card's CI badge reflects the represented checks and needs no provider.

**Concurrent operations and locking.** Row-local guards, cumulative projection checks, and the Review coordinator prevent duplicate or out-of-order confirmation.

**Feedback, errors, and diagnostics.** Pending, pending review, published, dismissed, failed, and recovery-required are distinct. A Codex CLI account run's command trace and one reasoning line enter the renderer projection, bounded as [ADR 0043](../../adr/0043-project-a-bounded-codex-activity-trace.md) records; raw prompts, command output, raw provider events, and unbounded errors do not.

**Preferences, keyboard commands, and desktop integration.** Analysis remembers provider, model, and reasoning defaults. No desktop menu shortcut accepts a Finding.

**Supported input and accessibility limits.** Findings, evidence, checkboxes, fields, and dialogs support keyboard and mouse. Patchdesk does not claim screen-reader, touch, or pen support.

## Edge cases

- An empty Analysis uses the same centered structure as empty Brief and Walkthrough readers.
- A Finding outside the represented diff has no Add to review action and no Diff link.
- Lower severity appears only when the Analysis has both P0 or P1 and P2 or P3 Findings.
- Opening a P2 or P3 Finding from a Finding card opens Lower severity even when the maintainer had closed it.
- The needs-attention count uses the same handled rule as merge readiness, so the verdict card, the Overview card, and the readiness card agree.
- Verification ticks reset when the maintainer leaves the Analysis reader, and the card's own description says so before any tick is made.
- Two concurrent adds that settle in reverse order preserve both confirmed Findings.
- A stale lower receipt missing its target cannot overwrite a newer pending-review projection.
- Malformed success produces recovery-required state, not optimistic confirmation.
- An outcome-unknown failure can carry a valid recovery projection; Patchdesk uses it only if it exactly confirms the requested comment.
- Dismissal detail stays hidden until requested, and a failed dismissal preserves its reason.
- Supporting details are deduplicated and grouped without rewriting generated prose.
- A retained Analysis remains readable while GitHub writes are paused; Add to review and Finish review are hidden while Dismiss stays.
- Zero generated Findings show No findings; this is distinct from a result where every Finding has already been handled.
- A replacement Patchdesk cannot verify against the represented patch is dropped on its own. The Finding keeps its explanation, evidence, and ordinary Add to review action, and only the Suggested change panel and the suggestion label are absent.
- A Finding whose cited lines span two hunks of the represented patch has no single range GitHub accepts, so it carries no suggestion however exact its replacement is.
- Replacement code containing a Markdown fence is refused rather than escaped, because a fence line would close the published suggestion block early.

## Open questions and verification

- The 2026-09-14 live pass confirmed the empty state and the disabled Generate analysis on a merged Review. No retained Analysis existed in the live workspace, so the verdict card, severity grouping, Verification checklist, and Finding actions were checked from source only.
- [UX-10](../ux-friction.md#ux-10-verification-ticks-are-lost-without-warning) is fixed: the card now says the ticks are not saved and reset when the maintainer leaves Analysis. The new wording is not yet live-verified; no Review in the live workspace had a retained Analysis.
- Suspected defect, confirmed live and by an independent review: a disabled Generate analysis or Regenerate on a merged or closed Review shows no reason on screen. The open-only rule is intended. See [B-11](../bug-triage.md#b-11-generate-and-regenerate-are-disabled-on-a-merged-or-closed-review-with-no-reason).
- Confirm evidence expansion, highlighted range, row focus after Open in Analysis, and error placement.
- Confirm whether a non-empty dismissal reason is guarded when switching Insights readers or leaving the Review.
- Confirm progress and Cancel presentation for provider timeout versus explicit cancellation.
- Confirm the outdated Analysis wording against a retained Analysis on a moved revision.
- Confirmed on a disposable pull request (2026-09-23, #341): a single-line suggestion kept its range and GitHub offered Apply suggestion and Add suggestion to batch after the review was submitted. The multi-line range is still proved only by adapter tests ([ANALYSIS-03-B to ANALYSIS-03-D](../verification/insights-and-cross-cutting.md#review-workbenchanalysismd)).
- An empty replacement would read as a deletion suggestion. Patchdesk refuses one until GitHub's behavior for it is proved on a disposable pull request.

Baseline drafted from Patchdesk application source commit `3100615`; revised and verified against `737c515c`. The Finding suggestion behavior is revised against `c47a211f`: its Suggested change panel and Add suggestion to review label were seen in the running app on a fixture Analysis, and on 2026-09-23 a single-line suggestion was published from a real Analysis on disposable pull request #341, submitted, and rendered by GitHub with Apply suggestion. The verification rules and the multi-line range are read from source and tests and are not live-verified.
