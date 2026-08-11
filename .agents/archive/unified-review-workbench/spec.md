# Unified Review Workbench

Status: ready-for-agent
Date: 2026-08-01

## Problem Statement

Patchdesk presents one pull request through separate prepared and completed workbench flows. Those flows imply that a maintainer first enters a limited review and later arrives at a different, more capable review after model work finishes. The distinction is false: both flows already support reading the pull request, drafting feedback, publishing a GitHub review, refreshing GitHub state, generating a Walkthrough, and merging when safety rules permit. The completed flow mainly adds an Analysis result and mapped Findings.

This split makes the product harder to understand and the implementation harder to evolve. The visible workbench changes when optional model work completes, shared actions are wired twice, Walkthrough behavior differs between the two flows, and terms such as prepared, completed, model review, and read-only describe implementation state instead of the maintainer's task.

Patchdesk needs one Review that follows an open pull request through new commits, discussion, Analysis, drafting, publication, and merge. Optional ways to understand the change must enrich that Review without replacing its workspace or taking ownership away from the maintainer.

## Solution

Replace the prepared and completed workbench experiences with one persistent Review workbench. A Review begins when a maintainer opens an open pull request and ends when GitHub reports that the pull request was merged or closed. Each immutable pull request revision has a Review session underneath the same workbench.

The workbench has two primary surfaces: Files and Insights. Files is the source-of-truth code review surface. Its navigator switches between Files, current mapped Findings, and Commits. Insights is the extensible home for Analysis and Walkthrough. Analysis enriches Files with Findings and produces the complete Review body and inline-comment proposal that can be published to GitHub. Walkthrough remains a guided way to understand the current revision. Neither Insight creates another Review mode.

GitHub state is stable until the maintainer refreshes. Patchdesk may detect lightweight remote activity and show Updates available, but it does not replace the visible diff, discussion, or checks automatically. GitHub writes pause until refresh applies the newer state. Patchdesk-owned Analysis and Walkthrough work continues to report live progress.

A collapsible Review draft dock remains available across Files and Insights. It contains the editable Review body, inline comments, and thread actions. Published feedback remains visible as GitHub-owned content, while a new empty Review draft becomes available for later feedback.

The user interface removes prepared, completed, model-review, and read-only modes. The underlying safety boundaries remain: every Insight is bound to an immutable revision, remote changes block unsafe writes, draft anchors move only on an exact unique match, and GitHub publication remains explicitly authorized.

## User Stories

### Opening and continuing a Review

1. As a maintainer, I want opening a pull request to create or resume one Review, so that I do not need to understand prepared and completed workbench modes.
2. As a maintainer, I want the Review workbench to open on Files, so that the current pull request diff is always the starting point.
3. As a maintainer, I want to read the pull request without starting Analysis, so that model work remains optional.
4. As a maintainer, I want the same workbench to remain open when Analysis starts or finishes, so that I do not lose navigation or draft state.
5. As a maintainer, I want the same Review to continue when the author pushes commits, so that the pull request remains one task.
6. As a maintainer, I want each refreshed revision to remain safely pinned underneath the workbench, so that model output and GitHub writes cannot drift between commits.
7. As a maintainer, I want publishing feedback to be a milestone inside the Review, so that I can review later commits and replies without starting over.
8. As a maintainer, I want a merged or closed pull request to make the Review terminal, so that the final state is truthful.
9. As a maintainer, I want a terminal Review to remain inspectable, so that I can understand what was reviewed and published.
10. As a maintainer, I want unavailable terminal actions removed instead of seeing a read-only mode, so that the interface describes the pull request state directly.

### Refresh and remote activity

11. As a maintainer, I want to see when GitHub state was last refreshed, so that I know how current the workbench is.
12. As a maintainer, I want Patchdesk to show Updates available only after it detects newer GitHub metadata, so that the indicator is truthful.
13. As a maintainer, I want elapsed time alone to avoid creating an update warning, so that age is not confused with detected change.
14. As a maintainer, I want remote commits, discussion, checks, and review state to change only after I refresh, so that content does not move while I read or write.
15. As a maintainer, I want local Analysis and Walkthrough progress to update live, so that work started in Patchdesk does not appear frozen.
16. As a maintainer, I want all GitHub writes to pause when Updates available appears, so that I cannot publish against remote state I have not reviewed.
17. As a maintainer, I want local drafting to remain available while remote updates wait, so that I can keep working safely.
18. As a maintainer, I want refresh to update the existing workbench in place, so that a new commit does not create another destination.
19. As a maintainer, I want a failed refresh to leave the prior local snapshot readable, so that a GitHub failure does not destroy my work.
20. As a maintainer, I want Patchdesk to restore only the GitHub actions allowed by the refreshed state, so that refresh does not bypass checks or merge policy.

### Files, Findings, and Commits

21. As a maintainer, I want Files to show the full current pull request diff, so that I can review the complete change.
22. As a maintainer, I want the review navigator to switch between Files, Findings, and Commits, so that related navigation stays in one place.
23. As a maintainer, I want Findings to list only current Findings with safe diff mappings, so that every item can navigate to real current evidence.
24. As a maintainer, I want each Finding entry to show severity, title, file, line, and disposition, so that I can triage it quickly.
25. As a maintainer, I want selecting a Finding to open and highlight its exact evidence in Files, so that I can verify the concern.
26. As a maintainer, I want general Analysis concerns to remain in the Review body instead of appearing as Unmapped, so that implementation limitations do not become product vocabulary.
27. As a maintainer, I want outdated Findings excluded from the Findings navigator, so that old evidence is never presented against current code.
28. As a maintainer, I want Commits to show the ordered pull request commit list with author, SHA, time, and head marker, so that I can understand how the change evolved.
29. As a maintainer, I want opening Commits to select the newest commit, so that the first commit view is predictable.
30. As a maintainer, I want selecting a commit to show its commit-specific diff and header in the central surface, so that I can inspect one logical change.
31. As a maintainer, I want switching back to Files to restore the full pull request diff, so that no extra All changes scope is needed.
32. As a maintainer, I want inline drafting from a commit diff only where lines still map safely to the current pull request diff, so that GitHub anchors remain valid.
33. As a maintainer, I want commit selection to remain temporary in the first version, so that the workbench does not add premature persistence rules.

### Insights

34. As a maintainer, I want Insights to open to an overview of available Insight types, so that Analysis, Walkthrough, and future built-in aids have one stable home.
35. As a maintainer, I want each Insight to show Not generated, Running, Current, Outdated, or Failed, so that its state is clear without opening it.
36. As a maintainer, I want to start Analysis and Walkthrough independently, so that one does not block the other.
37. As a maintainer, I want at most one active run per Insight type, so that replacement behavior is predictable.
38. As a maintainer, I want Files and the Review draft to remain usable while Insights run, so that generation does not take over the Review.
39. As a maintainer, I want the latest successful Insight result to stay visible while a replacement runs, so that generation does not create a blank state.
40. As a maintainer, I want a successful replacement to replace the prior result of that type, so that Patchdesk keeps only the result that matters.
41. As a maintainer, I want a failed or cancelled replacement to preserve the last successful result, so that failure is non-destructive.
42. As a maintainer, I want an old-revision Insight to remain fully readable with an Outdated warning, so that the last result does not disappear unexpectedly.
43. As a maintainer, I want outdated Insight evidence navigation disabled, so that old locations cannot be confused with current code.
44. As a maintainer, I want Run for latest revision to be the primary action on outdated content, so that recovery is obvious.
45. As a maintainer, I want new remote activity to revoke auto-publication without cancelling active Insight work, so that safety changes immediately without silently wasting the run.
46. As a maintainer, I want a warning when an active Insight may be outdated by detected remote activity, so that I understand its limits.
47. As a maintainer, I want Walkthrough to navigate me back to current Files evidence, so that explanation and source remain connected.
48. As a maintainer, I want Walkthrough reading progress to remain local to its retained result, so that progress does not imply GitHub publication or Review completion.

### Analysis and Findings

49. As a maintainer, I want Analysis to produce a predictable Review body, so that GitHub publication is consistent across models.
50. As a maintainer, I want every Review body to include Review Scope, Pull Request Overview, Reviewed Changes, Findings, and Verdict, so that the essential review context is always present.
51. As a maintainer, I want Verification and Human Reviewer Callouts included only when they have useful content, so that the Review body avoids filler.
52. As a maintainer, I want Findings without a safe line target included naturally in the Review body, so that useful concerns are not lost.
53. As a maintainer, I want only current Mapped findings to become proposed inline comments, so that GitHub receives valid diff coordinates.
54. As a maintainer, I want Analysis to propose Comment, Approve, or Request changes, so that its Verdict can guide publication.
55. As a maintainer, I want to change the proposed GitHub decision before publishing, so that the maintainer remains responsible for the decision.
56. As a maintainer, I want adding a Finding to copy it into the Review draft, so that I can edit feedback without changing Analysis evidence.
57. As a maintainer, I want later Analysis runs to leave copied draft comments untouched, so that model work cannot rewrite my authored feedback.
58. As a maintainer, I want a Finding marked Added to review while its copied draft exists, so that I do not add it twice accidentally.
59. As a maintainer, I want removing the copied comment to make the Finding available again, so that I can reconsider it.
60. As a maintainer, I want to dismiss a Finding with a short reason, so that false positives and accepted risks are recorded explicitly.
61. As a maintainer, I want every replacement Analysis to create a fresh Finding set, so that heuristic matching cannot hide a new concern.
62. As a maintainer, I want old Finding dismissals not to carry into a replacement Analysis, so that each result is judged on its own evidence.

### Review draft and publication

63. As a maintainer, I want one Review draft shared by Files and Insights, so that all unpublished feedback stays together.
64. As a maintainer, I want the Review draft available from a collapsible bottom dock, so that it remains close without permanently reducing the diff.
65. As a maintainer, I want the collapsed dock to show item count, proposed decision, and attention state, so that I can understand the draft at a glance.
66. As a maintainer, I want Analysis to seed an empty Review draft automatically, so that its complete Review body and mapped inline comments are ready to inspect.
67. As a maintainer, I want Analysis never to overwrite a draft I already edited, so that my work remains authoritative.
68. As a maintainer, I want to merge Analysis into an existing draft, so that I can combine generated review context with my own feedback.
69. As a maintainer, I want merge to keep my text under Maintainer notes, append the Analysis body unchanged, preserve manual inline comments, and avoid duplicate Findings, so that the result is predictable.
70. As a maintainer, I want to preview a merged or replaced draft before applying it, so that no local content changes invisibly.
71. As a maintainer, I want refresh to preserve general draft content across revisions, so that a new commit does not erase my work.
72. As a maintainer, I want inline drafts to move only on an exact unique code-context match, so that Patchdesk never guesses a new location.
73. As a maintainer, I want unmappable inline drafts preserved under Needs attention with their original context, so that I can reattach, convert, or remove them.
74. As a maintainer, I want publication blocked while an inline draft needs attention, so that invalid coordinates do not reach GitHub.
75. As a maintainer, I want to choose the Analysis completion action for each run, so that I control whether the result stays local, opens a preview, or publishes.
76. As a maintainer, I want Open preview when complete to be the default, so that unseen model output is not posted accidentally.
77. As a maintainer, I want Publish as Comment, Approve, or Request changes to authorize only the current Analysis run and revision, so that automation remains bounded.
78. As a maintainer, I want auto-publication cancelled when the revision, remote state, draft safety, or Analysis outcome changes, so that prior authorization cannot drift.
79. As a maintainer, I want the publication preview to show the exact Review body, inline comments, thread actions, and GitHub decision, so that I know what will be written.
80. As a maintainer, I want successful publication to move submitted content into Published feedback and create a new empty Review draft, so that sent and unsent feedback cannot be confused.
81. As a maintainer, I want Published feedback to remain visible in the workbench, so that I can follow the GitHub conversation.
82. As a maintainer, I want to edit or delete an individual Published feedback comment when GitHub permits it, so that Patchdesk reflects the remote capability.
83. As a maintainer, I want submitted review decisions treated as GitHub review records rather than deletable draft text, so that dismissal and deletion are not confused.
84. As a maintainer, I want uncertain or partially failed GitHub publication to preserve local evidence and prevent duplicate retries, so that recovery is safe.

### Merge policy and readiness

85. As a maintainer, I want each workspace profile to choose Advisory, Require acknowledgement, or Block for current high-severity Findings, so that teams can choose their Analysis policy.
86. As a maintainer, I want Require acknowledgement to be the default, so that current P0 and P1 Findings are visible without giving the model absolute authority.
87. As a maintainer, I want Advisory to leave merge availability unchanged, so that Analysis can remain informational.
88. As a maintainer, I want Block to prevent merge while current P0 or P1 Findings remain open, so that stricter teams can enforce their chosen policy.
89. As a maintainer, I want adding a Finding to the Review draft not to clear its merge effect, so that writing feedback is not mistaken for addressing the concern.
90. As a maintainer, I want dismissing a Finding to clear its Analysis-policy effect, so that a recorded human judgment can unblock the Review.
91. As a maintainer, I want outdated Analysis excluded from merge policy, so that old model output cannot govern current code.
92. As a maintainer, I want GitHub rules, stale or unrefreshed state, failed required checks, and unresolved write safety to remain non-configurable blockers, so that profile preferences cannot weaken remote safety.
93. As a maintainer, I want merge to remain an explicitly confirmed SHA-bound GitHub action, so that the final write is deliberate and revision-safe.

### Accessibility and recovery

94. As a keyboard user, I want Files, Findings, Commits, Insights, and the Review draft reachable and operable without a pointer, so that the full Review is accessible.
95. As a keyboard user, I want focus preserved when Analysis completes or remote metadata changes, so that background state does not interrupt me.
96. As a keyboard user, I want focus restored to the invoking control after closing an Insight or publication preview, so that navigation remains predictable.
97. As a maintainer, I want status communicated with text and not color alone, so that freshness, Insight, Finding, and merge states remain understandable.
98. As a screen-reader user, I want Analysis and Walkthrough progress announced without replacing the active surface, so that live work is perceivable but not disruptive.
99. As a maintainer, I want safe retry actions for failed refresh, Analysis, Walkthrough, and publication recovery, so that failures have a clear next step.
100.  As a maintainer, I want provider diagnostics, local paths, prompts, and stack traces excluded from renderer copy, so that recovery remains safe and understandable.

## Implementation Decisions

### Domain and lifecycle

- Use the canonical language in the project glossary: Review, Review session, Review workbench, Insight, Analysis run, Analysis result, Finding, Mapped finding, Dismissed finding, GitHub review, Review draft, Review body, Published feedback, and Walkthrough.
- A Review is active while its GitHub pull request is open and becomes terminal when GitHub reports merged or closed.
- A Review session remains immutable and bound to one profile, pull request, head revision, and patch. Refresh may create a newer Review session without creating another Review or workbench destination.
- Replace the prepared-versus-completed workbench projection with one projection containing common Review data and independent optional state for Analysis, Walkthrough, Review draft, Published feedback, remote GitHub context, and merge readiness.
- Do not expose prepared, completed, model-review, manual-review, or read-only modes in renderer contracts, accessibility labels, routes, or copy.
- Preserve the sandbox, loopback capability, profile ownership, snapshot identity, bounded diagnostics, and explicit GitHub-write boundaries.

### Workbench composition

- Files is the default primary surface. Insights is the second primary surface.
- The review navigator within Files has Files, Findings, and Commits.
- Files shows the full current pull request diff. Commits shows an ordered commit list and filters the central diff to the selected commit. Opening Commits selects the newest commit and does not restore prior commit selection in the first version.
- Findings lists only current Mapped findings. It has no first-version grouping, search, or advanced filters.
- Selecting a Finding navigates to its current diff evidence without changing the Review draft or primary workbench identity.
- The header keeps current GitHub identity, head, freshness, and checks visible. `PR overview` opens an on-demand right-side overlay containing the complete pull request description, discussion and review status, merge readiness, warnings, and merge action.
- The PR Overview overlay does not resize or replace the workbench. It dims the background, traps focus while open, scrolls independently, closes through its close control, Escape, or backdrop click, and restores focus to its trigger.
- The Review draft owns a persistent collapsible bottom dock shared by Files and Insights.
- Workbench surface, navigator, diff, draft, and focus state must not reset when Insight status changes.

### Refresh and freshness

- Store the GitHub state represented by the workbench and the time it was last refreshed.
- Use a lightweight background metadata check to detect a changed head or newer pull request activity. This check may set Updates available but must not replace visible remote data.
- Do not claim detection of every remote change in the first version. Last refreshed remains visible even without a positive update signal.
- Pause review publication, published-comment mutation, thread mutation, and merge whenever Updates available is set or remote freshness is unavailable.
- Keep reading, Insight access, and local Review draft editing available while writes are paused.
- Explicit refresh fetches the authoritative current pull request state and applies it atomically to the same workbench.
- A head change creates a new immutable Review session. Discussion-only, check-only, or review-state changes refresh the current workbench's remote context without changing the pinned patch.
- Refresh failures preserve the prior local state and provide bounded recovery copy.

### Draft carry-forward

- Preserve the Review body and non-line-specific draft actions across revision refresh.
- Retain an exact code-context fingerprint for every inline draft when it is created.
- Carry an inline draft to a newer revision only when the selected code and bounded surrounding context have exactly one match on the same path and diff side.
- Put missing, ambiguous, or otherwise unsafe inline anchors under Needs attention with their original context.
- Needs attention supports reattach, convert to Review body text, and remove. Publication remains unavailable until every affected item is handled.
- Never delete or silently omit an unpublished draft during refresh or migration.

### Insights

- Define a small typed contract for built-in Insight identity, immutable revision binding, retained result, active run, status, failure copy, replacement action, and optional navigation back to current Files evidence.
- Implement only Analysis and Walkthrough. Adding another built-in Insight must not require another workbench mode or primary top-level destination.
- Allow one active run per Insight type. Different Insight types may run concurrently.
- Keep the last successful result while a replacement runs. Atomically replace it only after a successful, current, validated completion.
- Keep a failed or cancelled replacement separate from the retained result.
- Keep outdated retained content fully readable with its original revision shown. Disable old evidence navigation, current Findings projection, Review draft generation, and merge-policy influence.
- Do not retain a user-facing history beyond the latest successful result for each Insight type.
- New remote activity does not cancel active Insight work. It warns the user and revokes any completion action that would publish to GitHub.
- Walkthrough generation remains finite, tool-free, bounded to stored artifacts, cancellable, and independent of Analysis persistence.
- Walkthrough does not create inline Review draft items. It may navigate the maintainer to current Files evidence.

### Model instructions and authority

- Patchdesk owns every model workflow. The app prepares immutable context and patch artifacts, selects the requested model and reasoning level, starts one finite run, validates the result, binds it to the Review session, and decides whether the result may replace retained content or enter the Review draft.
- Compose Analysis instructions in a fixed hierarchy: trusted Patchdesk policy first, repository-selected criteria second as untrusted evidence, and prepared pull request data last as untrusted evidence.
- Treat patch text, pull request text, comments, checks, inspector output, `AGENTS.md`, `CONTRIBUTING.md`, and configured review rules as evidence. They cannot grant tools, change the result schema, weaken safety policy, or override the instruction hierarchy.
- Analysis receives only the session-bound inspection surface for the prepared revision: changed-file listing, literal search across changed files, bounded line reads, and immutable Git reads. It receives no arbitrary shell, checkout mutation, credential, GitHub-write, publication, thread, or merge capability.
- Walkthrough receives bounded stored context and patch artifacts with no tools or write surface. It returns only an ordered explanation linked by exact request-local hunk aliases.
- Require strict size-bounded result schemas and semantic consistency checks. Invalid, oversized, malformed, stale, or mismatched output fails the replacement run without changing the retained result.
- Patchdesk computes final Finding mapping, postability, draft creation, freshness, publication authorization, and merge eligibility. The model cannot perform or authorize those actions.
- Incremental Analysis uses an exact base and head comparison, the incremental patch, and tokenized prior-Finding evidence. A prior Finding may be `still_present`, `resolved`, or `unverified`; resolution requires comparison evidence.
- Keep prompts, hidden reasoning, provider events, credentials, raw command output, local paths, and stack traces out of model results, renderer recovery copy, and GitHub content.
- Exact prompt wording, default model, default reasoning level, and tuning strategy may change without changing this authority boundary.

### Analysis result and Review body

- Require structured Analysis output rather than accepting an arbitrary Markdown document as the product contract.
- Render the Review body in this order: Review Scope, Pull Request Overview, Reviewed Changes, optional Verification, Findings, Verdict, and optional Human Reviewer Callouts.
- Omit Verification and Human Reviewer Callouts when they have no useful content.
- Keep general or non-postable concerns in the Review body without an Unmapped label.
- Compute Finding diff mapping inside Patchdesk from the immutable patch. Model output cannot declare a Finding postable.
- Treat a Finding as Mapped only when its file, side, and bounded line range exist in the current pull request diff and can be converted to GitHub review coordinates.
- The Analysis Verdict proposes Comment, Approve, or Request changes and preselects the publication event. The maintainer may change it.

### Finding lifecycle

- A Finding is open, added to the Review draft, or dismissed. Added remains actionable; it only records that an editable copy exists in the draft.
- Adding a Mapped finding creates an independent Review draft item with model provenance, current code anchor, exact context fingerprint, suggested body, and a link back to the Finding.
- Editing or deleting the draft copy never mutates the Analysis result.
- Dismissal requires a bounded human reason and removes the Finding from Analysis merge-policy evaluation.
- A successful replacement Analysis creates a fresh Finding set. Do not carry dismissals between runs or attempt semantic matching from model IDs, titles, or prose.
- Removing a draft copy makes its Finding available to add again.

### Review draft and Analysis seeding

- The Review draft consists of one Review body, inline comments, thread replies, thread-state actions, provenance, inclusion state, postability, and remote-write receipts.
- When Analysis completes and the Review draft is empty, seed the Review body and all safely mapped proposed inline comments.
- When the Review draft contains maintainer edits, do not mutate it until the maintainer chooses merge or replace and accepts a preview.
- Merge preserves current body text under Maintainer notes, appends the generated Analysis body unchanged, preserves manual inline comments and thread actions, and adds only mapped Finding comments not already represented in the draft.
- Do not implement paragraph-level Markdown merging.
- Replacement must show the exact content that will be removed and require explicit confirmation. Manual content cannot disappear merely because a model run completed.

### Analysis completion actions

- Every Analysis run chooses Save as Review draft, Open preview when complete, Publish as Comment, Publish as Approve, or Publish as Request changes.
- Open preview when complete is the default for every profile until the user chooses another action for the current run.
- A publication choice is explicit authorization for that run only. Bind it to profile, Review, Review session, head revision, patch hash, chosen event, and attempt.
- Cancel publication authorization when remote updates are detected, the workbench refreshes to another revision, a non-empty draft would be overwritten, the Analysis fails or is cancelled, validation fails, or the authorization no longer matches the current attempt.
- A cancelled publication action leaves the validated result available and routes it to a safe local draft or preview state.

### GitHub publication and Published feedback

- The publication preview shows the exact Review body, included inline comments, included thread actions, chosen GitHub event, current head, and any warnings.
- Preserve the two-stage pending-review and submit workflow, durable ordered receipts, idempotency keys, and reconciliation for unknown outcomes.
- Do not clear Review draft content until GitHub confirms the complete intended publication outcome.
- After confirmed publication, project the submitted Review body and comments as Published feedback and create a new empty Review draft.
- Load Published feedback from refreshed GitHub state rather than treating a submitted local draft as authoritative remote content.
- Allow an author to edit an individual Published feedback comment through an explicit save action when GitHub permits it.
- Require destructive confirmation before deleting an individual Published feedback comment when GitHub permits it.
- Treat a submitted GitHub review decision as a review record. Dismissal follows GitHub permission and dismissal semantics; it is not the same as deleting comments.
- Unknown or partial write outcomes freeze conflicting retries, retain receipts and local intent, and expose the existing safe recovery model without raw provider errors.

### Analysis merge policy

- Add a profile-scoped Analysis policy with Advisory, Require acknowledgement, and Block. Require acknowledgement is the default.
- Advisory never changes merge availability.
- Require acknowledgement adds an explicit warning acknowledgement when the current Analysis has open P0 or P1 Findings.
- Block prevents merge while the current Analysis has open P0 or P1 Findings.
- Added-to-draft P0 or P1 Findings remain open. Dismissed Findings do not affect the policy.
- Missing or outdated Analysis does not affect the Analysis policy.
- GitHub branch policy, current-head equality, required checks, mergeability, unresolved remote-write safety, and explicit merge confirmation remain non-configurable.

### Persistence and transition

- Introduce a one-time storage migration that preserves unpublished Review draft content, remote-write receipts, retained Analysis, retained Walkthrough, immutable revision identity, and terminal merge evidence.
- Project migrated sessions through the unified Review workbench. Do not retain prepared or completed renderer branches after migration.
- Preserve old data that cannot be migrated safely and expose a bounded recovery state. Do not delete it during migration or cleanup.
- Cleanup remains profile-owned, path-checked, serialized, idempotent, and limited to non-running sessions.

### Accessibility and responsive behavior

- Use semantic tabs for Files and Insights and for Files, Findings, and Commits navigation.
- Preserve focus when background metadata, Analysis progress, Walkthrough progress, or retained results change.
- Restore focus to the invoking control after closing previews, dialogs, or Insight detail.
- Announce meaningful progress and completion through bounded live regions without replacing the active surface.
- Communicate freshness, Insight status, Finding state, draft attention, and merge readiness with text and icons rather than color alone.
- Keep the navigator, central content, PR Overview trigger, overlay content, and Review draft reachable at 1280px and 1440px desktop widths without horizontal viewport overflow.
- Collapsing the navigator or Review draft dock and closing the PR Overview overlay must not discard their state.

## Testing Decisions

- Test external behavior and durable state transitions. Avoid assertions on component names, private helper calls, or duplicated implementation branches.
- Use the protected browser and loopback API as the primary acceptance seam. One complete seeded journey must open the unified workbench, navigate Files, Findings, Commits, and Insights, complete Analysis, seed and edit the Review draft, detect remote updates, refresh to a new revision, handle draft anchors, publish one confirmed GitHub review, and display the terminal pull request state.
- Extend the existing production-renderer browser workbench seam for visual and interaction behavior at 1280px and 1440px. Cover the persistent shell, bottom dock, PR Overview overlay, navigator switching, commit-specific diff, Insight overview, outdated warnings, focus restoration, keyboard operation, and overflow.
- Use focused domain and service tests only where the browser seam cannot safely or deterministically create the condition.
- Review projection tests must prove that one projection represents sessions with no Analysis, running Analysis, current Analysis, outdated Analysis, retained Walkthrough, failed replacement runs, Published feedback, and terminal pull requests without prepared/completed branching.
- Refresh tests must prove that the lightweight detector changes only the indicator, explicit refresh applies remote data, changed heads create a new pinned session, GitHub writes pause, and refresh failure preserves local readability.
- Draft carry-forward tests must prove exact unique remapping, ambiguous and missing matches entering Needs attention, general body preservation, conversion to general feedback, and publication blocking while attention remains.
- Analysis tests must prove structured Review body validation, Patchdesk-owned mapping, general Finding inclusion in the body, mapped Finding draft generation, editable copied comments, replacement isolation, and no dismissal carry-forward.
- Insight lifecycle tests must prove one active run per type, concurrent different types, last-success retention, transactional replacement, late-result suppression, outdated projection, retry, and auto-publication revocation after remote activity.
- Model-boundary tests must prove trusted instruction ordering, untrusted repository evidence isolation, exact prepared revision binding, the four Analysis inspection tools, the absence of Walkthrough tools and writes, strict schema rejection, bounded artifacts, and Patchdesk-owned Finding mapping and publication authority.
- Publication tests must prove each completion action, immutable authorization binding, exact preview payload, cancellation conditions, confirmed two-stage publication, partial and unknown outcome recovery, receipt-based idempotency, and draft clearing only after confirmed success.
- Published feedback tests must prove refreshed remote ownership, permitted edit, confirmed delete, review dismissal distinction, and disabled actions when GitHub permissions or freshness do not allow them.
- Merge tests must cover Advisory, Require acknowledgement, and Block; open, added, and dismissed P0/P1 Findings; missing and outdated Analysis; and non-configurable GitHub and write-safety blockers.
- Accessibility tests must cover tab roles and names, keyboard navigation, focus preservation and restoration, live status announcements, text alternatives to color, and reachable controls in constrained desktop layouts.
- Preserve existing performance assertions for large diffs and streaming. The unified shell must not weaken or skip them to accommodate local slowness.
- Run verification in this order for desktop renderer work: lint, typecheck, unit and integration tests, build, then browser tests. Use live Electron verification only after the automated surfaces pass.

## Out of Scope

- Third-party Insight plugins, dynamic Insight loading, custom Insight schemas, or an Insight marketplace.
- Insight types other than Analysis and Walkthrough.
- A user-facing history of prior Analysis or Walkthrough generations.
- A previous-revision code viewer.
- Automatic application of remote commits, discussion, checks, or review state.
- A persistent profile-level auto-publication setting. Publication automation is authorized per Analysis run.
- Semantic Finding matching or dismissal carry-forward between Analysis runs.
- Commit-scoped Analysis.
- Persisting the selected commit between visits to Commits.
- Findings grouping, search, advanced filtering, or an Unmapped Findings category.
- Direct inline-comment creation from Walkthrough or future non-Analysis Insights.
- Paragraph-level intelligent merging of maintainer and generated Review bodies.
- Weakening explicit merge confirmation, GitHub freshness checks, renderer sandboxing, loopback capability checks, or credential handling.

## Further Notes

- The current-state journey research is in [Current user journeys](../current-user-journeys/01-research-current-user-journeys.md).
- Canonical product language is in [CONTEXT.md](../../../CONTEXT.md).
- The decisions made during grilling are recorded in [docs/adr](../../../docs/adr/).
- The target GitHub publication shape is one structured Review body accompanied by safely mapped inline comments, matching the pre-Patchdesk review examples supplied during the design session.
- This spec supersedes the product distinction between prepared and completed Review workbenches. It does not supersede the immutable revision, explicit GitHub-write, bounded diagnostic, or merge-safety contracts.
