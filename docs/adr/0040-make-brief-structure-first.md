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
files by directory, Start here still orders the first files to read, Reach
still counts by text match one hop out, and Flow still draws up to three
kind-labelled trees. This decision only removes the two prose blocks and the
comparison block built on them.

Shape's one contract hunk goes too. It asked the model to name the one hunk
whose signature or type explains the rest of the patch, cut that hunk out of
the patch, and show it under the Shape tree with a one-line caption. Flow now
covers the same ground: a changed step's citation chip opens the same kind of
hunk preview, with the same one-line reason, right beside the step it
explains. Asking the model to additionally pick one hunk to feature under
Shape bought nothing Flow plus the hunk preview did not already cover, so
Shape keeps only its file tree and per-file `ownership.notes`.

### Citation status

ADR 0036's rule lived on Goal: a sentence with no citation that resolved was
demoted to an Assumption, and a Brief whose every sentence demoted was
rejected outright (`InvalidBrief`, reason `uncited`). That mechanism assumed
prose that needed grading — a claim could be plausible but unsupported, worth
keeping at a lower confidence.

ADR 0039 defines Flow's best-effort citation rule. This ADR makes it the only
citation rule left in Brief. A changed Flow step without a surviving hunk
citation stays visible with a muted marker and no chip.

**A Brief is never rejected as "uncited."** A pull request with no applicable
Flow still has Shape, Start here, and Reach. `InvalidBrief` keeps its
`malformed` reason for output that fails to parse.

`citationStatus` is `"verified"` only when every changed Flow step has a
surviving citation and none were discarded. Otherwise it is
`"partially_verified"`. The reader shows the status alone.

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
- The description-drift check is given up, not replaced. No block compares
  the pull request description to the patch until a future ADR decides to
  bring that back, deliberately, as its own Insight or Analysis finding.
- Stored Briefs from 0.1.3 keep `goal`, `assumptions`, and `descriptionDrift`
  as tolerated-and-ignored keys for one release, then those keys are dropped
  from the stored schema.
- The product description (`docs/product-description/review-workbench/brief.md`)
  and Brief's test cases drop coverage of Goal, Assumptions, and description
  drift, and gain coverage of the no-Flow "still a valid Brief" case.
- Shape drops its one contract hunk and the `ownership.contract` key that fed
  it; the model is no longer asked to pick one explaining hunk, and a Brief
  retained before this change keeps `contract` in its stored `ownership` as a
  tolerated-and-ignored key.
