# Show only conversation threads the diff can place

Patchdesk splits GitHub review threads by whether they carry a code
anchor. `assembleConversation` in
`src/adapters/github/github-adapter.ts` sends a thread with a
`location` into `conversation.inline.threads` and one without into the
Conversation timeline as a `GeneralThread`. The inline set is then
mapped onto the current diff by `mapConversationThread` in
`src/renderer/src/inline-conversation-mapping.ts`, which excludes a
thread in three cases: GitHub marked it `outdated`, it carries no line
or side (`unanchored`), or its path and line do not exist in the
represented revision's diff (`unmapped`).

The exclusion reason is computed and then dropped.
`projectReadOnlyConversationAnnotations` returns `[]` for an excluded
thread, so nothing downstream can distinguish "no threads here" from
"threads we could not place". An unresolved thread whose anchor stops
matching the pinned revision therefore disappears from Patchdesk
entirely, while still blocking the "all conversations resolved" gate
on GitHub.

## The decision

That exclusion stands, deliberately, and it now also governs the
Threads navigator section. Patchdesk surfaces only Conversation
threads it can place on the current revision. Threads it cannot place
produce no entry, no count, and no badge anywhere in the workbench.

The Threads section lists exactly what the diff renders as a
conversation annotation — nothing more, nothing less. That rule, not a
judgement about which threads matter, decides membership.

## Why

A Review session is anchored to one pinned revision. A thread that
cannot be placed on that revision has no evidence in the workbench to
be judged against: `diffHunk` is not in the selection set of any of
the queries in `src/adapters/github/github-graphql-queries.ts`, so
Patchdesk does not hold the code the thread was written about.
Surfacing it would mean showing comments with no code beside them and
no action available — a prompt to leave for GitHub, dressed as part of
the review.

Every entry in the Threads section can be selected and reached.
Admitting entries with no destination would make "selecting does
nothing" a normal state, which costs more than the omission does.

## Rejected alternatives

List unplaceable threads with a badge explaining why they cannot be
placed. This keeps the workbench honest about what it holds, but it
puts unactionable rows in a section whose only purpose is to navigate,
and it needs `diffHunk` plumbed end to end — a new GraphQL field, a
new field on `DiffLocation`, and a new wire schema — to show anything
more useful than a path.

Show a single count at the foot of the section. Cheaper, and it
removes the silent hole. Rejected because a count a maintainer cannot
act on inside Patchdesk is a standing instruction to go and check
GitHub, which is where that question already belongs.

## Consequences

- The Threads section is wayfinding, not a completeness check. It
  cannot answer "is everything on this pull request resolved" and
  must not be read as a merge gate; GitHub owns that question.
- A maintainer can resolve every thread the section shows and still be
  blocked on GitHub by one it never displayed.
- If outdated threads turn out to be common in practice, this is the
  decision to revisit — the exclusion reasons are already computed in
  `inline-conversation-mapping.ts` and only need to stop being
  discarded.
