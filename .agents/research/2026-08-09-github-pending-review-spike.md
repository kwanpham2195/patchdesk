---
created_at: 2026-08-09
repos:
  - patchdesk
status: pending-authorization
spec: .agents/tasks/inline-diff-conversations/spec.md
tech-spec: .agents/tasks/inline-diff-conversations/tech-spec.md
plan: .agents/tasks/inline-diff-conversations/plans/2026-08-09-github-pending-review-workbench.md
---

# GitHub pending-review validation spike — redacted evidence template

Status: pending explicit authorization for the disposable PR and dedicated test account. No row below is a result; this file is the evidence template and redaction contract that must exist before the first authorized write (plan Step 1).

## Authorization and environment gate

- Written approval names the disposable PR, the dedicated test account, and the exact operations authorized for this run. A new operation or repeat requires new approval.
- The PR is disposable, open, and has a known baseline head. No production PR, maintainer account, or PR with unrelated pending feedback is used.
- Operations run through the main-process adapter/test harness only. The renderer is not a GitHub client; ordinary browser/Electron QA remains non-writing.
- A forced timeout cuts off only the client response after the request boundary; it never issues a second mutation.

## Redaction rules

Never record: tokens, PR URLs, account names, comment bodies, raw JSON, raw command output, or full IDs. Every row records only the fields below.

## Evidence row

One row per authorized operation. Fields:

- operation label and one-time sequence number;
- baseline/current-head relationship;
- authenticated-viewer match: yes / no / unavailable;
- result: confirmed / rejected / unavailable / outcome-unknown;
- bounded reader result: complete / incomplete / none / pending;
- identities available to the typed adapter (REST review, node review, thread, comment), expressed as present/absent only;
- whether the result permits the proposed product action;
- required design disposition: implement / gate / out of scope.

## Execution matrix

| # | Operation | Viewer match | Result | Reader result | Identities (present/absent) | Permits action | Disposition |
|---|-----------|--------------|--------|---------------|-----------------------------|----------------|-------------|
| 1 | Reader baseline (no writes yet) | | | | | | |
| 2 | Start with first inline thread | | | | | | |
| 3 | Import isolation (second account) | | | | | | |
| 4 | Append thread to known pending review | | | | | | |
| 5 | Empty pending review (conditional) | | | | | | |
| 6 | Immediate REST inline comment while pending exists | | | | | | |
| 7a | Reply while pending | | | | | | |
| 7b | Resolve while pending | | | | | | |
| 7c | Unresolve while pending | | | | | | |
| 8a | Head change: add thread after Refresh | | | | | | |
| 8b | Head change: Submit after Refresh | | | | | | |
| 8c | Head change: Discard after Refresh | | | | | | |
| 9a | Unknown outcome: Start reconcile | | | | | | |
| 9b | Unknown outcome: AddThread reconcile | | | | | | |
| 9c | Unknown outcome: Submit reconcile | | | | | | |
| 9d | Unknown outcome: Discard reconcile | | | | | | |
| 10 | Discard and cleanup read-back | | | | | | |

## Acceptance and disposition

- Required to proceed: complete authenticated reader; author/PR isolation; safe first-thread start; append identity/read-back; discard/read-back; reconciliation that never retries an uncertain write.
- Conditional: row 5 controls only unmapped/general Analysis feedback; rows 7a-7c control only their own pending-review integration; rows 8a-8c control stale-head submit/discard.
- Fail closed: pagination/incomplete reads, missing identities, unknown outcomes, or head-change ambiguity never become `None`, an enabled write, or a local-draft workaround.
- At the end, update the tech spec with only the proven request/response contract and classify every matrix row as implemented, gated, or out of scope. No source code changes inside the spike itself.
