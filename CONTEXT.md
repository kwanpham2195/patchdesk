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

**Dismissed finding**:
A Finding the maintainer has judged to be a false positive, accepted risk, or irrelevant and recorded a reason for excluding.
_Avoid_: Resolved finding, deleted finding

**GitHub review**:
An approval, comment, or request for changes that the maintainer explicitly publishes to GitHub.
_Avoid_: Submitted batch, published review batch

**Review draft**:
The maintainer's unpublished Review body, inline comments, and thread actions for a review. It remains local until the maintainer explicitly publishes it to GitHub.
_Avoid_: Review batch, local batch

**Review body**:
The shared Markdown message that accompanies a GitHub review. It describes the reviewed scope, evidence, findings, verdict, and maintainer guidance that do not belong in separate inline comments.
_Avoid_: Shared body, review summary

**Conversation**:
The chronological timeline of the PR description, issue comments, review summaries, and general conversation threads that GitHub surfaces on the pull request's main tab. All of it is GitHub-owned content, separate from the local Review draft. Returned as a single unified payload by the GitHub adapter. The Conversation screen is read-only; all writes go through the Review draft or GitHub directly. It loads eagerly when a review opens and reloads with each GitHub refresh.
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
An inline GitHub comment or reply that a maintainer explicitly submits from the diff. It publishes immediately and never becomes part of the local Review draft.
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
