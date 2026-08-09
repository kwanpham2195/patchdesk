---
created_at: 2026-08-09
repos:
  - patchdesk
status: complete
spec: .agents/tasks/inline-diff-conversations/spec.md
tech-spec: .agents/tasks/inline-diff-conversations/tech-spec.md
plan: .agents/tasks/inline-diff-conversations/plans/2026-08-09-github-pending-review-workbench.md
spike: .agents/research/2026-08-09-github-pending-review-spike.md
---

# Pending-review DISCARD validation — scope 1 (redacted evidence)

Status: complete. Authorized 2026-08-09 by the product owner with an explicit scope: same PR/account as the main spike; verify the PR is open; create one clearly marked temporary PENDING inline review; invoke DELETE exactly once with a normal confirmed response; one bounded read-back. No lost response, no submit, no reply/resolve/head-change/cleanup writes. On any failure or uncertain read-back: stop and report; no retry.

## Redaction

No tokens, PR URLs, account names, comment bodies, raw JSON, command output, or full IDs are recorded. Identities are present/absent only.

## Run facts

- Target: the same open PR and authenticated account as the fbb91b4 spike, head unchanged (baseline head retained).
- Writes executed: exactly one create and exactly one DELETE, both with normal confirmed responses.
- Final state: no viewer pending review remains; the review-thread count is unchanged from before the run (all remaining threads belong to submitted COMMENTED reviews), so the discarded review's thread did not persist.

## Evidence rows

| # | Operation | Result | Reader result | Identities | Note |
|---|-----------|--------|---------------|------------|------|
| 1 | Preflight (read-only) | confirmed | none (complete) | — | PR open; no viewer pending review; head recorded; anchor derived from the current diff (first added line of the first changed file) |
| 2 | Create temporary PENDING review | confirmed | pending | rest present, node present, thread absent, comment absent | one clearly marked temporary review with one inline comment; response state PENDING |
| 3 | DELETE the pending review (normal confirmed response) | confirmed | complete | — | DELETE endpoint accepted; one invocation, no retry |
| 4 | Bounded read-back | confirmed | none (complete) | rest absent, node absent | no viewer pending review remains; thread count unchanged |

## Disposition

- **Discard is now implementable**: DELETE `repos/{owner}/{repo}/pulls/{n}/reviews/{review_id}` removes the viewer's PENDING review with a normal confirmed response, and a bounded read-back proves the absence (no pending review, no leftover thread from the discarded review).
- Gated remaining (unchanged): lost-response discard reconciliation, isolation-with-access, empty review, Reply/Resolve/Unresolve, and head-change behavior. No further GitHub writes are authorized.
