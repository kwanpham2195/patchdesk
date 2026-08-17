# Use one progressive review workbench

> **Status: Superseded.** The current Review workbench remains progressive, but the ADR "Use GitHub pending reviews for Review drafting" removes the local draft dock and obsolete Findings navigation described below.

Patchdesk uses one persistent review workbench across review preparation, insight generation, drafting, publication, and merge. **Files** is the default surface. A current analysis result enriches Files with findings and evidence rather than opening a completed-review destination.

The primary surfaces are **Files** and **Insights**. Insights is the extensible home for Analysis, Walkthrough, and future revision-bound ways to understand the change. Pull request overview, checks, discussion, review draft, and merge readiness remain supporting panels in the same workbench. Patchdesk does not expose prepared, completed, manual, model, or read-only workbench modes.

Insights opens to an overview of every available insight type and its status: not generated, running, current, outdated, or failed. Selecting an insight opens its retained result. The overview remains stable as new insight types are added.

The Review draft lives in a persistent collapsible bottom dock shared by Files and Insights. Its collapsed state shows the draft item count, proposed GitHub decision, and attention state. It opens when Analysis seeds an empty draft or refresh leaves draft anchors needing attention, and it owns the submission preview entry point.

Within the Files surface, the review navigator offers **Files**, **Findings**, and **Commits**. Files shows the full current pull request diff. Findings navigates current mapped Analysis evidence. Commits shows the ordered commit list and filters the central diff to the selected commit. Returning to Files restores the full pull request diff; Patchdesk does not add a separate **All changes** scope.

Patchdesk does not persist commit selection in the first version. Opening Commits selects the newest commit.

Findings lists only current Mapped findings from the latest Analysis. Each item shows severity, title, file and line, plus whether it is open, added to the Review draft, or dismissed. Selection opens its evidence in the central diff. General Review body content, outdated Findings, Published feedback, and Walkthrough content do not appear in this navigator. The first version has no grouping, search, or advanced filters.

The header keeps pull request identity, head, refresh state, and checks visible. The existing `PR overview` trigger opens an on-demand right-side overlay for the complete pull request description, discussion and review status, merge readiness, warnings, and merge action. The overlay preserves the diff's full width while closed. Insight status stays in Insights, Findings stay in the left navigator, and draft editing stays in the bottom dock.

Insights uses a small typed contract for built-in Insight types. This spec implements only Analysis and Walkthrough and keeps the shell ready for another built-in type. It does not introduce third-party plugins, dynamic loading, custom Insight schemas, or a marketplace.
