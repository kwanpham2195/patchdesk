# Verification unblocking notes

These notes record the 2026-08-31 ordinary pass and the later fix follow-up. They separate missing test conditions from product problems so a blocked row is not mistaken for a bug.

The current atomic checklist has 85 rows: 38 pass, 0 fail, and 47 blocked. All 85 IDs are unique. Ten compound blocked rows became 30 atomic rows, a net increase of 20. The cross-cutting duplicate `LOG-01` became `LOG-03`; that rename did not change the row count.

## Status rules

- `blocked` means the complete expected result was not observed. It does not mean the product failed.
- A partially observed row stays blocked until its remaining behavior is checked.
- Canonical automated or browser coverage supports a fix, but it does not replace a row's required live condition.
- Keep every merge scenario excluded unless the maintainer changes the no-merge instruction.

## Completed follow-up

All eight triage defects are fixed. The fix commits are `31284f3` (B-01), `8dce9e7` (B-02), `b66a0a9` (B-03), `8d372ab` (B-04), `c59d249` (B-05), `c49045d` (B-06), `c1ce7a2` (B-07), and `75fadec` (B-08).

The follow-up promoted these complete live observations:

- `SETUP-03`: malformed account, host, profile ID, and Label received field-associated validation before a profile request. Evidence: `/private/tmp/patchdesk-followup-verification-evidence/followup-b02-invalid.png` and `/private/tmp/patchdesk-followup-verification-evidence/followup-b02-invalid-read.txt`.
- `SETUP-04`: New profile showed Cancel, Save, and Discard changes; Cancel preserved the draft and Discard opened a blank draft. Evidence: `/private/tmp/patchdesk-followup-verification-evidence/followup-b01-guard.png`, `/private/tmp/patchdesk-followup-verification-evidence/followup-b01-cancel-preserved.png`, and `/private/tmp/patchdesk-followup-verification-evidence/followup-b01-discard-new.png`.
- `PROFILE-02`: A/B/A profile switching settled both the Repository picker and rows under each selected profile. Evidence: `/private/tmp/patchdesk-followup-verification-evidence/followup-b07-a-initial.png`, `/private/tmp/patchdesk-followup-verification-evidence/followup-b07-b-settled-2.png`, and `/private/tmp/patchdesk-followup-verification-evidence/followup-b07-a-return-settled.png`.

`FOCUS-01` changed from fail to blocked. The fixed shortcut has an exact automated Reply-textarea regression and supporting focused Settings-input evidence, but the precise Reply-textarea desktop scenario was not rerun.

The completed clarity changes are also supported by focused tests: the Pull requests row selects on click and opens from the title, a double-click, Enter, or the inspector's Open action; per-root discovery preserves ready and failed outcomes; Resolve explains permission failures; Analysis explains empty findings; Walkthrough clarifies section navigation; Review activity explains an empty history; and Diff navigation exposes its active target and boundaries. These are no longer unresolved candidate framing. Their exact manual fixtures remain blocked where the checklist requires one. The separate merge-readiness affordance on a Pull requests row was removed on 2026-09-02; `LIST-02-B` now checks the single Open action instead.

## Remaining fixture requirements

The ordinary pass still supplies the baseline evidence for the remaining rows. The next fixture must provide the conditions that no current desktop run supplied:

- A Fresh passing mergeable row with a matching Review for `LIST-02-B`.
- A controlled failing workspace root beside a readable root for `DISC-01-D`.
- A Review with the precise Reply textarea for the `FOCUS-01` desktop rerun.
- File, hunk, and unresolved-thread navigation targets for the exact `DIFF-01-A` through `DIFF-01-E` desktop matrix.
- An existing resolvable thread for a successful `INLINE-01-D` result.
- Controlled timing, dependency failure, interrupted or outcome-unknown writes, corrupt or aged durable state, native close/quit, large pagination, provider-unavailable replacement, and merge execution fixtures.

Treat these as separate fixture projects. Do not mix them into an ordinary pass.

## Follow-up safety record

The post-fix run used current `main`, isolated Electron and Patchdesk data, and evidence rooted at `/private/tmp/patchdesk-followup-verification-evidence`. No GitHub write, provider run, merge, or cleanup occurred. A fail-closed `gh` wrapper blocked two automatic read-shaped commands during Workspace discovery. Neither command reached GitHub or mutated remote state; they are not application write attempts.

The baseline source snapshot remains application commit `3100615`. These notes also record later fix commits, their canonical tests, and current-HEAD live evidence.
