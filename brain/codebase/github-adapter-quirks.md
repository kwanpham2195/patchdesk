# GitHub adapter quirks

Ground truth learned live (Aug 2026) while debugging inline-conversation write
blocking on `cfw-bo-staff-api#717`. Verify against GitHub before trusting these,
but they are reproducible with the QA profile (`cfw`).

## GitHub's updatedAt lags comment/review creation

`PullRequest.updatedAt` can lag the comments/reviews it should reflect by
seconds (observed: a refresh 7s after a review submission recorded the OLD
updatedAt while its snapshot already contained the new comment). Consequences:

- Never treat `updatedAt` alone as a change signal for freshness detection.
  `ReviewRefreshService.detect` verifies content fingerprints before flagging
  `Updates available`, and heals phantom flags (`healDetectedUpdate`) when the
  represented snapshot actually matches the remote.
- `refresh` records `representedRemote.pullRequestUpdatedAt` as the max of the
  PR updatedAt and the comment/review timestamps in the snapshot, so the record
  is self-consistent with its content.

## DeletePullRequestReviewCommentInput requires `id`

The GraphQL mutation is
`deletePullRequestReviewComment(input:{id:$commentId})`. Passing
`pullRequestReviewCommentId` is rejected ("InputObject doesn't accept
argument"). This broke every inline-comment delete (the app returned
`github_write_failed`). Guard: the adapter test asserts the mutation string.

## LEFT-side single-line threads report a degenerate range

For a single-line comment on the OLD side, GitHub GraphQL returns
`line: N, startLine: N + 1` (an inverted, phantom range). Multi-line LEFT
ranges come back in normal order (`startLine < line`). The adapter normalizes
`startLine > line` to a single-line anchor; without that, the Diff mapping
rejects the inverted range and the created thread's card never renders.

## viewerDidAuthor is viewer-relative and can lag

GitHub may return it late (or null) for freshly created comments. It drives
edit/delete affordances in the Diff, so:

- The remote snapshot storage schema must persist it (it used to be silently
  dropped, hiding Edit/Delete on represented reviews).
- Detection fingerprints must exclude it (and the other viewer-relative gating
  fields) — otherwise a lagging field reads as a remote content change and
  blocks all inline writes with a phantom "Updates available".

## Fingerprint noise sources

`fingerprintForDetection` (review-refresh-service) normalizes: PR updatedAt
(sentinel), mergePolicy checks order and completeness markers, mergeEvidence
`policy` (never fetched during detection), and viewer-relative comment fields.
Any NEW volatile field added to the snapshot must be excluded or normalized
there or the detector will flag phantoms.

## Every comment write submits its own COMMENTED review

Both the REST create (`POST pulls/{n}/comments`) and the GraphQL reply
(`addPullRequestReviewThreadReply`) submit a fresh COMMENTED review — the
review list grows with every comment. The write journal must exclude that
review (and the comment) from detection fingerprints or a write flags itself:

- create receipt: `pull_request_review_id` (REST, numeric) — matches
  `PublishedReview.id`; also `node_id` matches `PublishedReview.nodeId`.
- reply receipt: `comment { pullRequestReview { id } }` (GraphQL node id) —
  matches `PublishedReview.nodeId`.
- `withoutJournaledFeedback` filters both id forms from both fingerprint sides.

## PENDING reviews block comment writes with a 422

GitHub allows one pending review per user per PR. While one exists, comment
creation fails with "user_id can only have one pending review per pull
request" — including via GraphQL. The pending review is usually an orphan
(started in GitHub's UI and never submitted). The adapter classifies it as
`CommandPendingReview` so the renderer can say "submit or discard your
unfinished review on GitHub" instead of a generic failure. Also: PENDING
reviews omit `submitted_at` entirely, which used to fail the feedback schema
parse (breaking every detect/refresh while one exists); the schema now treats
it as nullish and skips such reviews.
