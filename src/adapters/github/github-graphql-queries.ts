export const threadQuery =
  "query PullRequestThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $cursor) { nodes { id isResolved isOutdated path line startLine diffSide startDiffSide originalLine comments(first: 100) { nodes { id body createdAt updatedAt url viewerDidAuthor author { login } path } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } } } }";
// Reverse pagination confirmed against a live PR (2026-08-17): `reviewThreads`
// returns oldest-first, and `last`/`before` is schema-valid, so `last: 20`
// reliably surfaces a just-created thread regardless of how many older
// threads the PR already has. No `$cursor`/`$id` variable is declared here —
// matching happens client-side over the returned list (see
// `confirmPublishedCommentThread`), which is the exact discipline the
// unused-`$id`-variable defect in commit 2392af8 violated.
export const confirmCreatedCommentThreadQuery =
  "query ConfirmCreatedCommentThread($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(last: 20) { nodes { id isResolved isOutdated comments(first: 100) { nodes { id body createdAt } } } } } } }";
// Spike-proven (2026-08-09): every thread comment exposes its owning review
// and state, which lets the bounded reader prove which threads belong to the
// viewer's PENDING review without scanning other reviewers' data.
export const pendingReviewThreadsQuery =
  "query PendingReviewThreads($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isOutdated path line startLine diffSide startDiffSide comments(first: 100) { nodes { id body createdAt author { login } pullRequestReview { id state } } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } } } }";
export const maxReviewThreadPages = 10;
export const maxReviewThreads = 1_000;
export const threadCommentsQuery =
  "query ReviewThreadComments($id: ID!, $cursor: String) { node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $cursor) { nodes { id body createdAt updatedAt url viewerDidAuthor author { login } path } pageInfo { hasNextPage endCursor } } } } }";
// Single-node ownership proofs: one `$id` variable, no conversation content.
// PR identity comes from the node's pull request (threads derive it from
// their first comment), and any owner/repository/number mismatch is resolved
// inside the adapter as `found: false`, never disclosed to the renderer.
export const reviewThreadTargetQuery =
  "query ReviewThreadTarget($id: ID!) { node(id: $id) { ... on PullRequestReviewThread { id comments(first: 1) { nodes { id pullRequest { repository { owner { login } name } number } } } } } }";
export const reviewCommentTargetQuery =
  "query ReviewCommentTarget($id: ID!) { node(id: $id) { ... on PullRequestReviewComment { id viewerDidAuthor pullRequest { repository { owner { login } name } number } } } }";
export const maxReviewCommentPages = 10;
export const maxReviewComments = 5_000;
export const maintainerInboxQuery =
  "query MaintainerInbox($owner: String!, $name: String!, $cursor: String) { rateLimit { remaining resetAt } repository(owner: $owner, name: $name) { pullRequests(first: 100, after: $cursor, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number title isDraft headRefName headRefOid baseRefName baseRefOid author { login } updatedAt mergeable reviewDecision additions deletions changedFiles reviewRequests(first: 50) { nodes { requestedReviewer { ... on User { login } } } } assignees(first: 50) { nodes { login } } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } pageInfo { hasNextPage endCursor } } } }";
export const mergePolicyQuery =
  "query MergePolicy($owner: String!, $name: String!, $number: Int!, $cursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { state isDraft headRefOid baseRefOid baseRefName mergeable mergeStateStatus reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100, after: $cursor) { nodes { __typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl } } pageInfo { hasNextPage endCursor } } } } } } } } }";
export const maxMergePolicyPages = 3;
export const maxPullRequestCommits = 250;
