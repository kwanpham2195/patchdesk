# Review sources beyond a pull request

> **Status: Accepted** (2026-09-25). Implemented by #449-#456. Adds a second Review source beside the pull request.
> Extends ADR 0035 (durable intent, outcome-unknown lock, read-only
> reconciliation) to four new write kinds, three of them git writes. ADR 0014
> is unchanged for pull request Reviews; a local Review keeps its own draft
> list only because no GitHub pending review can exist for it yet. ADR 0002's
> carry-forward rule, superseded for pull requests, is reused for that list.
> ADR 0012, 0013, and 0041 are unchanged: Insight runs still consume a patch,
> a worktree, and a hash. Terms in bold are defined in `CONTEXT.md`.

Today a Review starts only after a pull request exists. `ReviewSession.pr` is
required, and `createReviewId` and `createReviewSessionId` in
`src/domain/ids.ts` hash the pull request number into every identifier. The
Insight runtime never needed that: a child reads a patch, a worktree, and a
patch hash. So a maintainer who wants Analysis before pushing has to open a
pull request first, and the Brief they get afterwards is typed into the pull
request description by hand.

This record decides five things: what a local Review and its sessions are
identified by, when a local session is Fresh, how the model gets a worktree
without reading the maintainer's checkout, which git writes the main process
may perform, and how a local Review hands off to a pull request Review.

## Sources

A **Review source** is what a Review's patch is computed from. There are four
kinds. Only the first exists today.

- `pull_request`: GitHub's base...head, unchanged.
- `working_tree`: the maintainer's checkout (staged, unstaged, and untracked
  files not ignored by `.gitignore`) against `HEAD`.
- `branch`: a local branch against its merge base with a chosen local base
  branch.
- `commit`: one commit against its first parent (the empty tree for a root
  commit).

A local source is opened only on a repository the workspace profile lists with
a `localPath`. Patchdesk reads local refs only; it never fetches for a local
source.

## Identity

A local Review is keyed by `profileId`, the profile repository
(`host`/`owner`/`repo`), and the source spec:

- `working_tree`: the branch `HEAD` names, or `detached` when it names none.
  Switching branches opens a different Review, so drafts never follow a branch
  switch.
- `branch`: the branch name and the base branch name.
- `commit`: the commit SHA.

A local session is keyed by that Review key plus `headSha` and `baseSha`,
exactly as a pull request session is. For `branch` and `commit`, `headSha` is
the tip or the commit and `baseSha` is the merge base or the parent. For
`working_tree`, `headSha` is the **Local snapshot** commit described below and
`baseSha` is `HEAD`.

`ReviewSession` and `ReviewIdentity` gain a `source` discriminant. `pr` and
`prContext` exist only on the `pull_request` kind, and `ReviewSessionKey`
loses `prNumber` from its shared part. Each kind keeps its own readable id
segment (`__pr-<n>` today, `__local-<kind>-<slug>` for the new ones) so a
stored folder still says what it is. The slug is the branch name or short SHA
sanitized to the id alphabet (`/` becomes `-`); the raw branch name enters
only the collision hash, so two branches that sanitize alike still get
different ids. `reviewIdSyntax` and `sessionIdSyntax` in `ids.ts` accept both
segments.

## The Local snapshot

The model child never reads the maintainer's checkout, and the maintainer's
index is never modified. For `working_tree`, Patchdesk records the checkout as
one commit object:

1. Copy the index at `git rev-parse --git-path index` (correct for a linked
   worktree checkout too) to a temporary file and point `GIT_INDEX_FILE` at
   it. An index with unmerged entries refuses to open a `working_tree`
   Review.
2. `git add -A` into the copy, then `git write-tree`. This is the snapshot
   tree.
3. `git -c commit.gpgsign=false commit-tree <tree> -p HEAD` with fixed
   `GIT_AUTHOR_*` and `GIT_COMMITTER_*` names, emails, and dates and a fixed
   message. The same content on the same `HEAD` always yields the same commit
   SHA, so an unchanged Refresh lands on the same session. Signing is off
   because a signature differs on every run.
4. Store it under `refs/patchdesk/local/<profile>/<session>/head`, and create
   the session worktree with the existing `git worktree add --detach`, marker,
   and cleanup code in `review-worktree-service.ts`.

The patch is `git diff --binary --no-ext-diff --no-textconv --no-color
--src-prefix=a/ --dst-prefix=b/ --no-relative <baseSha> <headSha>`, hashed
as written; its sha256 is the session's canonical patch hash. The last four
flags keep the maintainer's `diff.noprefix`, `color.diff`, and
`diff.relative` settings out of the patch (amended 2026-09-25, #449). A local source has one renderer, so ADR 0026's two-renderer problem
does not arise and no normalization is applied.

The goal record proposed "a detached worktree at `HEAD` with the patch
applied". The snapshot commit replaces it because of one concrete failure:
Brief Reach counts names with `git grep ... <headSha>` in
`brief-reach-service.ts`, which searches the commit, not the files. In an
applied-patch worktree `headSha` is the maintainer's `HEAD`, so every name the
patch adds would count zero. With the snapshot commit, `headSha` holds the
changes and Reach, the inspector, and worktree cleanup run unchanged. It also
removes `git apply` failures on binary files and mode changes.

## Freshness

A pull request session is Fresh when GitHub still reports its head. A local
session is Fresh when recomputing its source from the maintainer's checkout
gives the same `headSha` and `baseSha`:

- `working_tree`: steps 1 to 3 above give the same snapshot commit. This is
  the rule "rehash equals the session hash": the patch is a function of the
  two SHAs, and the snapshot SHA is a function of `HEAD` and every byte of the
  tree.
- `branch`: the branch tip and the merge base are unchanged.
- `commit`: the commit still exists.

The recomputation runs inside `requireFresh`, immediately before Apply and
Commit, the same place `requireCurrentHead` reads GitHub today. It is not
cached and no timer runs it. When the SHA pair differs, the gate renders and
hashes the new diff so `RevisionChanged` carries the same
`ObservedRevisionIdentity` a pull request Review records. The write is
refused, the Review's `freshness` becomes `RevisionChanged`, and the refusal
reason is returned for the renderer to show beside the control. Refresh is
the only way to a new session.

## Local drafts

A pull request Review drafts into the GitHub pending review (ADR 0014). A local
Review has no pull request yet, so it keeps a **Local draft** list on the
Review record. **Add to draft** on a current Mapped Finding adds one entry
holding the path, side, line range, `diff-anchor.ts` fingerprint, and the
Finding's comment and suggestion as retained. It is a local store write under
the Review coordinator with no freshness gate, because it changes nothing
outside Patchdesk. **Remove** is the only other action. Drafts are not edited
locally; editing happens in the GitHub pending review after handoff.

On Refresh, a draft moves to the new session only when its anchor fingerprint
maps to exactly one location in the new patch. Otherwise it stays with its
original file and code context under **Needs attention**, and handoff skips it
until the maintainer removes it or it maps again. This is ADR 0002's rule. No
draft is ever discarded by Refresh.

## Git writes the main process may perform

This is the complete list. Anything else is a new decision.

On the maintainer's repository:

- **Object and managed-ref writes.** `git add -A` into a temporary index
  (writes blobs), `git write-tree`, `git commit-tree`, `update-ref` under
  `refs/patchdesk/local/` (create and `update-ref -d`), and `git worktree
add`/`remove`/`prune` for worktrees under the app cache. Unreachable
  objects are left for `git gc`.
- **Apply.** `git apply` without `--index` or `--3way`, of a patch Patchdesk
  composes from the session patch and one or more retained Finding
  suggestions. Context lines make the apply refuse a file that changed.
- **Commit.** `git add --intent-to-add -- <untracked paths>`, then
  `git commit --only -F <tempfile> -- <paths>` on the checked-out branch.
  `--only` commits exactly the listed paths and leaves every other staged
  entry staged; it refuses an untracked path, which is why the
  intent-to-add comes first. Hooks run, after the login-shell import has
  settled (ADR 0038); `--no-verify`, `--amend`, and `-a` are never passed.
  Commit is the one write that changes the maintainer's index: the
  intent-to-add entries, and the listed paths staged at their working-tree
  content, which replaces a partial `git add -p` stage of a listed path. The
  goal record's "index is never modified" covers computing the diff; this
  write is the exception. A refused Commit leaves the intent-to-add entries,
  and the ship dialog names them; Patchdesk does not reset them.
- **Push.** `git push origin <branch>:refs/heads/<branch>` over HTTPS with the
  profile's credential helper, built like the fetch in
  `buildGitHubManagedFetchCommand`. No force, no `--force-with-lease`, no
  upstream config, no tags. Refused on a detached `HEAD`, on the repository's
  default branch, and when `origin` does not resolve to the profile
  repository. The default branch is read from GitHub when the ship dialog
  opens.

Never: checkout, switch, reset, restore, stash, rebase, merge, cherry-pick,
branch or tag creation, fetch into non-managed refs, and config writes.

On GitHub, one new write: **Open PR**, a REST create with `head`, `base`,
title, and body.

## Preconditions

Apply and Commit change the checkout the session represents, so neither Push
nor Open PR can follow a Fresh session: after Commit, `HEAD` is no longer the
session's `baseSha`. Each write therefore has its own precondition, checked
in the write gate immediately before it:

- **Apply**: `working_tree` source; `requireFresh` passes.
- **Commit**: `working_tree` source; `requireFresh` passes.
- **Push**: `requireCurrentSession` passes, and `git rev-parse <branch>`
  equals the Commit receipt's SHA (`working_tree`) or the session's `headSha`
  (`branch`, whose session must also be Fresh).
- **Open PR**: `requireCurrentSession` passes, and `git ls-remote origin
refs/heads/<branch>` equals the Push receipt's SHA.

This deviates from the goal record's "every write only when Fresh": Push and
Open PR are gated by the receipt chain, which is the same check applied to
the state the previous write produced. Acceptance bullet 6 reads accordingly:
Apply and Commit are refused when the session is not Fresh, Push and Open PR
when their receipt chain does not hold, each with the reason beside the
control.

The Open PR `base` is the source base for `branch`, and the repository's
default branch for `working_tree`, editable in the ship dialog. A `commit`
source cannot ship.

Apply takes a set of non-overlapping Finding suggestions in one operation,
and a confirmed Apply prepares the next session as part of that same
operation, carrying drafts across. Findings from the earlier Analysis stay
readable and are no longer applicable; applying more needs a new run. Commit
prepares no session: a confirmed Commit marks the Review `RevisionChanged`,
and the Review shows the ship steps until handoff.

## Operations and recovery

Each new write gets its own operation record, written under the Review
coordinator before the write and marked outcome-unknown immediately before it
starts (ADR 0035). Recovery reads only:

- **Apply**: the intent stores each file's pre-image and expected post-image
  sha256. All files at post-image: confirmed. All at pre-image: not applied,
  lock cleared. Anything else: check-required.
- **Commit**: the intent stores the pre-commit `HEAD` and the message. `HEAD`
  whose parent is the pre-commit `HEAD`, with that message: confirmed. The
  tree is not compared, because a pre-commit hook may rewrite files. `HEAD`
  unchanged: not committed, and any intent-to-add entries stay in the index
  where `git status` shows them. Anything else, including a commit-msg hook
  that rewrote the message: check-required.
- **Push**: `ls-remote` returns the intended SHA: confirmed. It returns the
  SHA recorded before the push: not pushed. Anything else: check-required.
- **Open PR**: list open pull requests with that `head` and `base`. One match
  whose body equals the intended body: confirmed. None: not created, and the
  maintainer may press Open PR again; GitHub's one-open-pull-request per head
  and base is the backstop against a duplicate. Several, or one with another
  body: check-required.

None of the four is ever retried automatically. A confirmed write stays
confirmed when a later bookkeeping step fails.

## Handoff

A confirmed Open PR ends the local Review. Patchdesk opens the pull request
Review for the new number through the ordinary open path, then offers
**Continue in pull request review**, which writes the Local drafts into that
Review's GitHub pending review with the existing Start and AddThread
operations. A draft is written only when its anchor fingerprint maps to
exactly one location in the pull request's patch; the rest stay on the ended
local Review, listed and copyable. The threads are ordinary pending-review
comments, not Finding review receipts, because the Findings belong to a local
session's Analysis and the pull request session has none. A draft carrying a
suggestion is written with the ADR 0048 suggestion-fence serializer. The local Review
records the pull request number and the thread each draft became.

The Open PR body is seeded in the main process from the retained Brief by one
serializer, with citations rendered as `path:line`. The maintainer may edit
the title and body in the ship dialog; what is sent is what they confirmed.
The commit message is seeded the same way.

## Workbench

A local Review shows the Diff workbench and the three Insights. It has no
Conversation, no metadata rail, no Publish, no Merge, and no Finding review
command. The context pack skips comments and checks. The Brief has no
Description vs diff block, because there is no description. Its citation
manifest is diff hunks only, as ADR 0040 made it for every source (amended
2026-09-25, #450; this record first said `c*` for `branch` sources).

## Rejected alternatives

**Detached `HEAD` worktree with the patch applied.** Breaks Reach, as above,
and fails on binary and mode changes.

**Diff with the maintainer's own index.** `git add -N` or `git diff HEAD`
with untracked files requires writing the maintainer's index.

**One Apply per session, with a Refresh in between.** Every Apply after the
first would need a new Analysis run on the provider account. A batch Apply
costs the same safety and one run.

**Carry Findings across an Apply by re-mapping them.** It would make an
outdated Analysis result actionable, which ADR 0012 rules out.

**Hand drafts over as Finding review receipts.** A receipt names an Analysis
run on the represented revision. The pull request session has none, and
copying the local result into it would claim an analysis of a revision that
was never analyzed.

**Push with `--set-upstream`.** Convenient, but a config write on the
maintainer's repository for a step they can do in one command.

## Consequences

- `Review`, `ReviewSession`, their schemas, and every consumer of
  `session.pr` branch on `source`. Stored pull request records keep their
  shape under the `pull_request` kind.
- `requireFresh` gains a local branch that runs the recomputation above. The
  write gate stays the one place freshness is decided.
- Refresh and freshness checks write loose objects into the maintainer's
  object store. They are unreachable after the managed ref is deleted.
- Commit runs the maintainer's hooks with the main process's environment. A
  hook that rejects is a deterministic refusal, shown beside the Commit
  control.
- Working-tree Reviews on a detached `HEAD` can be reviewed but not shipped.
- After a push the local branch has no upstream until the maintainer sets one.
- The ship dialog lists the commits `base..HEAD` will carry, because the pull
  request contains earlier unpushed commits the working-tree session did not
  show.
- The ADR PR adds a note to ADR 0002 (its carry rule is reused for Local
  drafts) and to ADR 0014 (it does not cover local Reviews).
