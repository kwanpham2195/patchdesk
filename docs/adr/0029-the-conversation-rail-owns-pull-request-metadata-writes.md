# The conversation rail owns pull request metadata writes

Patchdesk fetches a pull request's reviewers and assignees and shows
neither. Labels are shown, but in the workbench header, wedged between
the checks pill, the merge pill, `PR overview`, and `Finish review` —
lifecycle controls that have nothing to do with them. A maintainer who
wants a second opinion, an owner for the work, or an answer to "is that
approval still good" leaves for github.com, which is the one thing a
local-first workbench exists to avoid.

## The decision

The Conversation screen carries a persistent right-hand rail — the
pull request metadata rail — holding Reviewers, Assignees, and Labels.
Each section shows current state and opens a search-driven picker that
writes it back to GitHub. The header loses its label chips and label
picker; metadata has one home and the header is left to lifecycle.

The rail is metadata only. It is not a second `PR overview`, and it
carries no lifecycle action — no merge, no convert-to-draft, no
submit.

## Why a persistent rail is allowed here

ADR "Use one progressive review workbench" chose an on-demand overlay
for pull request metadata specifically so the diff would keep its full
width while the overlay was closed. That reasoning is about the diff.
The Conversation screen holds a single reading column with unused space
on both sides and no diff to protect, so a rail there costs nothing the
overlay was defending.

The rail therefore lives on the Conversation screen only. It does not
appear on Diff or Insights, which keeps that ADR's protection intact
rather than reversing it. This amends the overlay choice for one
screen; it does not retire it.

Two consequences are accepted rather than worked around. Labels are no
longer visible at a glance while reading the diff — the maintainer must
be on Conversation to see or change them. And below the width at which
the rail and the reading column both fit, the rail reflows beneath the
timeline rather than hiding, because a write the maintainer cannot
reach on a laptop is worse than a long page.

## Why the write gate extends unchanged

ADR "Gate label writes on the current session" gates labeling on
`requireCurrentSession` rather than `requireFresh`, because a new
commit does not invalidate a label. The same holds for an assignee and
for a review request: neither is anchored to a patch, and neither
becomes wrong because someone pushed while the maintainer had the pull
request open. Both new write types take that gate.

Permission does not extend in the same way. Labels are governed by
label management, which GitHub's `triage` role grants without
pull-request write; reviewers and assignees need pull-request write.
Collapsing them would show an enabled reviewer picker to a triage-only
account. Permission is therefore resolved per write type, stays
three-state (`permitted` | `denied` | `unknown`), and fails closed:
`denied` disables the control, `unknown` leaves it enabled with a
warning that the change may be refused, and the service refuses any
write short of `permitted` whatever the interface allowed.

Removing a review request takes the subtractive REST endpoint while
adding one takes the GraphQL mutation with its union flag. The GraphQL
mutation replaces the whole reviewer set, so removing one person by
sending the remaining list would silently drop a request another
maintainer added since the last refresh. The asymmetry is deliberate
and is the reason the adapter speaks two protocols for one control.

## Why a verdict is bound to a revision

GitHub shows a green check whether the approval landed on the current
head or three pushes ago. Patchdesk knows the represented revision
precisely, so it can tell the difference, and "approved, but two
revisions ago" is exactly the fact a maintainer needs before merging.

A review verdict is therefore reported against the commit it was
submitted on, and marked outdated when that commit differs from the
represented revision's head. This is the same line the domain language
already draws for Mapped conversation thread: evidence is judged
against the pinned revision, not accepted because it exists.

Deriving the verdict needs both of GitHub's views. `latestReviews` can
omit a person entirely while they hold an open pending review, and
because Patchdesk's whole drafting model rests on GitHub pending
reviews, that is the common path here rather than an edge case. The
derivation unions `latestReviews` with `reviews`, keys by login, takes
each person's most recent *submitted* verdict, and ignores `PENDING`
outright. It is a pure function over the fetched reviewer data and the
represented head, kept out of rendering so it can be tested on its own.

## Rejected alternatives

Extend the `PR overview` overlay instead of adding a rail. It already
exists and already holds pull request metadata. Rejected because an
overlay is a place to look something up, not a place to work from: it
covers the timeline the maintainer is reading, and every write would
mean opening it again.

Put the rail on every screen. Rejected because it reverses the diff
width protection for the sake of consistency, and the header's
freshness and checks reporting already answers the at-a-glance
question on those screens.

Reuse the label permission for all three writes. Rejected above: it
would offer a triage-only account a reviewer picker GitHub will refuse.

## Consequences

- The rail reads from the same represented snapshot as the rest of the
  workbench and updates on explicit refresh. It does not poll; a rail
  that read independently could disagree with the header about the same
  pull request. Each section states that its state is as of the last
  refresh.
- Under Terminal remote state every section renders read-only with no
  settings control. The record of who reviewed and how it was labelled
  stays visible.
- Every confirmed metadata write appends a typed entry to the
  recent-write journal, and change detection strips the touched logins
  and label names from both sides of the comparison, so the
  maintainer's own change never reads back as remote activity.
- Re-requesting a review from someone who already reviewed is not
  offered. It is a fourth write path, for the least common action, and
  it notifies a person; it can be added once the request path exists.
