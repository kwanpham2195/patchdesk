# Verification unblocking notes

A blocked checklist row means the full expected result was not observed. It does not mean Patchdesk failed. Keep a partly observed row blocked until its remaining behavior is checked. Automated and browser tests support a fix but do not replace the required desktop check. Do not run merge scenarios unless the maintainer changes the no-merge instruction.

## Conditions needed for blocked checks

Use separate fixtures for these checks. Do not combine them with an ordinary pass.

- `LIST-02-B`: a Fresh, passing, mergeable pull request with a matching Review. Check its single Open action.
- `DISC-01-D`: a failing workspace root beside a readable root.
- `FOCUS-01`: a Review with a Reply textarea. Check the shortcut while that textarea has focus. The automated regression does not replace this desktop check.
- `DIFF-01-A` through `DIFF-01-E`: file, hunk, and unresolved-thread targets for the keyboard matrix.
- `INLINE-01-D`: an existing thread that can be resolved.
- Other blocked rows: controlled timing, dependency failure, interrupted or outcome-unknown writes, corrupt or aged durable state, native close and quit, large pagination, provider-unavailable replacement, and merge execution.

The ordinary pass provides baseline evidence for rows not listed here. Check each row's required condition before changing its result.

## Safety limit

The previous isolated pass made no GitHub write, provider run, merge, or cleanup. Keep future verification within its approved write scope. A read-shaped command blocked by a fail-closed `gh` wrapper is not an application write attempt.

Baseline source: application commit `3100615`. Checklist results, not this note, record current pass, fail, or blocked status.
