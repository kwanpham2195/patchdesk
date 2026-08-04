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

**Published feedback**:
Review comments and discussion that GitHub has accepted. It remains visible as GitHub-owned content and is not part of the active Review draft.
_Avoid_: Submitted draft, applied batch

**Walkthrough**:
The latest successful guided explanation of a pinned pull request revision.
_Avoid_: Read-only walkthrough, narrative review
