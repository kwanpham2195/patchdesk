# Changelog

## Unreleased

- Added **Author** and **Base branch** to More filters on Pull requests. Both are text fields: type a GitHub login (or `@me`) or a branch name and apply it with Enter or by leaving the field. Each active value shows as a chip you can clear on its own, **Clear all filters** now clears all four More filters fields at once, and both choices persist with the profile.
- Changed a Pull requests row so a click only selects it and shows it in **Review details**; open it from the row title, a double-click, Enter, or the single **Open** button. The inspector now leads with the review status — Not reviewed, Current, Updates available, or Merged — and shows a Scope legend where a saved review supplies one. The separate merge-readiness action is gone; merge readiness is still in PR overview inside the review. The pull request icon is now coloured by state: open, draft, or merged.
- Pull requests loads fresh on first open after this release; rows cached by 0.0.1 are read again from GitHub once.
- Added newer models to choose from for Insight runs, among them Grok 4.6, Gemini 3.7 Flash, GLM-5.3, and Claude Opus 5 Fast on Vercel AI Gateway.
- Some providers renamed their model ids: Cloudflare AI Gateway's Anthropic models now separate the version with a dot (`claude-sonnet-4.5` rather than `claude-sonnet-4-5`), and Vercel AI Gateway moved its xAI models from `xai/` to `spacexai/`. A **Default model** saved under an old id no longer matches and needs picking again in Settings.
- Insight runs now talk to the model through Pi directly instead of through a framework layered over it, so Patchdesk bundles a smaller runtime with the app, and Analysis, Walkthrough, and Brief no longer offer the model two framework tools none of them used. A transient provider error, such as a rate limit or a server hiccup, is still retried before a run is reported as failed.
- Renamed the Insight provider formerly labelled **Pi** to **API key**, because Patchdesk bundles the model client and all you supply is a provider key; the models on offer and a saved **Default model** are unchanged.
- Added opening a pull request by pasting its GitHub link on **Pull requests**: paste anywhere outside a text field and Patchdesk opens that pull request, whether or not it is in the current listing. A link to a repository you do not watch is refused with a message instead, and pasted text that is not a pull request link is left alone.

## 0.0.1 - 2026-09-02

- Added More filters to Pull requests so you can filter by Review state or Check status; active selections remain visible as chips, persist with the profile, and can be cleared individually or together.
- Made hunk citation chips in Brief open a preview of the cited hunk as a rendered diff; a hunk too large to preview keeps a plain chip, and so does a Brief retained before this change.
- Added a **Flow** block to Brief: up to three diff-styled views, one per kind — call_tree, control_flow, component — with each step marked added, removed, or unchanged and drawn with tree guides, hunk citations on changed steps where the patch shows them, and a per-view Copy as diff action; a Brief retained before this change has no Flow.
- Removed the Goal, Assumptions, and Description vs diff blocks from Brief, and the Shape block's contract hunk; Brief now shows Flow, Shape, Start here, and Reach, and Briefs retained by earlier releases still open without those blocks.
- Fixed Reach reporting a changed file as untested when its test file uses a different separator or sits beside it, made the surface flags recognise Go-style paths (pkg/…/v1, internal/adapter, repo, cmd), and stopped counting a mention in a Markdown, text, or docs/ file as a caller.
- Fixed Copy as diff in Brief and the diff copy button, which the desktop app's permission policy had silently blocked.
- Fixed release installs when the machine's pnpm peer setting differs from the locked Flue runtime.
- Reduced the macOS download and installed app size, and added release checks to prevent package-size regressions.
- Moved the review navigator toggle into the diff header, keeping the file path aligned when the navigator opens or closes.
- Improved motion across dialogs, popovers, drawers, disclosures, busy progress, Insight completions, and Walkthrough focus transitions, while keeping the command palette, tooltips, and trigger-aligned selects instant.
- Protected Settings profile edits when creating a new profile, showed field-specific validation before saving, and kept the Repository picker in sync after a profile switch.
- Improved workspace discovery by grouping repositories at directory boundaries and preserving usable ready and watched repositories when one workspace root fails.
- Made Pull requests and Review actions more reliable with separate Open Review and merge-readiness actions, profile-scoped opening errors, text-editor shortcut protection, and clear Resolve permission guidance.
- Clarified reading surfaces with Analysis and Review activity empty states, Walkthrough section counts and boundary controls, and visible Diff file, hunk, and thread targets and boundaries.
- Patchdesk opened from the Dock or Finder now finds the provider keys you exported in your shell profile and the `codex` you installed with Homebrew or npm; it reads your login shell's PATH and provider keys once at startup, so `launchctl setenv` and launching from a terminal are no longer needed.
- Renamed the Maintainer inbox to **Pull requests** everywhere it is shown: the navigation, the page heading, the window title, and the Navigate palette.
- Patchdesk draws its own window header on macOS: the native title bar is gone and the traffic lights sit inside the app header, as in other desktop apps. In full screen, where macOS hides the lights, the header drops the gap it keeps for them and the Patchdesk name starts at the left edge again.
- Fixed a downloaded Patchdesk.app opening with "is damaged and can't be opened" and no way past it; the unsigned build now carries an intact ad-hoc signature, so macOS offers Open Anyway (or right-click then Open) instead, and `xattr -cr` is only a fallback.
- Patchdesk is now distributed as a `.dmg` you open and drag onto Applications, built and attached to a draft GitHub release when a version tag is pushed; the build is signed and notarized with Apple when the maintainer's signing secrets are configured, and otherwise stays the unsigned build that needs `xattr -cr` before first launch.
- Added **Brief**, a third Insight beside Analysis and Walkthrough: a short, cited answer to what a change is for, in five blocks — Goal with its Assumptions, Description vs diff, Shape, Reach, and Start here. Every model sentence must cite a diff hunk, a description paragraph, or a commit; an uncited sentence is shown as an Assumption, a Brief with no cited sentence at all is rejected, and every count comes from Patchdesk rather than from the model.
- Added a **Scope** gauge that buckets a pull request's changed files into core, tests, generated, docs, and config with added and removed lines per bucket, shown in the review header, as a card in the Insights tab, and on a Pull requests row already reviewed at its current head.
- Fixed the **Scope** gauge counting a Go, Python, Java, Kotlin, Ruby, Rust, PHP, C#, Swift, or Elixir test file as core code; a file named `refresh_cache_test.go`, `test_repository.py`, or `RepositoryTest.java` now lands in Tests, and the Brief's Reach block no longer lists those same test files as changed code that no test covers.
- Fixed large diffs stuttering while scrolling: syntax colouring runs in the worker pool again, and the diff theme picker now reaches that pool, so changing the theme recolours the diff without dropping back to the main thread.
- Fixed the Brief flagging a description line about a build, test run, benchmark, lint, CI, screenshot, or manual check as description drift; only claims about what the code does count, and a hunk citation chip now shows the file name and hunk alias with the full path on hover.
- Fixed Analysis and Walkthrough runs through the Pi provider failing immediately with an invalid-input error in the packaged app; the packaged insight child had rejected every run since 2026-08-22, when review session ids gained a base-revision segment that the child's own copy of the pattern never learned.
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
