# Changelog

## Unreleased

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
