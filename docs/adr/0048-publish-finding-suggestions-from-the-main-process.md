# Publish Finding suggestions from the main process

> **Status: Accepted.** Issue #316. Extends ADR 0015's single explicit Finding
> authorization to a Finding that carries replacement code, and ADR 0035's
> intent-and-confirmation rule to the write that publishes it. Neither is
> changed.

An Analysis Finding may carry exact replacement code for the new-side lines it cites, published as a GitHub suggested change. A suggestion is code GitHub will commit to the pull request branch on one click by the author, so what it replaces and what it contains must not be decided by the model's own claim about the file, nor by the renderer that displays it.

## The decision

The renderer sends identity only: the workspace profile, the Review, the Analysis run, the Finding, the revision it expects, and the pending review it believes it is appending to. It sends no anchor, no replacement code, and no suggestion Markdown.

The main process derives the rest. It reloads the retained Analysis for that run, rechecks the session, head SHA, and patch hash against the represented Review, reads the represented patch from disk, and takes both the anchor and the replaced lines from that patch. It then composes one comment body: the Finding's suggested comment, or its explanation when there is none, followed by a single fenced `suggestion` block holding the replacement exactly as retained. One helper serializes that fence, so no other code decides what a suggestion block looks like.

A replacement is retained on a Finding only when it passes verification against the represented patch at validation time: the Finding maps to the new side, its whole cited range sits in one hunk of that file, the code contains no line opening a Markdown fence, and the code is at most 4096 bytes. Fenced code is refused rather than escaped, because a fence line inside the block would close it early. A replacement that fails any of these is dropped on its own; the Finding is kept and stays actionable through the ordinary Finding review command.

An empty replacement is refused. It would read as a deletion suggestion, and GitHub's behavior for one is not proved; it is accepted only after a disposable-pull-request behavior test establishes what GitHub does with it.

## The write

The suggestion write reuses the pending-review operation contract unchanged: durable intent before the network call, exact read-back confirmation, the Finding review receipt, the outcome-unknown lock, and Check GitHub again. It starts the viewer's pending review or appends to the existing one, as an ordinary Finding command does, and carries the Finding's full start and end line on both paths.

The response names the exact comment the main process composed. The renderer confirms the returned pending review against that text and anchor rather than against a body it assembled, so a suggestion it never composed can still be proved to have landed.

## Out of scope

Patchdesk does not edit replacement code, apply it to the represented-review worktree, commit or push the pull request branch, or publish a suggestion when Analysis completes. Committing or batching a published suggestion is GitHub's, and the author's.

## Consequences

Publishing a suggestion needs a retained Analysis and a readable represented patch, not just a Finding on screen. A Finding whose patch can no longer be read, or whose range no longer resolves in it, sends nothing and reports a stale revision instead of falling back to a plain comment. The preview the maintainer reads is built from the same patch-derived target as the published block, so the two cannot disagree.
