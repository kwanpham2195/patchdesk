# Keep GitHub refresh explicit

Patchdesk detects lightweight GitHub metadata changes in the background but applies remote commits, discussion, checks, and review state only when the maintainer explicitly refreshes the review workbench. This keeps the visible review stable while the maintainer reads or drafts feedback. Patchdesk-owned analysis and walkthrough work continues to report live progress because it does not replace remote GitHub state.

The workbench always shows when it was last refreshed. It shows **Updates available** only after positively detecting a newer head commit or newer pull request activity; elapsed time alone does not trigger the indicator. The first version does not claim to detect every remote change.

While updates are available, the maintainer can keep reading and editing the local review draft. Patchdesk pauses all GitHub writes until refresh incorporates the newer activity. Refresh preserves the review draft and restores only the write actions allowed by the refreshed state.
