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

**Analysis run**:
An optional model execution that adds findings to a review session.
_Avoid_: Review run, model review

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
Immutable provenance that connects one Analysis run and Finding on one represented revision to the GitHub thread created by its Finding review command. It becomes published when GitHub confirms submission, is removed by a confirmed discard, and is never an editable local comment copy. A receipt visibly identifies the Finding as in the viewer's Pending review or Published. A published receipt makes that Finding unavailable for the rest of its Analysis run and represented revision; a refreshed revision or regenerated Analysis has a new identity and may offer a new Finding. Removing the receipt after a confirmed discard makes its Finding actionable again.
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
The authenticated viewer's remote `PENDING` review for the represented pull request. It is the one authoritative editable Review draft after the maintainer starts a review; Patchdesk reads, appends to, finishes, and discards it through GitHub and keeps no second editable local copy. The final summary is supplied only in the Finish review modal and sent only on Submit.
_Avoid_: Review draft, Review batch, local batch

**Review body**:
The shared Markdown message that accompanies a GitHub review. It describes the reviewed scope, evidence, verdict, and maintainer guidance that do not belong in separate inline comments; it may reference only Findings the maintainer explicitly chose to publish. In the GitHub pending review flow it is supplied only from the Finish review modal at Submit.
_Avoid_: Shared body, review summary

**Analysis review summary**:
The high-level scope, change, verification, and proposed-verdict portion of a current Analysis result. It may prefill the shared Finish review interface only after a Finding command has established the viewer's pending review; the maintainer may edit it and it does not choose the GitHub outcome, create an empty review, publish Finding detail, or become a saved local draft. An outdated Analysis result is readable evidence only and cannot supply review actions or a summary.
_Avoid_: Analysis body, generated review draft

**Conversation**:
The chronological timeline of the PR description, issue comments, review summaries, and general conversation threads that GitHub surfaces on the pull request's main tab. All of it is GitHub-owned content, separate from the GitHub pending review. Returned as a single unified payload by the GitHub adapter. The Conversation screen is read-only; all writes go through the GitHub pending review or GitHub directly. It loads eagerly when a review opens and reloads with each GitHub refresh.
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
An inline GitHub comment or reply that a maintainer explicitly submits from the diff. **Comment now** publishes immediately and only while no viewer pending review is confirmed; it never becomes part of the GitHub pending review.
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
