# Verification: Insights and cross-cutting behavior

How to run this file: use a disposable profile and represented Review with retained Insight artifacts where a row needs them. Insight generation rows require an explicitly approved low-cost provider and model; fixed reader rows do not. Use read-only checks unless a row says `write` or `destructive`; cleanup rows require owner approval and are intentionally left unrun. Use the actual macOS window, real keyboard or mouse input, and the raw log only as evidence named by a row.

## review-workbench/brief.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BRIEF-01 | P1 | mouse, provider | A retained Brief remains readable when no Insight provider can start a replacement, and Regenerate does not erase it before success. ([While the action runs](../review-workbench/brief.md#while-the-action-runs)). | Use a Review with a retained Brief and disable the configured provider before opening Insights. | 1. Open Brief.<br>2. Read the retained result.<br>3. Choose Regenerate.<br>4. Observe provider-unavailable feedback.<br>5. Return to the Brief reader. | The retained Brief stays visible and revision-bound; the failed replacement is separate and retryable; no blank or newer unvalidated Brief replaces it. | — |
| BRIEF-02 | P1 | keyboard | Leaving and reopening a retained Brief preserves its revision-bound reader state without starting a provider. ([Leave unchanged](../review-workbench/brief.md#leave-unchanged)). | Use a retained Brief for a known represented revision with no provider run active. | 1. Open Brief and expand one evidence section.<br>2. Switch to Diff.<br>3. Return to Brief.<br>4. Reload the renderer and return to the same Review. | Reading and navigation do not start a run; the retained Brief remains tied to the represented revision and its saved artifact, with no unvalidated replacement. | — |

Not checkable by hand:

- Exact generated wording, model token usage, and provider process invocation are not observable product claims.

## review-workbench/analysis.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ANALYSIS-01 | P1 | mouse, write | Add to review sends a Finding only after explicit action, while Dismiss requires a non-blank reason and confirmation; reading a Finding does neither. ([Begin an action](../review-workbench/analysis.md#begin-an-action)). | Use a retained Analysis with one actionable Finding mapped to the represented diff and one Finding to dismiss. | 1. Read and expand both Findings without acting.<br>2. Open Dismiss for the second and try a blank reason.<br>3. Enter a disposable reason and confirm.<br>4. Add the first Finding to review.<br>5. Inspect pending-review state. | Reading and blank dismissal create no write; dismissal removes its action after confirmation; Add to review sends the original suggested comment and labels only the matching Finding pending review. | — |
| ANALYSIS-02 | P1 | offline, write | An uncertain Finding action locks pending-review mutation and does not mark the Finding published or dismissed without exact receipt evidence. ([Settle](../review-workbench/analysis.md#settle)). | Use a disposable writable Review and interrupt one Add to review response after submission. | 1. Add the Finding to review.<br>2. Make the response unavailable.<br>3. Inspect the Finding and pending-review controls.<br>4. Attempt another Finding action.<br>5. Recover only by Check GitHub status. | The Finding remains pending or recovery-required, not published; other GitHub writes are paused; recovery reads exact run/Finding/session/revision identity before changing the label. | — |

Not checkable by hand:

- Exact cumulative projection behavior under reverse completion needs the renderer and service concurrency tests.

## review-workbench/walkthrough.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WALK-01 | P1 | keyboard | Walkthrough navigation stops at first and last sections, and `j`/`k` are ignored when an editor has focus. ([Begin an action](../review-workbench/walkthrough.md#begin-an-action)). | Use a retained Walkthrough with at least three sections and a focused text control in one section. | 1. Open Walkthrough.<br>2. Press `j` and `k` through the first and last boundaries.<br>3. Focus the text control.<br>4. Press `j` and `k` again.<br>5. Press Escape. | Sections advance without wrapping; editor text is unchanged; Escape returns focus to the section heading or documented trigger without marking the section reviewed. | — |
| WALK-02 | P1 | macOS window, keyboard | Opening and closing the Walkthrough preserves the active section and restores focus to the remembered trigger without changing GitHub review state. ([Settle](../review-workbench/walkthrough.md#settle)). | Use a retained Walkthrough opened from a known Insights trigger with at least one unreviewed section. | 1. Open the Walkthrough from its trigger.<br>2. Move to a different section.<br>3. Press Escape or close the takeover.<br>4. Reopen it after renderer reload. | The takeover closes without a GitHub write; focus returns to the trigger or current heading as documented; the active section is restored only when still valid. | — |

Not checkable by hand:

- Exact virtualized hunk target polling and duplicate block-ID behavior need renderer tests.

## cross-cutting/write-safety-and-freshness.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SAFE-01 | P1 | mouse, write | A stale Review or active recovery lock prevents a GitHub write before submission and explains the reason instead of guessing. ([Begin an action](../cross-cutting/write-safety-and-freshness.md#begin-an-action)). | Use a writable Review, then make the represented head stale or leave an unresolved recovery operation before opening a write control. | 1. Open the write surface.<br>2. Trigger the stale or recovery condition.<br>3. Attempt the write once.<br>4. Inspect controls and recovery guidance. | No GitHub mutation is submitted; the control is blocked or recovery-required with the exact stale/lock reason; retry is offered only through the documented safe path. | — |
| SAFE-02 | P1 | offline, write | A confirmed write and an outcome-unknown write have different recovery states; only the unknown state locks further mutation. ([Settle](../cross-cutting/write-safety-and-freshness.md#settle)). | Use two disposable writes, one with a receipt and one with the response interrupted after submission. | 1. Complete the confirmed write.<br>2. Inspect the projection after read-back is unavailable.<br>3. Perform the second write and interrupt its response.<br>4. Compare banners and available controls. | The confirmed write remains confirmed; the unknown write is not relabeled success or failure, pauses mutation, and exposes Check GitHub status or manual recovery. | — |

Not checkable by hand:

- The exact ordering of durable intent, network submission, and fsync requires crash testing rather than a hand pass.

## cross-cutting/errors-and-recovery.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ERROR-01 | P1 | offline | Deterministic failure is retryable with bounded context, while an uncertain GitHub outcome is not retried automatically. ([Settle](../cross-cutting/errors-and-recovery.md#settle)). | Prepare one read or local-tool failure and one write whose response is interrupted after submission. | 1. Trigger the deterministic failure.<br>2. Inspect the error and Retry control.<br>3. Trigger the interrupted write.<br>4. Inspect recovery controls and any automatic requests. | The deterministic failure names the action and permits a bounded retry; the uncertain write says outcome unknown/recovery required and does not issue an automatic second mutation. | — |
| ERROR-02 | P1 | macOS window, keyboard | Renderer reload and app restart restore durable recovery state without restoring a transient form as if it were confirmed. ([Cancel and interrupt](../cross-cutting/errors-and-recovery.md#cancel-and-interrupt)). | Leave a disposable Review in recovery-required state and a separate non-empty transient editor. | 1. Reload the renderer.<br>2. Inspect the recovery banner.<br>3. Close and reopen the app.<br>4. Return to the Review and inspect the editor. | Recovery-required state remains visible and mutation stays locked; transient text is not presented as a confirmed write, and the app does not silently retry. | — |

Not checkable by hand:

- Crash-window persistence between intent and receipt needs a controlled process termination test.

## cross-cutting/local-storage-and-privacy.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PRIV-01 | P1 | destructive | Clear cache and Clear local review data have separate confirmations and do not claim to remove configuration, logs, or diagnostics. ([Begin an action](../cross-cutting/local-storage-and-privacy.md#begin-an-action)). | Use a disposable profile with saved settings, cached listing data, local Review data, and a visible log/diagnostic entry; obtain explicit owner approval before any cleanup. | 1. Open each cleanup action without confirming.<br>2. Read the confirmation scope.<br>3. Cancel both dialogs.<br>4. Do not confirm deletion in this drafting pass. | Each dialog names its own scope; cancel leaves settings, cache, local Review data, logs, and diagnostics unchanged. | — |
| PRIV-02 | P1 | destructive | A destructive cleanup confirmation is required before local data is removed and success reloads or closes affected surfaces. ([Settle](../cross-cutting/local-storage-and-privacy.md#settle)). | Use only a disposable profile and backed-up throwaway data with explicit owner approval. | 1. Start Clear cache.<br>2. Cancel once and verify data remains.<br>3. If approved, confirm and wait for settlement.<br>4. Inspect the resulting surface without deleting local review data. | No data is removed before confirmation; after an approved cache clear, the UI reports the bounded result and reloads affected cached surfaces without claiming local Review data was deleted. | — |

Not checkable by hand:

- Complete filesystem deletion order and recovery after interruption require storage-level tests; this pass intentionally does not perform cleanup.

## cross-cutting/keyboard-focus-and-desktop.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FOCUS-01 | P1 | keyboard | Keyboard navigation reaches the named control, visible focus stays in the active surface, and text-entry controls do not trigger global shortcuts. ([Begin an action](../cross-cutting/keyboard-focus-and-desktop.md#begin-an-action)). | Use a Review with a text editor, dialog, tab list, and a documented global shortcut. | 1. Tab through the surface.<br>2. Invoke the shortcut outside text entry.<br>3. Focus the editor and press the same key.<br>4. Close the dialog with Escape. | Focus moves through usable controls; the shortcut acts only outside text entry; editor text is unchanged; Escape closes the permitted layer and returns focus according to the owning document. | — |
| FOCUS-02 | P1 | macOS window, desktop menu | Native close and quit follow the same dirty or write-pending guard as in-app navigation and do not discard an unresolved write. ([Cancel and interrupt](../cross-cutting/keyboard-focus-and-desktop.md#cancel-and-interrupt)). | Use a non-empty draft, then repeat with a disposable Review write pending. | 1. Open the native close command.<br>2. Observe the guard and cancel it.<br>3. Repeat with the native quit command while the write is pending.<br>4. Reopen and inspect durable state. | The app asks for the documented Save/Discard/Cancel or write-pending decision; cancelling leaves state intact; reopening restores the draft/recovery boundary without pretending the write succeeded. | — |

Not checkable by hand:

- Screen-reader, touch, pen, and occluded-window behavior are outside the supported verification surface.

## settings/logs-and-diagnostics.md

The app log and Review diagnostics are separate evidence surfaces. The rows below verify their visible boundaries without treating raw logs as user-facing product content.

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LOG-01 | P1 | keyboard | The app log viewer can pause its tail and filter visible entries without exposing raw credentials, while Review diagnostics show only their stricter redacted activity projection. ([Settle](../settings/logs-and-diagnostics.md#settle)). | Use a disposable profile with safe test failures and a visible app log tail at `~/.local/share/patchdesk/logs/patchdesk.jsonl`. | 1. Open Settings Logs.<br>2. Pause the tail and apply a text filter.<br>3. Open Review diagnostics for the same safe failure.<br>4. Compare visible fields without opening raw credential material. | Pausing stops visible tail movement; filtering changes only the log view; both surfaces redact secrets, and Review diagnostics expose no broader raw payload than the app log viewer. | — |

Not checkable by hand:

- Exhaustive redaction of every future log field requires source and route coverage, not a single visible sample.

Verified against Patchdesk application source commit `3100615`.
