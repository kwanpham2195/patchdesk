# Verification: first run and Pull requests

How to run this file: use a disposable workspace profile and a read-only or disposable GitHub repository. Start with no watched repositories for first-run rows, then save one or more watched repositories for Pull requests rows. Restore the intended profile and repository between documents. `offline` means the required GitHub or local dependency is genuinely unavailable; do not treat a stale page or a DevTools toggle as proof of an in-flight failure. No write, merge, cleanup, or provider run is required unless a row explicitly names a separately approved condition.

## first-run/setup-checklist.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FIRST-01 | P1 | mouse | First-run probes report GitHub access and local-tool availability independently and do not log in or install anything. ([While the action runs](../first-run/setup-checklist.md#while-the-action-runs)). | Use a disposable profile with one dependency available and the other unavailable. | 1. Open the first-run Pull requests card.<br>2. Wait for both probes.<br>3. Repeat with the opposite dependency unavailable.<br>4. Inspect visible controls. | Each missing tool, authentication problem, or probe failure is named separately; no login, install, or unrelated write starts. | blocked — Git and GitHub CLI status were named separately without writes, but only one dependency configuration was exercised; Settings concurrently resolved an account while first run reported gh unavailable. |
| FIRST-02 | P1 | mouse | An empty watchlist is a successful empty inbox state and the first repository enters scope only through the explicit Workspace action. ([Edge cases](../first-run/setup-checklist.md#edge-cases)). | Use a disposable profile with valid GitHub access and no watched repositories. | 1. Open Pull requests.<br>2. Observe the empty state and network/log evidence if available.<br>3. Open Workspace and add one repository explicitly.<br>4. Return to Pull requests. | The empty state does not make a repository read; the repository appears only after the explicit watchlist action and then becomes the listing scope. | pass — the valid empty watchlist showed a successful empty inbox with no repository query; `kwanpham2195/patchdesk` entered scope only after its explicit Workspace watch action. Evidence: `/private/tmp/patchdesk-product-verification-first-02-empty-watchlist.png`, `/private/tmp/patchdesk-product-verification-first-02-watched.png`. |

Not checkable by hand:

- Whether a provider or local executable was never invoked internally; observe only the visible controls and safe logs.

## first-run/repository-discovery.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DISC-01 | P1 | mouse | Discovery scans only saved workspace roots, excludes already-watched repositories from suggestions, and preserves watched rows. ([While the action runs](../first-run/repository-discovery.md#while-the-action-runs)). | Use a disposable profile with one saved root containing two supported Git origins, one watched repository, and one unsaved root. | 1. Open Workspace discovery.<br>2. Scan the saved root.<br>3. Inspect suggestions and watched rows.<br>4. Add the unsaved root and scan without saving. | Already-watched identity is not suggested; its row remains visible; the unsaved root reports that it must be saved before scanning. | blocked — profile save failed, so the required saved-root and watched-repository discovery fixture could not be created through the UI. |
| DISC-02 | P1 | keyboard | Selecting a discovered repository changes only the watchlist after explicit confirmation; editing other profile fields preserves it. ([Settle](../first-run/repository-discovery.md#settle)). | Have one discovered candidate and one existing watched repository. | 1. Select the candidate checkbox.<br>2. Confirm the watchlist action.<br>3. Edit a profile field and save.<br>4. Reopen discovery. | The candidate is watched after confirmation, the existing watched row remains, and the watchlist survives unrelated profile edits. | blocked — no discovered candidate and saved watchlist fixture was available. |

Not checkable by hand:

- Complete Git-origin parsing across all supported URL forms; use the discovery test fixtures for exhaustive coverage.

## pull-requests/selected-repository.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REPO-01 | P1 | keyboard | A saved Selected repository is restored only while watched; otherwise the first watched repository is selected, and one watched repository still shows the picker. ([Arrive](../pull-requests/selected-repository.md#arrive)). | Use a profile with one watched repository, then two watched repositories and a saved selection. | 1. Open Pull requests in each setup.<br>2. Remove the saved repository from the watchlist in the two-repository setup.<br>3. Return to Pull requests. | The header shows the watched repository; a removed saved choice falls back to the first remaining one; exactly one watched repository still exposes its scope picker. | blocked — one watched repository restored and still showed the picker; two-repository selection removal and fallback were not available. |
| REPO-02 | P1 | mouse | Changing repository clears labels and pagination while preserving state, page size, and Awaiting review from you. ([Begin an action](../pull-requests/selected-repository.md#begin-an-action)). | Use two watched repositories with a non-default state, size, label, and page beyond the first. | 1. Set the filters and advance a page.<br>2. Choose the other repository.<br>3. Observe the filter bar and first response. | The new repository is requested from its first page with no old label; state, page size, and Awaiting review from you remain selected. | blocked — requires two watched repositories, labels, and pagination. |

Not checkable by hand:

- Exact renderer generation implementation; verify only that an older repository response cannot replace the newer scope.

## pull-requests/filters-pagination-and-refresh.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FILTER-01 | P1 | mouse | State, labels, Awaiting review from you, and page size are sent as one query and any search change clears pagination. ([Begin an action](../pull-requests/filters-pagination-and-refresh.md#begin-an-action)). | Use a repository with multiple open/merged pull requests, labels, and review requests. | 1. Choose Merged, a label, Awaiting review from you, and 50 rows.<br>2. Advance a page if available.<br>3. Change one filter.<br>4. Observe the new result. | The new result starts at page one for the changed query; the controls show the selected values and do not reuse the old page. | blocked — Merged, Awaiting review, and 50 rows were sent together, but the empty result had no label or second page to prove pagination reset. |
| FILTER-02 | P2 | keyboard | Previous and Next use opaque page tokens and preserve a bounded page history. ([While the action runs](../pull-requests/filters-pagination-and-refresh.md#while-the-action-runs)). | Use a repository with at least three result pages. | 1. Press Next twice.<br>2. Press Previous once.<br>3. Change page size and press Previous. | Next and Previous move through the matching query's pages; after changing size, the prior cursor is not reused. | blocked — the repository had no result pages. |
| FILTER-03 | P1 | mouse | Explicit refresh repeats the current query, while a failed unfiltered Open refresh can show eligible cached rows with degraded freshness and does not retry automatically. ([Settle](../pull-requests/filters-pagination-and-refresh.md#settle)). | Seed an unfiltered Open cache in a disposable profile, then make GitHub unavailable. | 1. Open the cached repository listing.<br>2. Activate the freshness/Refresh control.<br>3. Wait for settlement.<br>4. Observe status and polling. | The same query is retried once by explicit action; cached rows remain readable with Cached after refresh failure or Stale status; no automatic retry loop starts. | blocked — explicit refresh repeated the current merged/50/awaiting query once; cached Open failure and absence of an automatic retry loop were not exercised. |

Not checkable by hand:

- Whether a particular remote page token has expired; record the visible invalid-page recovery if the test fixture can produce it.

## pull-requests/repository-listing.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LIST-01 | P1 | mouse | Rows show GitHub identity, state badges, labels, author, change statistics, checks, update time, and local Review/Brief indicators without fabricating missing statistics. ([Arrive](../pull-requests/repository-listing.md#arrive)). | Use a repository containing draft, merged, reviewed, and unreviewed pull requests, including one with missing stats and one with a retained Brief. | 1. Open Pull requests.<br>2. Inspect each row and its inspector.<br>3. Select the row with missing stats. | Each available indicator is visible; missing statistics show an em dash; the inspector exposes branch, head, checks, labels, and local Review status. | blocked — the read-only repository returned no matching rows. |
| LIST-02 | P1 | mouse | A merged row opens through the terminal-only action, while the current recommendation can expose Open Review before Open merge readiness for an otherwise ready row (suspected bug). ([Edge cases](../pull-requests/repository-listing.md#edge-cases)). | Use one merged row and one open row with Fresh passing checks, mergeable state, and a matching saved Review. | 1. Inspect the merged row action.<br>2. Inspect the ready open row action.<br>3. Record the exact action labels and resulting route without writing. | The merged row offers View merged pull request. For the ready open row, record whether the product shows Open Review instead of Open merge readiness; file a triage entry if the suspected defect is reproduced. | blocked — no merged row or ready open row with a matching saved Review was available. |

Not checkable by hand:

- Whether GitHub's backend ordering is unchanged between reads; verify only the order shown for one settled response.

## pull-requests/opening-a-review.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OPEN-01 | P1 | mouse | Activating a row shows row-local Opening… feedback, deduplicates the same row, and leaves unrelated rows usable. ([While the action runs](../pull-requests/opening-a-review.md#while-the-action-runs)). | Use a disposable repository with two readable Pull request rows and a prepared local checkout. | 1. Activate the first row.<br>2. Activate it again before settlement.<br>3. Activate the second row.<br>4. Observe both rows and the busy indicator. | The first row admits one operation and shows Opening…; the duplicate is ignored; the second row can start independently; shared busy feedback remains until tracked openings settle. | blocked — PR #33 and #34 each showed row-local `Opening…`, and a duplicate activation of the disabled row did not start another operation. Preparation settled before a second row could remain concurrently pending, so unrelated-row concurrency and shared busy settlement were not proved. Evidence: `/private/tmp/patchdesk-open-01-first-opening.png`, `/private/tmp/patchdesk-open-33-opening.png`. |
| OPEN-02 | P1 | keyboard | A saved Review load can fall back to Pull request identity when the saved record is missing or obsolete. ([Settle](../pull-requests/opening-a-review.md#settle)). | Use a disposable row with a saved Review ID whose local record is unavailable but whose Pull request is readable. | 1. Select the row with keyboard.<br>2. Press Enter.<br>3. Wait for opening to settle. | Patchdesk attempts the saved load, falls back by Pull request identity, and enters the Review workbench if preparation succeeds; it does not erase the row on load failure. | blocked — no obsolete saved Review fixture and readable row were available. |
| OPEN-03 | P1 | offline | Preparation failure or changed revision leaves the row retryable and does not enter an unvalidated workbench. ([Settle](../pull-requests/opening-a-review.md#settle)). | Use a disposable row and a controlled GitHub, storage, local-checkout, or changed-head failure. | 1. Activate the row.<br>2. Trigger the selected failure before final preparation.<br>3. Observe the row and destination.<br>4. Retry only after the condition is safe. | The row shows `Could not open review` with bounded context, is re-enabled, and no malformed or mixed-revision workbench opens. | blocked — no readable row with a controlled preparation or revision failure was available. |

Not checkable by hand:

- Exact worktree cleanup after every failure; verify visible recovery and use preparation tests for filesystem invariants.
