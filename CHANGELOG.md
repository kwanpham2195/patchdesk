# Changelog

## Unreleased

- Standardized renderer errors with shared field, action-local, dialog, and recovery treatments.
- Replaced the bundled code font with Geist Mono and added packaged font-loading checks.
- Made GitHub mutations single-flight and recoverable: uncertain writes now stay locked behind **Check GitHub again**, confirmed writes remain confirmed when refresh fails, and action-local spinners and errors preserve drafts and selections.
- Fixed **Add to review** duplicating a Finding into general review feedback before Finish.
- Fixed long file paths overflowing their cards in the Threads navigator.
- Fixed merge context, warning acknowledgement, and controls overflowing the narrow PR overview drawer.

- Fixed the Analysis merge policy having no effect on the merge itself; an open P0 or P1 Finding now blocks or asks for acknowledgement, as the profile's policy says, instead of being ignored at the merge.
- Fixed a dismissed Finding still counting against merge; the merge badge and the merge itself now count only open Findings, so what the badge offers is what the merge allows.
- Fixed Patchdesk refusing to merge a pull request in a repository with no required-review rule; when GitHub reports no review requirement, that is no longer read as a missing approval.
- Fixed the merge badge reading "Ready to merge" above a panel that said GitHub blocked the merge; the badge and the reasons listed below it now agree.
- Merge readiness now names the checks GitHub requires: the panel says which required check failed and which has not finished yet, and a repository with no branch-protection rule no longer reads as "Required checks have not passed."
- Removed screen reader support, along with the reduced motion and high contrast display settings. Patchdesk is for people who read code on screen with a keyboard and a mouse.
- Fixed a pull request becoming impossible to open after a crash during preparation; a leftover or damaged preparation record is now cleaned up and the review opens again.
- Fixed opening a review and refreshing it running at the same time, which could leave the review showing stale state.
- Fixed avatars and prepared review files being written without the crash-safe sequence the rest of the app uses; a crash mid-write can no longer leave a half-written file.
- Fixed the Pull Requests count showing the number of loaded rows instead of GitHub's true count for the filter.
- Changed Pull Requests to show one repository at a time, with GitHub controlling the filter, order, and count.
- Stopped refreshing Pull Requests every minute; it now refreshes only when you open the screen, change a filter or page, or choose View -> Refresh (Cmd+R).
- Removed saved views and the queue rail from Pull Requests; use GitHub's own filters instead.
- Changed merged pull requests to a filter in Pull Requests instead of a separate mode.
- Changed the Pull Requests label filter to list every label in the repository, not just the labels on the current page.
- Pull Requests loads fresh on first open after this release; its cached rows and saved view settings reset once.
- Fixed the diff theme picker having no effect on the code diff.
- Fixed the saved diff theme not reaching a diff view opened later in the session.
- Fixed code diffs using the system monospace font instead of the app font.
- Switched the interface font to Geist, with Inter as the fallback.
- Improve the Pull Requests list with a Labels column and two-line title clamp.
- Update merge readiness after a submitted pending review is confirmed.
- Fixed review opening when hydrated file context does not match the saved pull-request patch.
