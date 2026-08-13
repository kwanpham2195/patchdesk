---
created_at: 2026-08-09
repos:
  - patchdesk
status: complete
spec: .agents/archive/inline-diff-conversations/spec.md
tech-spec: .agents/archive/inline-diff-conversations/tech-spec.md
plan: .agents/archive/inline-diff-conversations/plans/2026-08-09-github-pending-review-workbench.md
---

# GitHub pending-review validation spike — redacted evidence

Status: complete. Authorized 2026-08-09 by the product owner via the session interview: one-time run, each authorized operation exactly once, through the main-process adapter/test harness (`.agents/research/spike-harness.test.ts`, deleted after the run). Deviations from the plan's environment gate, chosen by the owner: the target is a real open repo PR (not a sandbox disposable PR) and the writes used the owner's own account (not a dedicated test account). The PR must not be closed.

## Redaction

No tokens, PR URLs, account names, comment bodies, raw JSON, command output, or full IDs are recorded below. Identities are recorded as present/absent only.

## Run facts

- Target: open PR on a Central Digital repo, base head at run start. Head unchanged during the run (no head-change rows authorized).
- Authenticated viewer match: yes (writes), no (isolation account).
- Artifacts left on the PR after the run: one submitted COMMENTED review and three inline comments, all clearly marked as a validation spike. No pending review remains. The submitted review cannot be deleted via the reviewed APIs; the owner can dismiss/ignore it or delete the comments in the GitHub UI.

## Evidence rows

| #     | Operation                                               | Viewer match | Result                                            | Reader result       | Identities (present/absent)                                                        | Permits action            | Disposition                                                            |
| ----- | ------------------------------------------------------- | ------------ | ------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| 1     | Reader baseline (read-only)                             | yes          | confirmed                                         | none (complete)     | rest absent, node absent, thread absent, comment absent, commit absent             | yes                       | implement                                                              |
| 2     | Start with first inline thread (confirmed write)        | yes          | confirmed                                         | pending (complete)  | rest present, node present, thread present, comment present, commit present        | yes                       | implement                                                              |
| 3     | Import isolation (second account, read)                 | no           | unavailable                                       | unavailable         | all absent                                                                         | no                        | implement (fail-closed); isolation with repo access unproven           |
| 4     | Append thread to known pending review (confirmed write) | yes          | confirmed                                         | pending (complete)  | node present, thread present, comment present                                      | yes                       | implement                                                              |
| 5     | Empty pending review (conditional)                      | —            | not run                                           | —                   | —                                                                                  | —                         | out of scope (not authorized)                                          |
| 6     | Immediate REST inline comment while pending exists      | yes          | rejected                                          | none                | all absent (no comment created)                                                    | no                        | out of scope (GitHub rejects; keep Comment now disabled while pending) |
| 7a-7c | Reply / Resolve / Unresolve while pending               | —            | not run                                           | —                   | —                                                                                  | —                         | out of scope (not authorized)                                          |
| 8a-8c | Head change: add / submit / discard after refresh       | —            | not run                                           | —                   | —                                                                                  | —                         | out of scope (not authorized)                                          |
| 9a    | Start with lost response                                | yes          | confirmed absence                                 | none (complete)     | all absent; no new thread, no pending-owned thread                                 | yes (safe to start again) | implement (reconciliation rule)                                        |
| 9b    | AddThread with lost response                            | yes          | confirmed                                         | pending (complete)  | thread present                                                                     | yes                       | implement (reconciliation rule)                                        |
| 9c    | Submit with lost response                               | yes          | confirmed                                         | none (pending gone) | all absent; submitted review visible with matching event and body, commit retained | yes                       | implement (reconciliation rule)                                        |
| 9d    | Discard with lost response                              | yes          | confirmed (already absent — submit removed it)    | none                | all absent                                                                         | yes                       | gate: DELETE endpoint never exercised                                  |
| 10    | Discard + cleanup (confirmed)                           | yes          | confirmed (no pending remained; no DELETE issued) | none                | all absent                                                                         | yes                       | gate: DELETE endpoint never exercised                                  |
| 11    | Cleanup read-back                                       | yes          | confirmed                                         | none (complete)     | thread present (3 spike threads retained, owned by the submitted review)           | yes                       | implement                                                              |

## Proven request/response facts (implementable contracts)

- **Bounded reader:** REST `pulls/{n}/reviews?per_page=100` lists PENDING reviews with `state`, `user.login`, `id` (REST), `node_id` (node), `commit_id`; submitted reviews carry `submitted_at` and pending reviews omit it. GraphQL `reviewThreads(first:100)` returns thread `id`, `path`, `line`, `startLine`, `diffSide`, `startDiffSide`, `isOutdated`, comment `id`/`author`/`createdAt`, and each comment's owning review via `pullRequestReview { id, state }` — threads created inside a pending review map to that review and re-map to the submitted review after submit. Both reads have `pageInfo.hasNextPage` completeness markers. A complete result with zero viewer PENDING reviews is proof of absence; incomplete results must be Unavailable.
- **Start with first thread:** REST POST `pulls/{n}/reviews` with `commit_id`, body, and one `{path, line, side: RIGHT, body}` comment creates a PENDING review; the response carries REST `id` and `node_id`; the thread/comment are visible in the threads query with the owning review.
- **Append thread:** GraphQL `addPullRequestReviewThread(input: {pullRequestReviewId, path, line, side: RIGHT, body})` succeeds against a PENDING review, returns `thread { id, path, line, startLine, diffSide, comments { nodes { id } } }`, and the thread reads back under the owning review.
- **Submit:** REST POST `pulls/{n}/reviews/{id}/events` with `{event, body}` submits the pending review (COMMENTED observed); the review keeps `commit_id`.
- **Immediate comment while pending:** rejected (HTTP 422, "one pending review per pull request" error class). Comment now must stay disabled while a viewer pending review is confirmed.
- **Lost-response reconciliation:** client timeout after the request boundary never requires a second mutation. A bounded read distinguishes: thread-count/identity growth (AddThread landed), pending-gone plus matching submitted review (Submit landed), no pending and no new thread (Start absent). A confirmed absence after Start-lost supports starting again; an uncertain read stays locked.
- **Isolation:** an account without repo access returns 404 — Unavailable, never content. Patchdesk never imports another reviewer's pending content through that path.

## Gated and unproven

- **Discard:** the DELETE `pulls/{n}/reviews/{id}` candidate was never exercised (no pending review existed at any discard point: submit removed it before 9d; 9a's start did not land before row 10). Discard semantics and its read-back reconciliation remain unproven and must not ship as a contract.
- **Isolation with repo access:** a second viewer WITH access seeing None for the first viewer's pending review was not observed (the second account has no repo access).
- Empty review, Reply/Resolve/Unresolve, and head-change behavior: not authorized in this run; remain out of scope.

## Disposition summary

- Implement: bounded reader; start-with-first-thread; append-thread; submit; Comment-now-while-pending disabled; create/add/submit lost-response reconciliation.
- Gate: discard (endpoint unproven); isolation-with-access; anything head-change related.
- Out of scope: empty review; reply/state changes; immediate comment while pending.
