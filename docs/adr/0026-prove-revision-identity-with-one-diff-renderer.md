# Prove revision identity with one diff renderer

> **Status: Accepted.** Refines the revision identity established by the
> ADR "Separate PR reconciliation from revision refresh and merge
> confirmation": the same three-field proof — head SHA, base SHA, and a
> canonical patch hash — stands, but the canonical hash must always come
> from one renderer instead of being re-derived from a local artifact.

A review's revision identity is three fields on `ObservedRevisionIdentity`
in `src/domain/review.ts`: `headSha`, `baseSha`, and `canonicalPatchHash`.
`headSha` and `baseSha` are stored at open time and compared against
freshly read values. `canonicalPatchHash` was never stored. Instead,
`src/services/github-revision-identity-reader.ts` re-hashed the patch
file on disk on every cycle and compared it to a hash derived from a
fresh GitHub read.

Those two hashes come from different producers. `getPullRequestDiff` in
`src/adapters/github/github-adapter.ts` has three branches: worktree
mode runs a local subprocess, `git diff --no-ext-diff base...head`;
otherwise it calls `gh api` against GitHub's compare endpoint with the
`application/vnd.github.v3.diff` media type; a fallback uses `gh pr diff
--patch`. At open time a worktree-mode session stores the local git
rendering. The identity reader always takes the GitHub compare path,
because it only ever passes a `snapshot`, never `fetchedRefs`.

The two renderings of the same commit pair differ. Local git abbreviates
blob SHAs in `index` lines to 8 hex characters; GitHub abbreviates them
to 9. Measured on a real session (PR #804): local rendering 33,222
bytes / 881 lines / sha256 `625e3b6a…`; GitHub compare 33,246 bytes /
881 lines / sha256 `2a27a196…`. Line counts match and neither is
truncated; the entire 24-byte delta is 12 `index` lines at 2 characters
each. Removing the `index` lines makes the two renderings byte-identical.

The effect: any worktree-mode session reports "updates available"
forever. Refresh does not clear it, because refresh updates the remote
snapshot but never rewrites the stored patch, so the next detector
cycle re-hashes the same file and reaches the same verdict. All three
sessions on the reporting machine were affected.

This also exposed a false assumption. `normalizeReviewPatch` in
`src/services/review-session-preparation.ts` is a no-op that returns
its input, carrying the comment "Sessions store GitHub's canonical
complete unified patch unchanged" — an assumption worktree mode
silently violated.

## The decision

The canonical patch hash is always computed from one renderer: GitHub's
compare output, the same source the detector reads. A worktree-mode
session may still write the local git rendering to `patch.diff` for
display and insights, but that file is not what proves revision
identity.

The canonical hash is persisted on the session record and compared
stored-vs-fresh, exactly like `headSha` and `baseSha`. Identity is no
longer re-derived from a local artifact.

The field is added additively and optionally, with no `schemaVersion`
bump; the session schema stays `v.literal(5)` in
`src/adapters/storage/review-session-store.ts`. Bumping it would
invalidate existing sessions, and per the ADR "Recover from invalid
local data by rebuilding" an invalid session is moved aside and
re-prepared — which destroys the `pendingReview` draft state stored on
that record. Losing a maintainer's unsent draft comments to fix a
false banner is not an acceptable trade.

A session with no stored hash is compared on the SHA pair alone rather
than reporting a change. This is sound because `headSha` and `baseSha`
are still stored and content-addressed, so a genuine revision change
is caught by the SHA pair whether or not a hash is present. Nothing is
backfilled onto the session: identity naturally gains a hash when a
new revision produces a new session, since session identity embeds
the head SHA.

## Rejected alternatives

Normalize the `index` lines away before hashing. This fixes the
observed instance but assumes 8-vs-9 hex digits is the only way the two
renderers disagree; rename detection, context line counts, mode
changes, and `\ No newline at end of file` markers are all candidates
to differ next. Stripping `index` lines outright is worse: for a binary
file change, the blob SHA in the `index` line is the only content
signal in the diff, so removing it would make identity blind to binary
changes — trading a visible false positive for a silent false negative.

Make the detector use the worktree rendering when one exists. This is
symmetric, but it keeps two renderers in the design and breaks whenever
the worktree has been pruned.

## Why the hash is kept

`recheckUnchanged` in `github-revision-identity-reader.ts` already
carries the argument for why this is redundant. Its WHY comment
observes that `headSha` and `baseSha` are content-addressed Git commit
identifiers naming immutable trees, so GitHub's diff for a fixed pair
is a pure function of that pair and cannot change while the pair does
not. If that holds, `canonicalPatchHash` cannot detect any revision
change the SHA pair does not already prove. The hash's one distinct
capability was noticing corruption of the local `patch.diff` — a job
it performed poorly, since it was comparing bytes from two different
renderers rather than the same artifact against itself.

The hash is kept anyway, as defense in depth. The purity argument is
sound but load-bearing: the same comment names the one condition that
would break it, a force-push onto an existing SHA, which GitHub does
not allow but which this design otherwise has no independent way to
notice. If that guarantee ever stopped holding, the SHA pair alone
would silently stop proving anything, and nothing else in the
`Fresh`/`Changed`/`Unavailable` result would catch it. A hash compared
like-for-like against the same renderer costs one GitHub read and
preserves that guard.

This sharpens, rather than replaces, the local-artifact follow-up
already in Consequences. Corruption of `patch.diff` on disk needs its
own check; it should not be reconstructed out of the identity hash,
which is aimed at proving revision identity against GitHub, not at
proving the local file matches what was last written.

## Consequences

- Opening a worktree-mode session costs one additional GitHub read to
  establish the canonical hash.
- Identity no longer detects local corruption of `patch.diff`. That
  integrity concern is real and should be carried by its own check
  rather than fused into remote-change detection; it is a follow-up,
  not something this decision solves.
- Existing sessions heal on the next detector cycle without a rebuild,
  so drafts survive.
- Any future diff-producing code path must be checked against this
  rule: adding a fourth branch to `getPullRequestDiff` would
  reintroduce the defect.
