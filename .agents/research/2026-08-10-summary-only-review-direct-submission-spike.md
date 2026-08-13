---
created_at: 2026-08-10
repos:
  - patchdesk
status: partial-validation
plan: .agents/PLANS/2026-08-09-summary-only-review.md
---

# Summary-only review direct-submission spike

## Authorization and scope

The product owner confirmed direct, immediate summary submission as the product model and authorized exactly one Comment, Approve, and Request changes validation write from their account on a team-owned pull request. This artifact intentionally omits the pull request URL, account, review IDs, summary text, and raw API responses.

## Baseline bounded read

Before the writes:

- The target pull request was open and had a recorded head SHA.
- The first 100-review REST page contained two reviews, so the read was complete.
- No `PENDING` reviews were present.

## Direct summary results

Each request sent a nonblank body, the current head SHA, and one selected event to `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`. Each response and bounded reader result was reduced to safe fields before recording.

- `COMMENT`: returned and read back as one submitted `COMMENTED` review; it had a nonblank body and created no `PENDING` review.
- `APPROVE`: returned and read back as one submitted `APPROVED` review; it had a nonblank body and created no `PENDING` review.
- `REQUEST_CHANGES`: returned and read back as one submitted `CHANGES_REQUESTED` review; it had a nonblank body and created no `PENDING` review.

For every result, the direct response receipt appeared exactly once in the bounded published-review reader and retained a commit SHA.

## Product waiver

After this partial spike, the product owner explicitly waived the remaining live validation gates and instructed implementation to proceed on the documented conservative assumptions. This does not turn the unproven rows into evidence.

## Remaining gates

## Remaining gates

This evidence proves the narrow direct REST operation and basic bounded published-review read-back. It does not prove the rest of the implementation plan:

- preflight rejection when the viewer has a pending review;
- loss-of-response reconciliation against a durable submitted-review baseline;
- stale-head blocking before a GitHub mutation; or
- fail-closed behavior when the published-review reader is incomplete or paginated.

No additional GitHub write was made. The production direct-summary service, adapter, and renderer path remain blocked until the remaining validation rows receive explicit authorization and evidence.
