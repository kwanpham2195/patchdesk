# Product journey audit — 2026-07-29

## Scope

This is a combined UX and visual accessibility audit of the current Patchdesk
package plus deterministic Design scenarios. The package was launched with an
isolated profile and no GitHub writes. Design captures are labeled separately:
they illustrate intended states but do not prove current packaged behavior.

Evidence lives in `/tmp/patchdesk-product-audit-2026-07-29/`.

## Steps and evidence

1. Packaged inbox entry — `08-packaged-current-entry.png`
   - The default My inbox queue showed zero rows while its sibling queues
     showed Checks failing: 3 and All open: 5.
2. Packaged checks-failing queue — `09-packaged-checks-failing.png`
   - Selecting Checks failing immediately showed three fixture PRs: #717,
     #754, and #716.
3. Packaged Settings General — `16-packaged-settings-general.png`
   - General mixes appearance, diff-theme, and Workspace profile controls.
4. Design prepared review — `10-design-review-prepared.png`
   - The prepared state exposes View diff, Inspect failing checks, and Run
     review.
5. Design diff and context — `11-design-prepared-diff.png` and
   `13-design-review-context.png`
   - The diff has a file-tree rail, but Review context opens a static sheet.
6. Design completed review — `14-design-review-completed.png`
   - Findings, merge readiness, and Generate walkthrough appear only here.
7. Design walkthrough ready — `15-design-walkthrough-ready.png`
   - The view starts with chapter and Support controls before a selected
     chapter's reading content is visible.
8. Design Settings Workspace and Data & recovery —
   `04-settings-workspace.png` and `06-settings-data-recovery.png`
   - Watchlist and destructive-data controls are correctly grouped by purpose,
     though these are mock-only captures.

## Current-code confirmation

- `src/renderer/src/components/app-shell.tsx` renders a persistent Workspace
  sidebar for all routes.
- `src/renderer/src/flows/prepared-review-flow.tsx` owns separate View diff,
  Inspect failing checks, and Run review actions.
- `src/renderer/src/components/diff-workbench.tsx` renders Review context as a
  static right Sheet.
- `src/renderer/src/components/completed-review-workbench.tsx` mounts the
  walkthrough controls only from the completed workbench.

## Strengths

- Current package rows explain review state, checks, and selected PR details.
- The local-first message and explicit write confirmation are visible in the
  main working states.
- Settings tabs use clear labels. Watchlist and data cleanup are not mixed into
  ordinary appearance settings.
- Captured controls exposed accessible names and roles in the audit browser.

## Findings

### P1 — The default inbox can look empty when work is waiting

Evidence: packaged steps 1 and 2. My inbox starts with no visible rows, while
the same screen announces three failing-check PRs and five open PRs.

Impact: a maintainer can reasonably conclude there is nothing to do and miss
an active queue.

Recommendation: when My inbox is empty but another queue has work, replace
the blank list with a direct empty state such as “No pull requests need your
review. 3 have failing checks.” Include one action that selects that queue.
Keep the chosen queue visible in the empty-state copy.

### P1 — The review journey still makes AI look like the owner of the PR

Evidence: prepared-review and completed-review steps. Current-code inspection
confirms the split.

Impact: description, discussion, drafts, merge readiness, and walkthrough
appear to arrive only after Run review even though a maintainer needs many of
them before AI analysis.

Recommendation: implement the existing prepared-PR workbench plan. The
prepared snapshot should own PR overview, human drafts, confirmed writes,
merge readiness, and walkthrough. AI should add model-origin items to that
same local batch.

### P1 — Persistent application navigation is redundant on a review screen

Evidence: packaged inbox and prepared-diff captures. On the workbench, the
Workspace sidebar shows only Inbox while a second left rail holds changed
files.

Impact: the diff loses useful reading width and the application feels like a
dashboard around a code-review task.

Recommendation: implement the approved workbench composition: Back plus
workspace/inbox access in the header, file tree as the only left rail, wide
diff center, optional PR overview right. Later test the same reduction on the
Inbox route; its queue rail carries actual task navigation, while the app
sidebar currently does little beyond repeat the workspace name and Inbox.

### P2 — Review context explains rules but does not help the current task

Evidence: Design diff/context step. Current-code inspection confirms the
sheet's content is static except for mapped-finding detail.

Impact: it occupies the prime contextual surface without showing description,
checks, threads, or the maintainer's local drafts.

Recommendation: replace it with the approved PR overview. Make Description
and Checks initially open, then Existing threads and Your local review. Do
not keep View diff or Inspect failing checks as permanent header actions while
the corresponding information is already on screen.

### P2 — Settings General mixes user preferences with workspace setup

Evidence: packaged Settings General step.

Impact: a person changing dark mode must scan profile configuration and GitHub
setup controls. The modal's opening copy also describes implementation
behavior (“Centered overlay…”) rather than the user's task.

Recommendation: keep General to appearance and diff-theme preferences. Move
Active profile and profile/GitHub setup into Workspace. Remove the modal
mechanics copy; use a short task-focused subtitle or no subtitle. Retain the
existing Watchlist and Data & recovery grouping.

### P2 — Walkthrough's first visible state gives equal weight to navigation
and reading

Evidence: Design walkthrough-ready step only.

Impact: before a chapter is selected, the chapter rail and Support list fill
the visible area, so the reader does not immediately see the explanation or
the diff evidence.

Recommendation: automatically select the first chapter and put its narrative
and focused diff in the initial viewport. Keep Support collapsed until needed.
This needs current-renderer/package verification after walkthrough moves to
the prepared workbench.

### P2 — The Design catalog is not a dependable journey entry point yet

Evidence: the Review prepared card did not navigate when clicked from Design
landing, although direct `?scenario=review-prepared` navigation worked.

Impact: this weakens the permanent visual reference as a manual regression
surface.

Recommendation: add a focused browser test for every scenario-card link and
fix the landing-card navigation before relying on Design for acceptance
testing.

## Accessibility risks and limits

- The captured controls had accessible names and roles. This is a positive
  smoke signal, not a compliance result.
- Screenshot evidence cannot verify keyboard reachability, focus order,
  screen-reader announcements, contrast ratios, zoom/reflow, or dialog focus
  trapping. Run the existing accessibility suite and a keyboard-only package
  pass after changing the workbench.
- The Settings background blur keeps the dialog distinct, but it reduces the
  legibility of the underlying state. Confirm focus containment and Escape
  behavior with keyboard testing.

## Recommended order

1. Finish the existing prepared-PR workbench plan. It resolves the two P1
   review-flow problems and the Review context P2.
2. Fix the Inbox empty-with-work state. This is a narrow, independent user
   journey improvement.
3. Simplify Settings General and repair the Design scenario landing links.
4. Re-audit a fresh packaged walkthrough after it is available from a prepared
   snapshot.
