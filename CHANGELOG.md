# Changelog

## Unreleased

- Fixed the Pull Requests count showing the number of loaded rows instead of GitHub's true count for the filter.
- Changed Pull Requests to show one repository at a time, with GitHub controlling the filter, order, and count.
- Stopped refreshing Pull Requests every minute; it now refreshes only when you open the screen, change a filter or page, or choose View -> Refresh (Cmd+R).
- Removed saved views and the queue rail from Pull Requests; use GitHub's own filters instead.
- Added a Local reviews list to Pull Requests, showing your saved reviews for the selected repository even after GitHub stops returning the pull request.
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
- Added a compact revision-bound Call Flow screen with side-by-side comparison, calldiff call paths, source navigation, search, and raw technical output.
