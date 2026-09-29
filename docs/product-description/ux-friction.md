# UX friction

This list records friction, not defects. The [changelog](../../CHANGELOG.md) owns fix history. Open defects belong in [bug triage](bug-triage.md). Each item has a disposition and links to its feature page.

## Items

### UX-01: Tab walks every Visited row before the screen

- **Disposition:** Resolved. The column is one Tab stop; arrow keys move between rows. Not checked live.
- **Page:** [Keyboard, focus, and desktop](cross-cutting/keyboard-focus-and-desktop.md#arrive), [Visited pull requests](foundations/visited-pull-requests.md#variants).

### UX-02: Keyboard navigation does nothing in Selected, with no hint

- **Disposition:** Resolved. A navigation key in Selected shows "Keyboard navigation works in All files." Not checked live.
- **Page:** [Files, diff, commits, and navigation](review-workbench/files-diff-and-navigation.md#leave-unchanged).

### UX-03: The filter-is-full line sits below the label list

- **Disposition:** Resolved. The message stays visible outside the scrolling list. Not checked live.
- **Page:** [Filters, pagination, and refresh](pull-requests/filters-pagination-and-refresh.md#begin-an-action).

### UX-04: The Insight run dialog gives no cost signal

- **Disposition:** Resolved. API-key models show their list price in the model list and confirmation. Not checked live.
- **Page:** [Brief](review-workbench/brief.md#begin-an-action).

### UX-05: Two All files controls sit side by side in the diff toolbar

- **Disposition:** Resolved. The Scope picker action is named Clear scope. Not checked live.
- **Page:** [Files, diff, commits, and navigation](review-workbench/files-diff-and-navigation.md#edge-cases).

### UX-06: Disabled label checkboxes look almost enabled

- **Disposition:** Resolved. Refused rows dim the color dot and label beside the disabled checkbox. Not checked live.
- **Page:** [Filters, pagination, and refresh](pull-requests/filters-pagination-and-refresh.md#begin-an-action).

### UX-07: The Visited pull requests column toggle has no tooltip

- **Disposition:** Resolved. The collapse toggle and Back have tooltips. Not checked live.
- **Page:** [Keyboard, focus, and desktop](cross-cutting/keyboard-focus-and-desktop.md#edge-cases).

### UX-08: The Logs tail is filled by its own polling

- **Disposition:** Resolved. The log panel no longer logs its own polls. Not checked live.
- **Page:** [Logs and diagnostics](settings/logs-and-diagnostics.md#arrive).

### UX-09: The pressed Scope bucket row looks unpressed

- **Disposition:** Resolved. The selected row is tinted and bold. Not checked live.
- **Page:** The Overview tab was removed; its Scope controls are described in the [Review workbench](review-workbench/files-diff-and-navigation.md).

### UX-10: Verification ticks are lost without warning

- **Disposition:** Resolved. Ticks are saved and survive tab switches, leaving the Review, and restarting the app. Not checked live.
- **Page:** [Analysis](review-workbench/analysis.md#leave-unchanged).

### UX-11: Walkthrough `j` and `k` run opposite to the Vim convention

- **Disposition:** Resolved. `j` moves to the next section; `k` moves to the previous section. Not checked live.
- **Page:** [Walkthrough](review-workbench/walkthrough.md#begin-an-action).

### UX-12: The inline-discussion notice does not say what failed

- **Disposition:** Resolved. An outdated Walkthrough says to regenerate it; other failures say discussion is unavailable and to refresh. Not checked live.
- **Page:** [Walkthrough](review-workbench/walkthrough.md#arrive).

### UX-13: The open Review's Visited row does nothing on Enter

- **Disposition:** Rejected. It represents the current page, so Enter does nothing. The row stays focusable and is marked as current in the UI and tests.
- **Page:** [Visited pull requests](foundations/visited-pull-requests.md#leave-unchanged).

### UX-14: Skip to content leaves `#main-content` in the address

- **Disposition:** Rejected. The app has no address bar. The only code that reads the address checks fixture routes, which do not include this fragment.
- **Page:** [Keyboard, focus, and desktop](cross-cutting/keyboard-focus-and-desktop.md#edge-cases).

### UX-15: The Merge conflicts notice asks for a push Patchdesk cannot make

- **Disposition:** Rejected. The notice says to resolve conflicts in the local checkout and push the named branch. It does not imply Patchdesk can push.
- **Page:** [Files, diff, commits, and navigation](review-workbench/files-diff-and-navigation.md#edge-cases).

### UX-16: Insights opens on an empty Brief beside a repeated Overview tab

- **Disposition:** Resolved. Insights opens on the first reader with a saved result, or Brief when none has one. A restored reader remains selected.
- **Page:** [Brief](review-workbench/brief.md#arrive).

### UX-17: The Review details inspector repeats the workbench's Insight controls

- **Disposition:** Resolved. The inspector shows read-only Insight status and one Open action. Its toggle has a panel icon and tooltip.
- **Page:** [The repository listing](pull-requests/repository-listing.md#the-simple-case).

### UX-18: The Review header changes shape by pull request state

- **Disposition:** Resolved. Status chips stay below the title. The Merge chip states the terminal outcome; the header shows freshness and Insight times in plain language. Generate controls are hidden on merged or closed Reviews.
- **Page:** [Files, diff, commits, and navigation](review-workbench/files-diff-and-navigation.md#arrive).

### UX-19: The Pull requests screen spends space on empty and unlabeled things

- **Disposition:** Resolved. The freshness chip includes its time, empty columns and unused page controls are hidden, and Visited rows label their times.
- **Page:** [The repository listing](pull-requests/repository-listing.md#arrive).
