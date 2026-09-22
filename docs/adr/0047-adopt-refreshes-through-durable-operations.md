# Adopt refreshes through durable operations

> **Status: Accepted.** Issue #264. Extends ADR 0026's canonical Review adoption and ADR 0035's recovery rule to explicit refreshes.

Refreshing a Review can take longer than the desktop bridge's 30-second request limit. The previous request performed GitHub reads, prepared a session, saved the Review, and returned its projection in one response. When that response timed out, the renderer reported failure and released its ownership while the main process could still finish and adopt the new Review. Retrying could start the same remote work again.

## The decision

An explicit refresh is an accepted, durable operation. The renderer begins it, polls it by operation ID, and acknowledges its terminal state. Beginning the operation persists `Requested` before remote preparation starts. Only one `Requested` or `Prepared` operation can exist for a Review.

Preparation saves the candidate snapshot and session artifacts, computes the complete validated next `Review`, and persists all three references in `Prepared` before the Review compare-and-set. The operation becomes `Completed` only after that exact Review is saved. A failed GitHub read or artifact write becomes a typed `Failed` state. A stale Review compare-and-set becomes `Interrupted`.

The renderer stores the operation ID by workspace profile and Review. A reload resumes polling the same operation instead of beginning another. While the operation is `Requested` or `Prepared`, the Refresh control shows progress and duplicate refreshes are refused. On `Completed`, the renderer loads the saved Review and acknowledges the operation. On `Failed` or `Interrupted`, the represented Review stays readable, the renderer explains the failure, acknowledges it, and allows a new refresh.

## Startup recovery

Refresh recovery runs before observation-journal, merge, and general Review recovery. It never repeats GitHub reads.

- `Requested` becomes `Interrupted`.
- `Prepared` becomes `Completed` when its exact next Review is already current.
- Otherwise, a `Prepared` operation compare-and-set saves its exact next Review only when the current Review still has the recorded `expectedUpdatedAt`, then becomes `Completed`.
- A revision conflict becomes `Interrupted`; a storage failure becomes `Failed` and prevents startup from claiming successful recovery.

Terminal operations remain durable until the renderer acknowledges them or a later refresh replaces them. This preserves the result across renderer reloads and gives startup enough evidence to settle a crash between preparation and Review adoption.

## Consequences

The refresh route no longer returns a workbench projection. It returns HTTP 202 with an operation ID. Separate status and acknowledgement routes carry the rest of the lifecycle. Internal refreshes used while first opening a Review or reconciling a confirmed write can still execute synchronously under the same Review coordinator; they use the same prepare-then-compare-and-set implementation without exposing the removed response contract.

Candidate artifacts can remain after an interrupted operation. Existing content-addressed snapshot pruning handles them after a later successful adoption. The operation record stores no provider payloads or free-form errors.
