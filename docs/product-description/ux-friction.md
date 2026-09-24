# UX friction

This file records places where Patchdesk works as built but costs the maintainer time, attention, or confidence. A defect, where the product does something other than what it or its documents promise, belongs in [bug-triage.md](bug-triage.md) instead; this file lists those only by reference.

The items come from four read-only live passes and one independent review on 2026-09-14, run over CDP 9233 against the maintainer's running `pnpm dev` app at `5fe7df3b`. That commit is the pinned `dd613996` plus renderer failure copy for comment and Finding actions. The passes covered the Pull requests and cross-cutting pages, the foundations, first-run, and Settings pages, the Review workbench core pages, and the Insights pages, in the maintainer's Personal workspace watching one repository. Three items (UX-10 to UX-12) were raised from source by the page revisions and were not reachable live, because no Review in that workspace had a retained Insight. Screenshots from the passes were temporary and are described in words here.

Every item carries one disposition: fix now, a named follow-up issue, or rejected with evidence. UX-01 to UX-12 were filed as #190 to #201; the rejected items are not filed.

All twelve issues are closed as completed and their changes are in `737c515c`; each item names its fix commit and keeps the original observation. None of the fixes has post-fix live evidence: they are read from source. The three rejected items stand.

## Summary

Medium:

- [UX-01](#ux-01-tab-walks-every-visited-row-before-the-screen): Tab walks every Visited row before the screen. Fixed in `d9503e49`. [#190](https://github.com/kwanpham2195/patchdesk/issues/190)
- [UX-02](#ux-02-keyboard-navigation-does-nothing-in-selected-with-no-hint): Keyboard navigation does nothing in Selected, with no hint. Fixed in `7d7300a0`. [#191](https://github.com/kwanpham2195/patchdesk/issues/191)
- [UX-03](#ux-03-the-filter-is-full-line-sits-below-the-label-list): The filter-is-full line sits below the label list. Fixed in `10562bde`. [#192](https://github.com/kwanpham2195/patchdesk/issues/192)
- [UX-04](#ux-04-the-insight-run-dialog-gives-no-cost-signal): The Insight run dialog gives no cost signal. Fixed in `9e06b7d5`. [#193](https://github.com/kwanpham2195/patchdesk/issues/193)
- [UX-05](#ux-05-two-all-files-controls-sit-side-by-side-in-the-diff-toolbar): Two All files controls sit side by side in the diff toolbar. Fixed in `479eaf59`. [#194](https://github.com/kwanpham2195/patchdesk/issues/194)

Low:

- [UX-06](#ux-06-disabled-label-checkboxes-look-almost-enabled): Disabled label checkboxes look almost enabled. Fixed in `901cd439`. [#195](https://github.com/kwanpham2195/patchdesk/issues/195)
- [UX-07](#ux-07-the-visited-pull-requests-column-toggle-has-no-tooltip): The Visited pull requests column toggle has no tooltip. Fixed in `293f32f2`. [#196](https://github.com/kwanpham2195/patchdesk/issues/196)
- [UX-08](#ux-08-the-logs-tail-is-filled-by-its-own-polling): The Logs tail is filled by its own polling. Fixed in `f7716d83`. [#197](https://github.com/kwanpham2195/patchdesk/issues/197)
- [UX-09](#ux-09-the-pressed-scope-bucket-row-looks-unpressed): The pressed Scope bucket row looks unpressed. Fixed in `fa934380`. [#198](https://github.com/kwanpham2195/patchdesk/issues/198)
- [UX-10](#ux-10-verification-ticks-are-lost-without-warning): Verification ticks are lost without warning. Fixed in `e5091235`. [#199](https://github.com/kwanpham2195/patchdesk/issues/199)
- [UX-11](#ux-11-walkthrough-j-and-k-run-opposite-to-the-vim-convention): Walkthrough `j` and `k` run opposite to the Vim convention. Fixed in `5b74ffd2`. [#200](https://github.com/kwanpham2195/patchdesk/issues/200)
- [UX-12](#ux-12-the-inline-discussion-notice-does-not-say-what-failed): The inline-discussion notice does not say what failed. Fixed in `6a0cbeb7`. [#201](https://github.com/kwanpham2195/patchdesk/issues/201)
- [UX-13](#ux-13-the-open-reviews-visited-row-does-nothing-on-enter): The open Review's Visited row does nothing on Enter. Rejected with evidence.
- [UX-14](#ux-14-skip-to-content-leaves-main-content-in-the-address): Skip to content leaves `#main-content` in the address. Rejected with evidence.
- [UX-15](#ux-15-the-merge-conflicts-notice-asks-for-a-push-patchdesk-cannot-make): The Merge conflicts notice asks for a push Patchdesk cannot make. Rejected with evidence.
- [UX-16](#ux-16-insights-opens-on-an-empty-brief-beside-an-overview-that-repeats-the-tab-strip): Insights opens on an empty Brief beside an Overview that repeats the tab strip. Fixed with [#350](https://github.com/kwanpham2195/patchdesk/issues/350).
- [UX-17](#ux-17-the-review-details-inspector-repeats-the-workbenchs-insight-controls): The Review details inspector repeats the workbench's Insight controls. Fixed with [#351](https://github.com/kwanpham2195/patchdesk/issues/351).
- [UX-18](#ux-18-the-review-header-changes-shape-by-pull-request-state): The Review header changes shape by pull request state. Fixed with [#361](https://github.com/kwanpham2195/patchdesk/issues/361).
- [UX-19](#ux-19-the-pull-requests-screen-spends-space-on-empty-and-unlabeled-things): The Pull requests screen spends space on empty and unlabeled things. Fixed with [#363](https://github.com/kwanpham2195/patchdesk/issues/363).

Count: 19 items, 5 medium and 14 low; 12 named follow-ups, all now fixed, 4 fixed now, and 3 rejected with evidence.

Friction the passes reported that is a defect, with the independent review's disposition, is tracked in bug-triage.md:

- [B-09](bug-triage.md#b-09-workspace-settings-reports-github-authentication-required-while-the-active-account-works): the Workspace authentication alert on a multi-account machine. Fixed.
- [B-10](bug-triage.md#b-10-the-reviewers-control-never-loads-on-a-merged-or-closed-review): Reviewers stuck loading on merged or closed Reviews. Fixed.
- [B-11](bug-triage.md#b-11-generate-and-regenerate-are-disabled-on-a-merged-or-closed-review-with-no-reason): Generate silently disabled on merged or closed Reviews. Fixed.
- [B-12](bug-triage.md#b-12-the-checks-control-opens-pr-overview-on-merge-readiness): the Checks control opening PR overview on Merge readiness. Fixed.
- [B-13](bug-triage.md#b-13-context-and-preview-stay-unavailable-when-the-review-worktree-is-missing): Context and Preview unavailable with no worktree rebuild. Named follow-up.
- [B-14](bug-triage.md#b-14-a-re-render-can-cancel-heading-focus-after-a-destination-change): heading focus cancelled by a re-render, with its missing test. Named follow-up.
- [B-18](bug-triage.md#b-18-a-markdown-syntax-image-never-opens-the-full-size-view): Markdown-syntax screenshots that never zoom. Awaiting a decision.

## Medium

### UX-01: Tab walks every Visited row before the screen

- **Screen:** Any screen with the Visited pull requests column expanded.
- **What the maintainer does:** Tabs from the titlebar toward the screen's own controls.
- **What they see:** Focus runs Skip to content, the collapse toggle, Back, Active workspace, Settings, Navigate, and then every Visited row, 14 in the live workspace and up to 20, before reaching a workbench tab or the listing.
- **Why it hurts:** A keyboard user pays up to 20 extra key presses every time they tab past the titlebar. Skip to content helps only from the top of the page.
- **Suggested improvement:** Make the column one Tab stop with arrow-key movement between rows (a roving tab index), so every row stays reachable and the walk costs one press.
- **Severity:** medium.
- **Disposition:** named follow-up, from the independent review.
- **Issue:** [#190](https://github.com/kwanpham2195/patchdesk/issues/190)
- **Status:** fixed by `d9503e49`: the column is one Tab stop with Arrow Up and Arrow Down moving between rows. Read from source at `737c515c`, not observed live.
- **Page:** [Keyboard, focus, and desktop](cross-cutting/keyboard-focus-and-desktop.md#arrive), [Visited pull requests](foundations/visited-pull-requests.md#variants).

### UX-02: Keyboard navigation does nothing in Selected, with no hint

- **Screen:** Review workbench, Diff tab, with the file display mode on Selected.
- **What the maintainer does:** Presses a file, hunk, or unresolved-comment key such as `]`.
- **What they see:** Nothing: no movement, no status message, no boundary message. The same key with All files chosen shows "Already at the last hunk." at the boundary.
- **Why it hurts:** The commands look broken. A profile that last used Selected opens every Review that way, so the maintainer meets the silence on each new Review with no clue that All files is required.
- **Suggested improvement:** Show a hint in Selected that keyboard navigation works in All files; [#191](https://github.com/kwanpham2195/patchdesk/issues/191) owns the details.
- **Severity:** medium.
- **Disposition:** named follow-up, from the independent review. The gating itself is intended since `14b47d13` and test-asserted.
- **Issue:** [#191](https://github.com/kwanpham2195/patchdesk/issues/191)
- **Status:** fixed by `7d7300a0`: a navigation key pressed in Selected now shows "Keyboard navigation works in All files." Read from source at `737c515c`, not observed live.
- **Page:** [Files, diff, commits, and navigation](review-workbench/files-diff-and-navigation.md#leave-unchanged).

### UX-03: The filter-is-full line sits below the label list

- **Screen:** Pull requests, the label filter menu.
- **What the maintainer does:** Ticks a fifth label in a repository with 13 labels.
- **What they see:** The other eight checkboxes turn disabled. The menu shows about nine rows before scrolling, and the explanation "This filter is full. Clear a selected label to choose another." sits after the last label, out of view.
- **Why it hurts:** The one line that explains the disabled rows is the line least likely to be on screen when the maintainer needs it.
- **Suggested improvement:** Pin the line near the top of the menu, beside its search field, while the cap is reached, or scroll it into view when the cap is first reached.
- **Severity:** medium.
- **Disposition:** named follow-up.
- **Issue:** [#192](https://github.com/kwanpham2195/patchdesk/issues/192)
- **Status:** fixed by `10562bde`: the line sits outside the scrolling label list, so it stays in view. Read from source at `737c515c`, not observed live.
- **Page:** [Filters, pagination, and refresh](pull-requests/filters-pagination-and-refresh.md#begin-an-action).

### UX-04: The Insight run dialog gives no cost signal

- **Screen:** The Insight run dialog, opened from Generate brief on an open Review.
- **What the maintainer does:** Opens the Model list to choose a model for a billed run.
- **What they see:** A long list of model identifiers, from the smallest to the largest, as plain text. Neither the list nor the confirmation line says anything about relative cost.
- **Why it hurts:** Model choice is the main cost decision of a run, and the dialog offers no basis for it; the maintainer must know provider pricing by heart.
- **Suggested improvement:** Show each model's list price in the dialog; [#193](https://github.com/kwanpham2195/patchdesk/issues/193) owns the details.
- **Severity:** medium.
- **Disposition:** named follow-up.
- **Issue:** [#193](https://github.com/kwanpham2195/patchdesk/issues/193)
- **Status:** fixed by `9e06b7d5`: each API key model shows its list price, and the confirmation line repeats it. Read from source at `737c515c`, not observed live.
- **Page:** [Brief](review-workbench/brief.md#begin-an-action).

### UX-05: Two All files controls sit side by side in the diff toolbar

- **Screen:** Review workbench, Diff tab toolbar.
- **What the maintainer does:** Looks for how to see every file again.
- **What they see:** An All files button that sets the file display mode, and a few controls to its right a Scope picker whose first entry is also All files and clears the Scope filter.
- **Why it hurts:** The same words do two different things in one toolbar, so choosing one when the other was meant leaves the pane unchanged and the maintainer unsure why.
- **Suggested improvement:** Rename the Scope picker entry, for example "All buckets" or "Clear scope".
- **Severity:** medium.
- **Disposition:** named follow-up.
- **Issue:** [#194](https://github.com/kwanpham2195/patchdesk/issues/194)
- **Status:** fixed by `479eaf59`: the Scope picker entry is now Clear scope. Read from source at `737c515c`, not observed live.
- **Page:** [Files, diff, commits, and navigation](review-workbench/files-diff-and-navigation.md#edge-cases).

## Low

### UX-06: Disabled label checkboxes look almost enabled

- **Screen:** Pull requests, the label filter menu with five labels ticked.
- **What the maintainer does:** Compares ticked, unticked, and disabled rows.
- **What they see:** Disabled rows keep their full-colour label dot and text; only the checkbox border dims slightly.
- **Why it hurts:** A maintainer clicks a disabled row, nothing happens, and the explanation is out of view (UX-03).
- **Suggested improvement:** Dim the whole disabled row, dot and text included, to the weight disabled controls carry elsewhere.
- **Severity:** low.
- **Disposition:** named follow-up.
- **Issue:** [#195](https://github.com/kwanpham2195/patchdesk/issues/195)
- **Status:** fixed by `901cd439`: a refused row dims its colour dot and name beside the disabled checkbox. Read from source at `737c515c`, not observed live.
- **Page:** [Filters, pagination, and refresh](pull-requests/filters-pagination-and-refresh.md#begin-an-action).

### UX-07: The Visited pull requests column toggle has no tooltip

- **Screen:** The titlebar, on any screen.
- **What the maintainer does:** Hovers the icon-only collapse toggle, then the Settings button beside it.
- **What they see:** Settings shows "Open Settings"; the toggle shows nothing. Back shows nothing either.
- **Why it hurts:** A mouse user learns what the panel icon does only by pressing it, unlike its neighbours.
- **Suggested improvement:** Give the toggle and Back the same tooltip the Settings and Navigate buttons use, with the toggle's existing accessible name as the text.
- **Severity:** low.
- **Disposition:** named follow-up.
- **Issue:** [#196](https://github.com/kwanpham2195/patchdesk/issues/196)
- **Status:** fixed by `293f32f2`: the collapse toggle and Back both carry a tooltip. Read from source at `737c515c`, not observed live.
- **Page:** [Keyboard, focus, and desktop](cross-cutting/keyboard-focus-and-desktop.md#edge-cases).

### UX-08: The Logs tail is filled by its own polling

- **Screen:** Settings → Logs with All levels and All processes.
- **What the maintainer does:** Watches the tail for about 30 seconds in an idle session.
- **What they see:** A pair of main and renderer debug entries for the panel's own `GET /v1/logs` request every two seconds, outnumbering everything else.
- **Why it hurts:** A maintainer looking for a real problem first filters out the panel's heartbeat by eye.
- **Suggested improvement:** Treat this as a bug in the renderer's `skipLogging` check at `src/renderer/src/api-client.ts:49`, which compares the full path, query string included, with `/v1/logs` and so logs the panel's own requests; [#197](https://github.com/kwanpham2195/patchdesk/issues/197) owns the details.
- **Severity:** low.
- **Disposition:** named follow-up.
- **Issue:** [#197](https://github.com/kwanpham2195/patchdesk/issues/197)
- **Status:** fixed by `f7716d83`: the check compares the pathname, so the panel no longer logs its own poll. Read from source at `737c515c`, not observed live.
- **Page:** [Logs and diagnostics](settings/logs-and-diagnostics.md#arrive).

### UX-09: The pressed Scope bucket row looks unpressed

- **Screen:** Insights → Overview, with a Scope filter applied from the Scope card.
- **What the maintainer does:** Applies Core, goes to the Diff, and returns to Overview.
- **What they see:** The Core row is marked pressed for keyboard and assistive state, but its background tint cannot be told apart from the Tests and Docs rows.
- **Why it hurts:** The page promises the pressed row as the way to see which bucket filters the Diff; by eye there is no such signal.
- **Suggested improvement:** Draw the pressed row with the bucket's colour or a border, as the Diff toolbar's Scope picker shows the active bucket.
- **Severity:** low.
- **Disposition:** named follow-up.
- **Issue:** [#198](https://github.com/kwanpham2195/patchdesk/issues/198)
- **Status:** fixed by `fa934380`: the pressed row is tinted and bolded. Read from source at `737c515c`, not observed live.
- **Page:** Insights overview, a page removed with the Overview tab in #350.

### UX-10: Verification ticks are lost without warning

- **Screen:** Analysis reader, Verification checklist.
- **What the maintainer does:** Ticks several verification steps, checks something in Brief, and comes back.
- **What they see:** Every tick is gone. The only hint that they were temporary is "in this view" in the count.
- **Why it hurts:** The checklist invites progress tracking and then drops it on the most ordinary move between Insight tabs.
- **Suggested improvement:** Label the ticks beside the checklist as temporary; [#199](https://github.com/kwanpham2195/patchdesk/issues/199) owns the details.
- **Severity:** low. Raised from source; not reachable live.
- **Disposition:** named follow-up.
- **Issue:** [#199](https://github.com/kwanpham2195/patchdesk/issues/199)
- **Status:** fixed by `e5091235`: the Verification card says the ticks are not saved. Read from source at `737c515c`, not observed live.
- **Reversal:** [#352](https://github.com/kwanpham2195/patchdesk/issues/352) (decided in [#348](https://github.com/kwanpham2195/patchdesk/issues/348)) replaced the warning with saved ticks: they now survive tab switches, leaving the Review, and restarts, and the "not saved" text is removed.
- **Page:** [Analysis](review-workbench/analysis.md#leave-unchanged).

### UX-11: Walkthrough `j` and `k` run opposite to the Vim convention

- **Screen:** Walkthrough reader.
- **What the maintainer does:** Presses `j` to go to the next section, as in Vim and many readers.
- **What they see:** `j` moves to the previous section and `k` to the next, matching Left and Right.
- **Why it hurts:** Maintainers with Vim habits move the wrong way on the first press, every time.
- **Suggested improvement:** Treat the direction as a bug and swap the keys so `j` moves forward, updating the test that asserts the current direction; [#200](https://github.com/kwanpham2195/patchdesk/issues/200) owns the details.
- **Severity:** low. Raised from source; not reachable live.
- **Disposition:** named follow-up.
- **Issue:** [#200](https://github.com/kwanpham2195/patchdesk/issues/200)
- **Status:** fixed by `5b74ffd2`: `j` moves to the next section and `k` to the previous. Read from source at `737c515c`, not observed live.
- **Page:** [Walkthrough](review-workbench/walkthrough.md#begin-an-action).

### UX-12: The inline-discussion notice does not say what failed

- **Screen:** Walkthrough reader, on a Walkthrough that cannot show inline conversation threads.
- **What the maintainer does:** Reads a section expecting its threads.
- **What they see:** "Inline discussion is unavailable or incomplete. Refresh GitHub state to check for replies." for every cause: an outdated Walkthrough, a Review that is not Fresh, or a conversation that has not finished loading.
- **Why it hurts:** Refresh helps only some of those causes, so the maintainer may refresh repeatedly with no change.
- **Suggested improvement:** Name the failing condition, for example "This Walkthrough is for an older revision", and offer Refresh only when it can help.
- **Severity:** low. Raised from source; not reachable live.
- **Disposition:** named follow-up.
- **Issue:** [#201](https://github.com/kwanpham2195/patchdesk/issues/201)
- **Status:** fixed by `6a0cbeb7`: an outdated Walkthrough now says to regenerate it rather than to refresh. Read from source at `737c515c`, not observed live. The two sentences were later shortened to "Older revision; regenerate to see replies." and "Discussion unavailable; refresh to check."
- **Page:** [Walkthrough](review-workbench/walkthrough.md#arrive).

### UX-13: The open Review's Visited row does nothing on Enter

- **Screen:** Any Review workbench with the Visited pull requests column expanded.
- **What the maintainer does:** Tabs to the row of the Review on screen and presses Enter.
- **What they see:** The highlighted row keeps its focus ring and nothing happens.
- **Why it hurts:** The live pass read the silence as a dead end, since other inert controls in the app look disabled.
- **Suggested improvement:** The pass suggested removing the row from the Tab order or adding a "you are here" mark.
- **Severity:** low.
- **Disposition:** rejected with evidence. The row is where navigation would land, so doing nothing is the design: `src/renderer/src/components/visited-pull-requests.tsx:240-244` marks it as the current page and disabled for assistive technology while keeping it focusable, and `tests/renderer/visited-pull-requests.ui.test.tsx` asserts that. The row is already highlighted, and the Tab cost is addressed by UX-01.
- **Page:** [Visited pull requests](foundations/visited-pull-requests.md#leave-unchanged).

### UX-14: Skip to content leaves `#main-content` in the address

- **Screen:** Any screen.
- **What the maintainer does:** Activates Skip to content.
- **What they see:** Nothing visible; the renderer address gains `#main-content` and keeps it through later navigation.
- **Why it hurts:** The pass flagged a risk that code reading the address would pick up the stray value.
- **Suggested improvement:** Move focus without changing the address.
- **Severity:** low.
- **Disposition:** rejected with evidence. The packaged window has no address bar, and the only reader of the address, `src/renderer/src/app.tsx:118-120`, compares it with the fixture route names in `src/renderer/src/flows/fixture-routes.ts:34-36`, which do not include `#main-content`.
- **Page:** [Keyboard, focus, and desktop](cross-cutting/keyboard-focus-and-desktop.md#edge-cases).

### UX-15: The Merge conflicts notice asks for a push Patchdesk cannot make

- **Screen:** Review workbench, Diff tab, on an open pull request that conflicts with its base branch.
- **What the maintainer does:** Reads the notice above the diff.
- **What they see:** An instruction to resolve the conflicts in their own local checkout and push the head branch, in an app with no push control.
- **Why it hurts:** A scout expected the instruction to send maintainers looking for a push action.
- **Suggested improvement:** None needed.
- **Severity:** low.
- **Disposition:** rejected with evidence. The live pass on #113 read the notice as clearly describing work outside Patchdesk: it says "in your own local checkout" and names both branches.
- **Page:** [Files, diff, commits, and navigation](review-workbench/files-diff-and-navigation.md#edge-cases).

### UX-16: Insights opens on an empty Brief beside an Overview that repeats the tab strip

- **Screen:** Review workbench, Insights tab, on a Review with only an Analysis (#345 on 2026-09-24).
- **What the maintainer does:** Opens Insights to read the Analysis.
- **What they see:** Brief's "No brief yet" empty state, and an Overview tab whose cards repeat the status badges on the tab strip and whose Scope card repeats the header gauge and the Diff toolbar Scope picker.
- **Why it hurts:** Every open costs a click to reach the only Insight with content, and the strip has one more tab to scan.
- **Suggested improvement:** Remove Overview and land on the first Insight with a retained result.
- **Severity:** low.
- **Disposition:** fix now, [#350](https://github.com/kwanpham2195/patchdesk/issues/350).
- **Status:** fixed by the #350 change: the strip reads Brief, Walkthrough, Analysis, and Insights opens on the first of them with a retained result, or on Brief when none has one. A restored Insight still wins.
- **Page:** [Brief](review-workbench/brief.md#arrive).

### UX-17: The Review details inspector repeats the workbench's Insight controls

- **Screen:** Pull requests, Review details inspector, on #347 on 2026-09-24.
- **What the maintainer does:** Selects a row to decide whether to open it.
- **What they see:** "Analysis · Ready" beside a Request Analysis button, with Request Brief and Request Walkthrough below it, and an icon-only chevron toggle at the end of the filter bar with no tooltip.
- **Why it hurts:** The inspector should answer "what is this pull request and should I open it" with one action; three run buttons compete with Open and start runs away from where their results are read.
- **Suggested improvement:** Remove the Request buttons and keep the chips read-only. Give the inspector toggle a panel icon and a tooltip matching its accessible name, as UX-07 did for the titlebar toggle.
- **Severity:** low.
- **Disposition:** fix now, [#351](https://github.com/kwanpham2195/patchdesk/issues/351).
- **Status:** fixed by the #351 change: the inspector shows its status, facts, read-only Insight chips, Watch on an open row, and Open. The toggle shows a panel icon and a tooltip.
- **Page:** [The repository listing](pull-requests/repository-listing.md#the-simple-case).

### UX-18: The Review header changes shape by pull request state

- **Screen:** Review workbench header, on merged #347, open #345, and Insights on merged or closed Reviews, on 2026-09-24.
- **What the maintainer does:** Opens Reviews in different states and reads the header and Insights.
- **What they see:** On #347 the chips sit beside the title; on #345 they wrap below it and the refresh button moves. A merged Review shows both a "Merged on GitHub." banner and a "Merge · Merged" chip. The meta line reads "Current · refreshed 7 h ago" and Analysis reads "Current · retained 7 h ago". Brief shows a large disabled "Generate brief" under the line explaining that Insights cannot be generated.
- **Why it hurts:** Controls move between Reviews, the terminal state is said twice, "Current" and "retained" are internal words, and a button that can never work draws the eye.
- **Suggested improvement:** One header layout, the terminal state stated once, plain freshness words, and no Generate button on a merged or closed Review.
- **Severity:** low.
- **Disposition:** fix now, [#361](https://github.com/kwanpham2195/patchdesk/issues/361).
- **Status:** fixed by the #361 change: chips always sit on their own row under the title, the banner is gone because the Merge chip already states the outcome and opens PR overview, the meta line reads "Up to date with GitHub · checked 7 h ago", Insight headers read "Generated 7 h ago", and the Generate button is not drawn on a merged or closed Review while the explanation stays.
- **Page:** [Files, diff, commits, and navigation](review-workbench/files-diff-and-navigation.md#arrive).

### UX-19: The Pull requests screen spends space on empty and unlabeled things

- **Screen:** Pull requests, Open filter, with the Visited column expanded, on 2026-09-24.
- **What the maintainer does:** Reads a three-row Open list and the Visited column.
- **What they see:** The header shows a "GitHub: Aged" chip beside "Updated 26 minutes ago". The Labels column is empty on every row but takes about 15% of the width while author names are cut to "kwanpham21…". Previous, Next, and Rows per page show under three rows. A Visited row reads "#347 · 28m" and "Merged · seen 7h": two times with nothing saying which is which.
- **Why it hurts:** "Aged" is an internal word that needs a second line to explain it, empty columns squeeze the ones with content, and controls that cannot do anything draw the eye. Two unlabeled times for two different facts invite the wrong reading.
- **Suggested improvement:** Show the age in the chip, hide columns and page controls that have nothing to show, and label both Visited times.
- **Severity:** low.
- **Disposition:** fix now, [#363](https://github.com/kwanpham2195/patchdesk/issues/363).
- **Status:** fixed by the #363 change: the chip reads "GitHub: checked 26 min ago" and stays the Refresh control with its change dot, a column with no values on the page is hidden and Author gets the Labels width, page controls hide on a short single page, and Visited rows read "#347 · opened 28m" and "merged, seen 7h".
- **Page:** [The repository listing](pull-requests/repository-listing.md#arrive).

Drafted from the 2026-09-14 live passes at `5fe7df3b` and the independent review; source citations rechecked against application commit `737c515c`.
