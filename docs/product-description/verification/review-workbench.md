# Verification: Review workbench

How to run this file: use a disposable workspace profile, a readable pull request with a prepared local checkout, and a second disposable pull request when testing revision changes. Start each document with a clean Review session and no pending GitHub write. Rows marked `write` require explicit permission and a cleanup plan; rows marked `destructive` are not run without owner approval. Use real mouse or keyboard input in the macOS app; a native menu or close/quit row requires the actual desktop command, not a DOM equivalent.

## review-workbench/conversation-and-metadata.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CONV-01 | P1 | mouse, write | Direct conversation actions and pending-review comments have separate paths: a reply or edit writes the addressed GitHub thread, while Add to review changes the pending review only. ([Begin an action](../review-workbench/conversation-and-metadata.md#begin-an-action)). | Use a Fresh open Review with one existing thread and a writable pending review; no other Review write is running. | 1. Open Conversation and reply to the existing thread with disposable text.<br>2. Wait for confirmation.<br>3. Open Diff and add one separate inline comment to the pending review.<br>4. Inspect both projections. | The reply appears in its GitHub thread after its receipt; the inline comment appears in the pending review and is not mistaken for a published thread reply. | blocked — no prepared writable Review; GitHub writes were not authorized. |
| CONV-02 | P1 | offline | A confirmed conversation write remains confirmed when a later read-back fails, while an outcome-unknown write pauses further GitHub writes for recovery. ([Settle](../review-workbench/conversation-and-metadata.md#settle)). | Use a disposable writable Review and a controlled network failure immediately after submission for one action. | 1. Submit one disposable reply with the dependency available.<br>2. Make the subsequent observation unavailable.<br>3. Inspect the thread and recovery feedback.<br>4. Attempt a second GitHub write without recovery. | A confirmed receipt is retained even if observation fails; an uncertain result shows recovery-required and the second write is blocked until Check GitHub status or manual inspection settles it. | blocked — no prepared writable Review or controlled post-submission failure. |

Not checkable by hand:

- Whether every malformed remote thread field is rejected internally; use the matching service fixtures for parser coverage.

## review-workbench/files-diff-and-navigation.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DIFF-01 | P1 | keyboard | File, hunk, and unresolved-comment shortcuts move to the exact next target, stop at boundaries, and do not fire while an editor or dialog has focus. ([Settle](../review-workbench/files-diff-and-navigation.md#settle)). | Use a Review with at least two files, two hunks, one unresolved thread, and an open inline editor. | 1. Focus the Diff surface and press the documented next-target shortcut repeatedly.<br>2. Press it at the last target.<br>3. Focus the editor and press the same shortcut.<br>4. Close the editor and use the previous-target shortcut at the first target. | Focus/scroll moves to each exact target; the last and first boundaries do not wrap; text is not altered and navigation does not fire while the editor owns focus. | blocked — no represented Review with files, hunks, and unresolved threads. |
| DIFF-02 | P1 | mouse, offline | A failed file or commit load keeps the represented full Review available and never replaces it with an incomplete patch. ([While the action runs](../review-workbench/files-diff-and-navigation.md#while-the-action-runs)). | Use a Review with a valid full patch and a selectable file or commit; make the selected hydration request fail. | 1. Open the full Diff.<br>2. Select the target file or commit.<br>3. Trigger the controlled local or network failure.<br>4. Observe the main pane and return control. | The selected target shows a bounded error or plain-text fallback; the full represented patch remains available and no stale response from a previous file replaces the current selection. | blocked — no represented full patch or controlled hydration failure. |

Not checkable by hand:

- Whether all old-generation hydration promises are dropped at the internal boundary; this needs generation-focused tests.

## review-workbench/inline-conversations.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| INLINE-01 | P1 | mouse, write | An inline comment draft is local until explicit Add comment, and a reply or resolve action is distinct from adding a new pending comment. ([Begin an action](../review-workbench/inline-conversations.md#begin-an-action)). | Use a Fresh open Review with one commentable changed line and one existing open thread. | 1. Open an inline comment editor and type disposable text.<br>2. Close it without submitting.<br>3. Reopen and Add comment.<br>4. Reply to the existing thread, then resolve it. | Closing the draft creates no GitHub change; Add comment creates the pending-review comment; Reply and Resolve operate on the existing thread and show their own confirmed states. | blocked — no commentable represented Review; GitHub writes were not authorized. |
| INLINE-02 | P1 | keyboard, write | A non-empty inline draft triggers the dirty guard, and keyboard submission admits one action while preserving the draft after deterministic failure. ([While the action runs](../review-workbench/inline-conversations.md#while-the-action-runs)). | Use a Fresh Review with an inline editor focused and a controlled permission failure. | 1. Type a non-blank comment.<br>2. Press the Review navigation shortcut.<br>3. Choose Cancel in the leave guard.<br>4. Submit with the keyboard.<br>5. Observe the failed action. | Navigation is blocked until the draft is kept, discarded, or the leave is cancelled; one submit is sent; after rejection the draft and bounded error remain retryable. | blocked — no inline editor or controlled permission failure. |

Not checkable by hand:

- Exact line-anchor validation for every diff shape requires the domain and matching tests.

## review-workbench/pending-review-and-finish.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PENDING-01 | P1 | mouse, write | Finish review reads the pending-review projection, keeps Comment selected by default, and submits only after an explicit outcome choice. ([Begin an action](../review-workbench/pending-review-and-finish.md#begin-an-action)). | Use a Fresh open Review with one pending comment and no active write. | 1. Open Finish review.<br>2. Inspect the selected outcome and summary field.<br>3. Enter a disposable summary.<br>4. Choose Request changes or Approve and submit once.<br>5. Wait for the receipt. | The modal starts with Comment and does not submit on open; the chosen outcome and body are sent once; confirmed state is shown only after the receipt. | blocked — no pending Review fixture; GitHub writes were not authorized. |
| PENDING-02 | P1 | mouse, write | An outcome-unknown Finish review blocks another submission and offers Check GitHub status; it does not optimistically publish the review. ([Settle](../review-workbench/pending-review-and-finish.md#settle)). | Use a disposable writable Review and make the response unavailable after Finish review submission. | 1. Submit a disposable review.<br>2. Interrupt the response after the request leaves Patchdesk.<br>3. Inspect the pending-review banner.<br>4. Press Finish review again.<br>5. Use Check GitHub status only when safe. | The state says the outcome is unknown or recovery is required; a second submit is disabled; recovery reads GitHub and never sends the same review again. | blocked — no writable Review or controlled outcome-unknown response. |

Not checkable by hand:

- Whether every durable receipt is fsynced before projection; use persistence tests for crash-boundary evidence.

## review-workbench/merge.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MERGE-01 | P1 | mouse, write | Merge is enabled only for the represented Fresh revision with required checks and any warnings explicitly acknowledged. ([Begin an action](../review-workbench/merge.md#begin-an-action)). | Use an open pull request with a Fresh represented head, passing required checks, merge permission, and one warning requiring acknowledgement. | 1. Open PR overview from Merge status.<br>2. Inspect readiness and method choices.<br>3. Try Merge before acknowledging the warning.<br>4. Acknowledge the warning and choose a method.<br>5. Press Merge once. | Before acknowledgement the command is blocked; after acknowledgement the selected method and exact warning set are visible; submission enters Merging and disables duplicate controls. | blocked — no Fresh merge-capable disposable pull request; merge was not authorized. |
| MERGE-02 | P1 | offline, write | A merge outcome that is not confirmed is non-retryable until recovery, and Check GitHub status performs a read without issuing another merge. ([Settle](../review-workbench/merge.md#settle)). | Use a disposable merge-capable pull request and interrupt the response after GitHub may have received the merge. | 1. Press Merge once.<br>2. Make the response unavailable.<br>3. Inspect the Merge not confirmed or recovery-required state.<br>4. Press Check GitHub status.<br>5. Inspect the network/log evidence and controls. | The UI does not offer another Merge mutation before recovery; Check GitHub status only reads; a confirmed terminal result shows Merged, otherwise the non-retryable recovery warning remains. | blocked — no merge-capable disposable pull request or controlled uncertain response. |
| MERGE-03 | P1 | macOS window, keyboard | Closing the window, quitting Patchdesk, or switching profile while a merge is pending cannot silently discard the write state or switch the Review identity. ([Cancel and interrupt](../review-workbench/merge.md#cancel-and-interrupt)). | Use a disposable Review with a controlled long-running merge request and no other active write. | 1. Start Merge.<br>2. Attempt to switch profile.<br>3. Attempt the native window close and then quit command.<br>4. Reopen Patchdesk and return to the Review. | While the write is pending, navigation/close behavior is explicit; after restart the same Review restores Merged or recovery-required state, never a fresh enabled Merge based on stale UI. | blocked — requires a controlled pending merge and native macOS close/quit. |

Not checkable by hand:

- Whether GitHub's server-side compare-and-swap rejects every mismatched head/base pair; use merge route tests for exhaustive combinations.

Verified against Patchdesk application source commit `3100615`.
