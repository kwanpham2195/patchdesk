# Make Brief structure-first

> **Status: Accepted.** Supersedes the Goal and Assumption mechanics of ADR
> 0036; builds on ADR 0039.

ADR 0036 gave Brief a Goal: two to four prose sentences answering what a
change is for. ADR 0039 gave it Flow: diff-styled trees showing which runtime
steps a change added, removed, or kept. Both answer a version of "what does
this change do," and having built Flow, keeping Goal beside it stopped making
sense.

The reason is not redundancy, it is direction. A reviewer opening a pull
request wants to understand the change without reading all of the code
first. Prose that restates the change does not get them there — it is a
sentence *about* the change, one more thing to read and cross-check against
the diff. Structure does get them there: Flow does not describe the change,
it *is* the change, laid out so the shape is visible before a single hunk is
opened. Goal was trying to do with sentences what Flow now does with a tree.

## The decision

Brief drops the **Goal**, **Assumptions**, and **Description vs diff**
(`descriptionDrift`) blocks. What remains is structure only: the **Flow**
views (ADR 0039), and the three deterministic blocks — **Shape** (the
`ownership` skeleton), **Start here**, and **Reach** — with the **Scope
gauge** (ADR 0037) beside them, unchanged, because it was never prose either.

Nothing else about how those four blocks work changes. Shape still groups
files by directory with its one contract hunk, Start here still orders the
first files to read, Reach still counts by text match one hop out, and Flow
still draws up to three kind-labelled trees. This decision only removes the
two prose blocks and the comparison block built on them.

### The citation rule, re-anchored on Flow

ADR 0036's rule lived on Goal: a sentence with no citation that resolved was
demoted to an Assumption, and a Brief whose every sentence demoted was
rejected outright (`InvalidBrief`, reason `uncited`). That mechanism assumed
prose that needed grading — a claim could be plausible but unsupported, worth
keeping at a lower confidence.

Flow's rule, from ADR 0039, replaces it with something looser: an `added` or
`removed` step is judged best effort rather than pass or fail. A step whose
citation survives draws a citation chip; a step whose citation does not
survive, or that names none at all, is kept anyway, drawn with a muted marker
and no chip. There is no lower confidence to demote to in the Goal sense,
because a Flow step was never a sentence to grade — it is a shape that is
either backed by the diff or shown plainly for what it is.

One consequence follows directly: **a Brief is never rejected as
"uncited."** A pull request that only renames things, reorders unrelated
code, or touches docs has no Flow tree to keep — the model omits Flow
entirely, by its own instruction, exactly as ADR 0039 already allowed — and
still has Shape, Start here, and Reach. That is a complete, valid Brief.
`InvalidBrief` keeps its `malformed` reason for output that fails to parse;
`uncited` has nothing left to reject and is removed. A tree left with no
changed step at all — every node unchanged — is still dropped whole, because
an unchanged spine with nothing to explain is noise, not a graceful case of
best effort.

`citationStatus` keeps its two values, re-anchored on the blocks that remain:
`"verified"` when normalization discarded no citation anywhere in the Brief
and every changed Flow step carries one that survived, `"partially_verified"`
when any citation was discarded or any changed step is uncited. The reader's
line describing it drops "· M assumptions" along with the concept, and drops
the per-Brief verified count too: what is left to say is the citation status
alone — "all citations verified" or "some citations could not be verified."

### Description vs diff is retired, not replaced

Description vs diff was the one block that read the pull request description
against the patch: claims the description makes that the diff does not
support, and behavior the diff changes that the description never mentions.
It goes with Goal and Assumptions, and that is a real loss stated plainly
here rather than folded into "cleanup" — Brief had no other block doing this
comparison, and after this change none does.

The check is not being replaced by anything in this ADR. A future ADR may
bring it back as its own Insight, or as an Analysis Finding, if a maintainer
still wants it; this decision only removes it from Brief.

With Description vs diff gone, no surviving Brief block cites a `d*`
(description) or `c*` (commit) alias — Flow already cited hunks only, and
Shape, Start here, and Reach never took citations at all. The citation
manifest (`briefManifest` in `src/domain/brief.ts`) now builds `h*` hunks
only; it stops producing `d*` and `c*` aliases, because there is no longer a
surviving block that could cite either. The PULL REQUEST DESCRIPTION and
COMMITS prompt sections drop out with it — the model is handed nothing to
cite from them — so a future block that reads description or commit text
brings both the manifest aliases and the prompt sections back with it,
rather than finding either already there.

A Brief retained under 0.1.3 can still carry `d*` and `c*` citations, stored
on its Goal and Description-vs-diff sentences before this decision.
`parseStoredBrief` keeps accepting all three alias kinds so that Brief still
opens; nothing in the current reader looks for `d*` or `c*` going forward,
since no surviving block produces them.

### Compatibility with stored Briefs

0.1.3 is tagged with retained Briefs that store `goal`, `assumptions`, and
`descriptionDrift`. Those keys stay in the stored schema as tolerated and
ignored for one release: a Brief retained under 0.1.3 still opens, but the
reader draws nothing from them — the same "absent evidence draws nothing"
rule ADR 0036 already used for a legacy Brief missing Reach or Start here.
Regenerating a Brief replaces the whole stored record with the new shape;
nothing migrates the old keys forward. The next release after this one drops
`goal`, `assumptions`, and `descriptionDrift` from the stored schema
entirely.

### The model contract and prompt

`briefOutputSchema` and `BRIEF_RESULT_CONTRACT` in `src/domain/brief.ts` drop
`goal`, `assumptions`, and `descriptionDrift`. `normalizeBrief` drops the
demotion loop, the `uncited` rejection path, and `normalizeDescriptionDrift`
along with it; what is left is Ownership, Start here, Flow, and the cited-hunk
cut, unconditionally combined rather than gated on a surviving Goal.

`insightOutputGuidance("brief")` drops "Cite every sentence" and the
paragraphs describing the drift comparison and the Assumption demotion. The
Flow, Shape, Start here, and Reach guidance is unchanged.

## Consequences

- Brief goes from six blocks to four, plus the always-on Scope gauge:
  Flow, Shape, Start here, Reach.
- Flow's header reads "how the sequence changed."
- The reader's summary line loses its assumption count and its verified-count
  tally; it names the citation status alone — "all citations verified" or
  "some citations could not be verified."
- `InvalidBrief` loses its `uncited` reason. A Brief with no Flow at all —
  a rename, a docs change, a pure refactor — is still a valid, retainable
  Brief; only a malformed result is rejected now.
- A Flow step without a surviving hunk citation is no longer dropped; it
  stays in its tree with a muted marker and no chip, and `citationStatus`
  reads `partially_verified` whenever any changed step lacks one or any
  citation elsewhere in the Brief was discarded.
- The description-drift check is given up, not replaced. No block compares
  the pull request description to the patch until a future ADR decides to
  bring that back, deliberately, as its own Insight or Analysis finding.
- The prompt drops the PULL REQUEST DESCRIPTION and COMMITS sections, and the
  manifest itself narrows to `h*` hunks only, since no surviving block cites
  a `d*` or `c*` alias; a future block that cites description or commit text
  brings its manifest aliases and prompt section back with it. A Brief
  retained under 0.1.3 can still carry `d*`/`c*` citations; the stored-Brief
  parser keeps accepting all three alias kinds even though no current block
  produces them.
- ADR 0036 remains the record of why Brief cites its evidence at all; its
  Goal/Assumption demotion mechanics are superseded here, not its
  citation-manifest mechanism, its Shape and Reach mechanics, or its "the
  model never writes a number" rule — though the manifest itself now narrows
  to hunks only, since nothing left cites anything else.
- Stored Briefs from 0.1.3 keep `goal`, `assumptions`, and `descriptionDrift`
  as tolerated-and-ignored keys for one release, then those keys are dropped
  from the stored schema.
- The product description (`docs/product-description/review-workbench/brief.md`)
  and Brief's test cases drop coverage of Goal, Assumptions, and description
  drift, and gain coverage of the no-Flow "still a valid Brief" case.
