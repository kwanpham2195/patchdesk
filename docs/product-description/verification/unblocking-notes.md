# Verification unblocking notes

These notes defined the ordinary verification continuation after the first 2026-08-31 runs and now record its outcome. They separate missing test conditions from product problems so a blocked row is not mistaken for a bug.

The current atomic checklist has 85 rows: 35 pass, 4 fail, and 46 blocked. All 85 IDs are unique. Ten compound blocked rows became 30 atomic rows, a net increase of 20. The cross-cutting duplicate `LOG-01` became `LOG-03`; that rename did not change the row count. The ordinary continuation promoted only complete live observations and found no new fail.

## Status rules

- `blocked` means the complete expected result was not observed. It does not mean the product failed.
- A partially observed row stays blocked until its remaining behavior is checked.
- A UI clarity candidate becomes a bug only after a live result contradicts the product requirement.
- Seed retained Insight artifacts when their shape matters. Do not depend on a provider generating a Finding count or section count by chance.
- Keep every merge scenario excluded unless the maintainer changes the no-merge instruction.

## Ordinary pass scope and outcome

The continuation used one isolated profile and excluded rare failure, recovery, retention, interrupted restart, and merge scenarios. Its planned scope covered 32 atomic blocked rows.

Planned read-only or local checks:

- `NAV-01-A`, `NAV-01-B`: Settings overlay behavior and focus return.
- `FIRST-01-A`, `FIRST-01-B`, `FIRST-01-C`: Git, GitHub CLI, and authentication status.
- `DISC-01-A`, `DISC-01-B`, `DISC-01-C`, `DISC-02`: saved-root discovery, watched rows, unsaved-root guidance, and explicit watchlist confirmation.
- `REPO-01-A`, `REPO-01-B`, `REPO-01-C`, `REPO-02`: one-repository picker, saved selection, fallback, and repository switching.
- `FILTER-01`: ordinary filter combinations and page reset.
- `LIST-01`, `LIST-02-A`, `LIST-02-B`: row presentation, terminal-row action, and ready-to-merge recommendation.
- `DIFF-01-A`, `DIFF-01-B`, `DIFF-01-C`, `DIFF-01-D`, `DIFF-01-E`: file, hunk, and thread navigation, boundaries, and focus suppression.
- `WALK-01-A`, `WALK-02-A`: multi-section navigation, closing, reopening, and focus restoration.
- `INLINE-01-A`: local inline-draft discard without a write.
- `ANALYSIS-01-A`, `ANALYSIS-01-B`, `ANALYSIS-01-C`: Finding reading, blank-dismissal rejection, and local dismissal without a GitHub write.

Planned checks requiring approved disposable writes:

- `INLINE-01-B`, `INLINE-01-C`, `INLINE-01-D`: Add to review, Reply, and Resolve.
- `ANALYSIS-01-D`: Add to review from a seeded Analysis artifact.

The fixture included multiple watched repositories. Complete evidence promoted `NAV-01-A`, `NAV-01-B`, `FIRST-01-A`, `FIRST-01-B`, `FIRST-01-C`, `DISC-01-A`, `DISC-01-B`, `DISC-01-C`, `DISC-02`, `REPO-01-A`, `REPO-01-B`, `REPO-01-C`, `LIST-02-A`, `ANALYSIS-01-A`, `ANALYSIS-01-B`, and `ANALYSIS-01-C`. A separate deterministic retained-artifact check also promoted `WALK-02-B`.

The other planned rows remain blocked because their complete conditions were unavailable or their keyboard/focus behavior stayed inconclusive. No GitHub write was approved, so `INLINE-01-B`, `INLINE-01-C`, `INLINE-01-D`, and `ANALYSIS-01-D` were not run. Partial observations did not change results for `REPO-02`, `FILTER-01`, `LIST-01`, `LIST-02-B`, `DIFF-01-A`, `DIFF-01-B`, `DIFF-01-C`, `DIFF-01-E`, `INLINE-01-A`, `WALK-01-A`, or `WALK-02-A`.

## Completed checklist corrections

The checklist now records one observable behavior per atomic row. The completed split families are:

- `NAV-01` to `NAV-01-A` and `NAV-01-B`.
- `FIRST-01` to `FIRST-01-A`, `FIRST-01-B`, and `FIRST-01-C`.
- `DISC-01` to `DISC-01-A`, `DISC-01-B`, `DISC-01-C`, and `DISC-01-D`.
- `REPO-01` to `REPO-01-A`, `REPO-01-B`, and `REPO-01-C`.
- `LIST-02` to `LIST-02-A` and `LIST-02-B`.
- `DIFF-01` to `DIFF-01-A`, `DIFF-01-B`, `DIFF-01-C`, `DIFF-01-D`, and `DIFF-01-E`.
- `INLINE-01` to `INLINE-01-A`, `INLINE-01-B`, `INLINE-01-C`, and `INLINE-01-D`.
- `ANALYSIS-01` to `ANALYSIS-01-A`, `ANALYSIS-01-B`, `ANALYSIS-01-C`, and `ANALYSIS-01-D`.
- `WALK-01` to `WALK-01-A`; the undocumented text-control claim was removed.
- `WALK-02` to `WALK-02-A` and `WALK-02-B`.

The cross-cutting duplicate `LOG-01` is now `LOG-03`. `ANALYSIS-01-A` through `ANALYSIS-01-D` require a seeded Analysis with mapped Findings. `WALK-01-A`, `WALK-02-A`, and `WALK-02-B` require a seeded Walkthrough with at least three sections. The atomic rows retain the prior blocked evidence conservatively; the split did not create new verification results.

The ordinary pass also corrected the Required condition for `NAV-01-A`, `NAV-01-B`, `DISC-02`, `REPO-01-A`, `REPO-01-B`, `REPO-01-C`, and `WALK-02-B` from keyboard-specific or native-window input to `mouse`. Their claims concern visible controls, restored state, or renderer reload rather than keyboard routing, and their pass evidence used real visible pointer actions.

## UI clarity candidates

These changes would make current states understandable even when the underlying operation cannot proceed:

- First run should show Git, GitHub CLI, and authentication as separate statuses backed by the same probe result used in Settings. The two screens should not disagree.
- Discovery should show `Found repositories`, `None found`, or `Scan failed` for each saved root. A failed scan must not look like an empty root.
- Pull requests should not show settled rows while the Repository picker says `Select a repository`. The picker and rows should settle together, or the screen should show `Loading repository scope`.
- A row that has both a matching Review and merge readiness should expose both states instead of silently hiding one recommendation.
- Diff navigation should visibly identify the active file, hunk, or thread. Reaching the first or last target should have a visible boundary state.
- Resolve should translate GitHub permission failures into a specific message and keep the thread unchanged. Hide or disable Resolve when permission can be known before submission.
- Analysis should say `No findings` and explain that there is nothing to add or dismiss.
- Walkthrough should show its section count and omit unavailable section navigation when it contains one section.
- Review diagnostics should show `No Review activity has been recorded` instead of an unexplained empty panel.
- Opening and refresh errors should remain attached to their profile, repository, row, or Review identity. An error from an old scope should not appear on a new screen.

`PROFILE-02` already confirms the unsettled Repository picker as `B-07`. The other clarity items remain requirements or investigation targets until a focused live check establishes a mismatch.

## Fixture work

Build the next fixture outside the application checkout and keep it under an isolated temporary root. It should provide:

- One saved profile with two watched disposable repositories.
- Open, draft, merged, reviewed, unreviewed, and ready-to-merge rows with labels and checks.
- One existing open thread that the active repository account can resolve.
- A retained Analysis with at least two mapped Findings. Both Findings start open with no preseeded dismissals so `ANALYSIS-01-B` and `ANALYSIS-01-C` can exercise dismissal. The Finding used for `ANALYSIS-01-D` has a nonempty suggested comment so the check can verify the projected comment body.
- A retained Walkthrough with at least three sections.
- Real keyboard and pointer input for focus and shortcut checks.

Do not spend provider usage to obtain a particular artifact shape. Do not change application source solely to stage the fixture.

## Deferred work

Under the current atomic structure, 30 rows remain blocked by the deferred fixture boundaries. They require one or more of these conditions:

- Multiple-profile behavior.
- Controlled timing or deterministic dependency failure, including a per-root scan failure.
- Interrupted or outcome-unknown GitHub writes.
- Corrupt, interrupted, quarantined, or aged durable state.
- Native close, quit, or interrupted process-restart recovery.
- Large pagination fixtures.
- Provider-unavailable replacement behavior.
- Merge execution.

Treat these as separate fixture projects. Do not mix them into the ordinary pass.

Verified against Patchdesk application source commit `3100615`.
