# Limit Insight comment mapping to Findings

> **Status: Superseded.** The ADR "Authorize Finding review commands from Analysis" preserves current Mapped Finding commands, but they write directly to GitHub's pending review instead of a local draft.

Within Insights, only a current Mapped finding can become a line-specific item in the Review draft. Walkthrough and future insight types may help the maintainer navigate to Files, but they do not create GitHub inline-comment drafts directly.

Maintainers can still author manual inline comments from current changed lines in Files. This keeps GitHub code anchors grounded in either the current diff or the Analysis contract that produces explicit mapped evidence, rather than requiring every future Insight to invent comment-mapping semantics.

Adding a Mapped finding copies its proposed comment and code location into the Review draft. The maintainer owns and may edit that copy. Later analysis runs never rewrite or remove it. Patchdesk marks the Finding as added while the copied draft exists, and makes it available again if the draft is removed.

The Analysis result also produces one complete Review body. Findings without a safe inline location remain part of that body without an **Unmapped** label or separate action.
