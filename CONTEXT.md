# Patchdesk

Patchdesk is a local-first workbench for maintainers who evaluate GitHub pull requests and decide what to publish or merge.

## Language

**Review**:
A maintainer's end-to-end evaluation of an open pull request. It continues as the pull request receives updates and ends when the pull request is merged or closed, whether or not the maintainer uses model analysis.
_Avoid_: Model review, completed review, prepared review

**Review workbench**:
The persistent surface where a maintainer conducts a review. It represents GitHub state from the maintainer's latest refresh alongside live progress and results from analysis or walkthrough work started in Patchdesk.
_Avoid_: Prepared workbench, completed workbench, read-only view

**Review session**:
The local work for a review, anchored to one pinned pull request revision.
_Avoid_: Prepared review

**Represented-review worktree**:
Patchdesk's immutable checkout for a Review session's pinned revision. Codex may inspect it only through verified sandboxed read-only tools; it is never the maintainer's original checkout.
_Avoid_: Local checkout, repository clone

**Analysis run**:
An optional model execution that adds findings to a review session.
_Avoid_: Review run, model review

**Insight provider**:
A selectable source for Analysis runs and Walkthroughs. Initially, the choices are Pi and the Codex CLI account provider.
_Avoid_: Model, login

**Codex CLI account provider**:
An Insight provider that uses the maintainer's existing local Codex CLI account without Patchdesk reading or persisting its credentials. It may use verified sandboxed read-only inspection tools only against the immutable represented-review worktree.
_Avoid_: ChatGPT login, OAuth provider, Codex API key

**Analysis result**:
The latest successful Review body and Findings produced by an analysis run. It remains bound to the pull request revision that was analyzed.
_Avoid_: Completed review, model review

**Insight**:
A revision-bound aid that helps a maintainer understand or evaluate a pull request change. Analysis results and walkthroughs are insight types.
_Avoid_: Model feature, alternate review

**Finding**:
A concern or observation in an analysis result, supported by evidence from the analyzed pull request revision.
_Avoid_: Model comment, automated review comment

**Mapped finding**:
A current Finding whose evidence identifies an unambiguous location in the current pull request diff.
_Avoid_: Inline finding, GitHub finding

**Finding evidence hunk**:
The exact containing diff hunk from the represented pull request patch for a Mapped Finding, with that Finding's anchored line range highlighted and expanded by default. It is evidence in Analysis, not a generated code excerpt or an alternate File view.
_Avoid_: Code snippet, generated hunk, mini diff

**Finding review command**:
An explicit maintainer action that uses a current Mapped Finding's suggested text, or its explanation when no suggested text is available, to start or append to the viewer's GitHub pending review. It is one GitHub write after the action is clicked; it has no Analysis-side editor, local queue, or automatic execution when Analysis completes. A confirmed GitHub failure leaves the Finding actionable; an uncertain outcome locks further Finding commands until explicit GitHub reconciliation.
_Avoid_: Auto review, model comment, Finding draft

**Pending-review Finding**:
A current Mapped Finding identified by a pending Finding review receipt for the viewer's confirmed GitHub pending review. It prevents a duplicate command for that pending review, without becoming an editable Analysis disposition or local comment copy.
_Avoid_: Added Finding, queued Finding, local inclusion

**Finding review receipt**:
Immutable provenance connecting one Analysis Finding on one represented revision to its GitHub thread. A receipt is Pending, Published, or Historical. Historical receipts never authorize the adopted draft; their Finding is actionable again only with evidence it is neither pending nor published.
_Avoid_: Finding draft, comment mirror, publication queue

**Finding-backed pending review**:
The viewer's GitHub pending review when it contains at least one current Finding review receipt. Only this state exposes the Analysis-summary action in the Analysis screen.
_Avoid_: Analysis review, generated pending review

**Dismissed finding**:
A Finding the maintainer has judged to be a false positive, accepted risk, or irrelevant and recorded a reason for excluding.
_Avoid_: Resolved finding, deleted finding

**GitHub review**:
An approval, comment, or request for changes that the maintainer explicitly publishes to GitHub.
_Avoid_: Submitted batch, published review batch

**GitHub pending review**:
The authenticated viewer's remote `PENDING` review for the represented pull request. It is the one authoritative editable Review draft; Patchdesk has no second editable local copy.
_Avoid_: Review draft, Review batch, local batch

**Pending-review reconciliation**:
The same-revision operation that adopts a different authoritative GitHub pending-review state when no pending-review operation is locked. GitHub wins; Patchdesk never merges drafts. The adopted draft owns later Finding review commands.
_Avoid_: Pending-review conflict resolution, draft merge

**Merge command**:
The explicit maintainer action that selects a GitHub merge method and sends the merge. It rechecks current GitHub state and requires acknowledgement for current merge warnings.
_Avoid_: Automatic merge, stale merge permission

**Workbench theme inheritance**:
Embedded workbench surfaces, including the changed-files tree, use Patchdesk's active light/dark theme automatically. They have no independent theme preference.
_Avoid_: Tree theme, dark-only panel

**Remote state unavailable**:
Patchdesk could not confirm the current GitHub state. It may show the last known read-only state, but cannot authorize writes until a current same-revision check succeeds.
_Avoid_: Fresh state, no changes

**Terminal remote state**:
GitHub has reported that the represented pull request is merged or closed. Patchdesk adopts that final Review state and stops further review and merge writes.

**Post-write reconciliation**:
The one read-only check after a confirmed Patchdesk GitHub write. It never repeats the write.

**Review body**:
The shared Markdown message that accompanies a GitHub review. It describes the reviewed scope, evidence, verdict, and maintainer guidance that do not belong in separate inline comments; it may reference only Findings the maintainer explicitly chose to publish. In the GitHub pending review flow it is supplied only from the Finish review modal at Submit.
_Avoid_: Shared body, review summary

**Analysis review summary**:
The high-level scope, change, verification, and proposed-verdict portion of a current Analysis result. It may prefill the shared Finish review interface only after a Finding command has established the viewer's pending review; the maintainer may edit it and it does not choose the GitHub outcome, create an empty review, publish Finding detail, or become a saved local draft. An outdated Analysis result is readable evidence only and cannot supply review actions or a summary.
_Avoid_: Analysis body, generated review draft

**Conversation**:
The chronological timeline of the PR description, issue comments, review summaries, and general conversation threads that GitHub surfaces on the pull request's main tab. All of it is GitHub-owned content, separate from the GitHub pending review. The Conversation screen is read-only and reconciles while its represented revision remains current.
_Avoid_: Published feedback, discussion tab, timeline

**Conversation thread**:
A group of GitHub review comments, with open, resolved, or outdated state. Inline threads (tied to a specific diff location) live in the diff view. General threads (no code anchor) appear in the Conversation screen.
_Avoid_: Review thread, discussion thread

**Mapped conversation thread**:
An inline Conversation thread in open or resolved state whose GitHub anchor can be placed unambiguously on either the old or new side of the current diff. Only mapped Conversation threads appear in the diff view. Outdated threads are excluded.
_Avoid_: Current thread, unresolved thread

**Thread state change**:
An explicit maintainer action that changes a mapped Conversation thread between open and resolved. A direct Resolve or Unresolve command confirms the GitHub update.
_Avoid_: Draft action, batched action

**Direct conversation comment**:
An inline GitHub comment or reply that a maintainer explicitly submits from the diff. **Comment now** publishes immediately only while no viewer pending review is confirmed; it never becomes part of that pending review.
_Avoid_: Inline draft, queued reply

**Partial conversation thread**:
A Conversation thread for which Patchdesk has only a bounded subset of GitHub replies. It remains visible but is explicitly identified as incomplete.
_Avoid_: Complete thread

**Conversation entry**:
One item in the Conversation screen's chronological timeline. Types: PR description, issue comment, review summary, or general conversation thread (a review-comment thread with no diff anchor; includes its nested replies). Inline conversation threads live in the diff view instead.
_Avoid_: Timeline entry, discussion entry

**Walkthrough**:
The latest successful guided explanation of a pinned pull request revision.
_Avoid_: Read-only walkthrough, narrative review
