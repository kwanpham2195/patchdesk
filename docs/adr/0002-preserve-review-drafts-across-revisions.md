# Preserve review drafts across revisions

> **Status: Superseded.** ADR-0014 and the current Review lifecycle use GitHub's pending review as the only editable draft; explicit Refresh never carries local draft content across revisions.

When a maintainer refreshes to a newer pull request revision, Patchdesk preserves the review draft. General feedback carries forward unchanged. Patchdesk moves an inline draft only when it can map the original target unambiguously; otherwise, it keeps the draft with its original file and code context under **Needs attention**.

The maintainer must reattach, convert, or remove every inline draft that needs attention before publishing. Patchdesk never discards an unpublished draft or guesses an ambiguous code location during refresh.
