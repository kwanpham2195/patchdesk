# Reconcile every uncertain GitHub write

> **Superseded in part for local Apply** (2026-09-26, #484): a check-required
> or outcome-unknown Apply on a local Review (ADR 0050) also ends when the
> Review moves to another session. See the 2026-09-26 note in ADR 0050
> "Operations and recovery". GitHub writes are unchanged.

Patchdesk persists the exact Review write intent before a GitHub mutation can start and marks it outcome-unknown immediately before the network call. It persists confirmation before reporting success. A deterministic rejection removes the intent; an unavailable response, malformed success, or interrupted confirmation keeps the Review locked.

Recovery is a read-only GitHub operation under the existing Review coordinator. It never repeats the mutation. Only complete evidence may clear the lock: one exact creation or reply match, the intended thread state or edited body, or confirmed absence for a deletion. Incomplete evidence remains check-required. Multiple plausible creation matches require manual resolution.

A confirmed operation remains confirmed if the following observation fails. Patchdesk may return the current represented workbench and offer another read, but it must not restore the write lock or present the mutation as retryable. Confirmed receipts feed one normal bounded observation when available; deletion recovery does not fabricate a comment-existence receipt.

This extends ADR 0017 without changing revision refresh. Diff-anchored recovery stays bound to the represented session, head SHA, and patch hash. Pull-request metadata recovery retains branded session provenance but resolves current pull-request identity through the current session; labels, assignees, and reviewer requests remain recoverable after head movement. Same-revision observation may update bounded remote state, while only explicit Refresh adopts changed revision content.
