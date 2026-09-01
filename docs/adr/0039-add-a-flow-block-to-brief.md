# Add a Flow block to Brief

> **Status: Accepted.** A sixth Brief block, alongside the five from ADR 0036.
> It keeps ADR 0036's citation rule in spirit and adds nothing to the model's
> capability boundary from ADR 0018.

Brief's five blocks answer what a change is for, what it touches, and where to
start reading. None of them shows how the change reorders a runtime sequence.
Goal is prose. Shape groups files, not steps. Walkthrough orders the diff for
reading, not the code for running. A reviewer who wants to know "did this
change add a step, drop one, or just move code around" has to read every hunk
and rebuild the sequence by hand, and a raw `+`/`-` diff of a call sequence
means nothing without training on what the symbols stand for.

## The decision

Patchdesk adds **Flow**, a sixth Brief block: up to three diff-styled trees,
one per **kind**, each showing which steps a pull request added, removed, or
kept. A kind is a view on the change, modelled on how engineers already
sketch one:

- `call_tree` — a runtime call tree or call stack change. Labels are real
  function or method names with their parameter names as written in the
  patch, e.g. `validateManualDays(command, suggestion)`, never a sentence.
  Children are the calls made inside — the point is that a reviewer follows
  the flow without reading the code.
- `control_flow` — a state or control-flow change as short pseudocode lines,
  e.g. `on(save)`, `if content is unchanged`, `return cached result`.
- `component` — a UI component tree change, labels like `<SessionToolbar>`
  with hooks as plain names (`useSessionEvents()`).

At most one tree per kind, so up to three trees total. The model omits a
kind that does not apply to the change, and omits Flow entirely when no step
changes in any kind — a rename, a docs change, a pure refactor. The maintainer
sees, for a `call_tree` view on a change to Brief's own pipeline:

```diff
 startInsightRun(request)
-  prepareSharedContext(command)
+  readPatch(diffText)
+  loadPullRequestContext(prNumber)
+  buildCitationManifest(hunks, description, commits)
 askModelForBrief(prompt)
+  validateCitations(brief, manifest)
+  computeReachLocally(brief, ownershipGraph)
 persistSnapshotBoundBrief(brief, snapshotId)
 renderResult(brief)
```

Within a tree, the model proposes a label plus a change of `added`,
`removed`, or `unchanged` for each node, nested up to three levels deep, at
most fifteen nodes per tree, labels capped at 120 characters — longer than
the rest of Brief's 80, because signatures run longer than sentences.

### Flow cites hunks only

Brief's citation manifest carries three alias kinds: `h*` hunks, `d*`
description paragraphs, `c*` commits (ADR 0036). Flow accepts only `h*`. An
added or removed step is a claim that the diff changed the running order, and
only the diff can support that claim — a description or commit citation is a
claim about the change, not evidence from it. A citation that resolves to a
`d*` or `c*` alias is discarded exactly like one that resolves to nothing.

- An `added` or `removed` node needs at least one surviving hunk citation. One
  without it is dropped, and its whole subtree is dropped with it — a step
  the model could not place in the diff has children the model could not
  place either.
- An `unchanged` node needs no citation. It is the spine that gives the added
  and removed steps context. Any citations it does carry are still resolved
  against the manifest, so a bad one still counts as rejected, but it never
  costs the node its place.
- A tree left with no surviving `added`/`removed` node anywhere in it is
  dropped whole. A tree of only unchanged steps says nothing changed, so
  showing it would be noise dressed as a diff.
- The block itself is absent when no tree survives, the same rule as every
  other Brief block: absent evidence draws nothing rather than an empty
  shell.

One consequence is accepted on purpose. A tree can have a correct, verifiable
spine and lose its only changed step to a missing citation, and the whole
tree goes with it — the spine had nothing left to explain. Keeping the spine
anyway, as an uncited assumption, was considered and rejected: every other
demotion in Brief keeps a citable claim readable at a lower confidence
(ADR 0036's demoted Goal line), and a Flow spine with no changed step is not
a claim at all, just scaffolding. Making it the first uncited structure in
Brief would be a new kind of exception, not a graceful degradation.

### Deterministic bookkeeping, model-free counting

The model proposes labels, change markers, and citations. Patchdesk resolves
every citation against the manifest, applies the caps, and drops what does
not survive — the model never counts anything, matching the existing "no
numbers" rule (ADR 0036). A cap is enforced by traversal order, not by
re-ranking: the fifteen-node limit is a pre-order visit count per tree, the
three-level limit is straightforward nesting depth, and a node cut for either
reason is dropped rather than truncated — nothing mid-tree is cut off midway
so the reader never sees a tree that stops making sense partway down.

### Boundary with Walkthrough

Flow and Walkthrough both describe order, but different orders. Walkthrough
orders the *diff* — the sequence a reviewer should read hunks in. Flow orders
the *runtime* — the sequence steps ran in, before and after. Start here
already links to Walkthrough; that link is unchanged.

### Rendering

Flow draws like a diff block, not a tree widget: monospace rows, a marker
column (`+`, `−`, blank) on the left, indentation by depth, added and removed
rows tinted with the app's diff hues, unchanged rows dimmed so the changed
steps stand out, and a citation chip at the end of a changed row — identical
to Goal's, opening the same hunk-preview popover the rest of Brief uses. Each
view's header carries a kind badge (`call_tree`, `control_flow`, `component`)
so a maintainer scanning more than one tree knows which kind of sketch
they're reading. A "Copy as diff" action emits the same rows as a fenced
` ```diff ` block, one block per view: the marker sits in column 0, and each
level of depth adds two spaces of indentation — the form used in the
maintainer's `show-me` sketches.

### Storage

Flow is an optional field on the retained Brief, stored the same way as
Ownership, Start here, and Reach. A Brief retained before this decision
simply has no Flow field, and the reader omits the block rather than
inventing one.

## Consequences

- Brief gains a sixth block. The fixed order from ADR 0036 needs one more
  entry; Flow's position in that order is a rendering decision, not a
  citation one.
- The code is `flow` / `BriefFlow`, with no naming conflict: ADR 0036's
  `no-shape-in-symbol-names` lint rule is why Ownership isn't called `shape`
  in code, and "flow" has no such collision.
- A pull request that only renames things or reorders unrelated code has no
  Flow block, by the model's own instruction to omit rather than by a
  citation failure — there is nothing wrong to report, just nothing to show.
- A correct spine can vanish alongside its one changed step if that step's
  citation does not resolve. This is accepted, not overlooked: see the
  rejected alternative above.
- Brief is moving toward structure-first views. A follow-up ADR (0040)
  removes the Goal, Assumptions, and Description-vs-diff blocks and
  re-anchors the citation rule on Flow.
