# Derive merge readiness from applied rules

> **Status: Accepted.** Extends the bounded-parsing discipline set by the
> ADR "Choose a validation style by data boundary": external merge-rule
> payloads still parse into a named, bounded shape, but the boundary
> widens to the specific fields the panel needs instead of staying at
> `{ type, name }`.

The "Merge readiness" panel renders a red card reading "GitHub merge
requirements are not satisfied." with a small secondary label reading
"GitHub PR state · partial," and nothing else. `deriveMergeReasons` in
`src/services/review-workbench-projection.ts` (lines 644-751) produces
that content, and it has several compounding defects.

It reads the wrong evidence source. `getMergePolicyEvidence` in
`src/adapters/github/github-adapter.ts` fetches both
`repos/{owner}/{repo}/branches/{branch}/protection` (classic branch
protection) and `repos/{owner}/{repo}/rules/branches/{branch}`
(rulesets), returning both on `GitHubMergePolicyEvidence` as
`branchProtection` and `appliedRuleset`. `deriveMergeReasons` reads only
`aggregate.policy?.branchProtection` — it never reads
`.appliedRuleset`. On a repo governed by Rulesets rather than classic
protection, the classic endpoint legitimately 404s, so
`requiredApprovingReviewCount` stays undefined and `availability`
becomes `"partial"`, even though the ruleset endpoint the adapter
already called holds the answer.

The evidence it needs is fetched and then discarded.
`GitHubAppliedRulesetEvidence` in `src/domain/github-context.ts` keeps
only `{ type, name }` per rule — its comment reads "Bounded rule
names/types returned by the applied branch-rules endpoint" — so rule
`parameters` are parsed away before anything downstream can see them. A
live probe of the ruleset endpoint on a real repo, readable by a
non-admin account, returned a `pull_request` rule with
`required_approving_review_count: 1`, `require_last_push_approval:
true`, `required_review_thread_resolution: true`,
`dismiss_stale_reviews_on_push: false`, and `require_code_owner_review:
false`, plus a `required_status_checks` rule listing the required
contexts. That is the same information GitHub's own UI renders as "New
changes require approval from someone other than the last pusher" and
the "Required" badge on a check.

The domain model already reserved space for this evidence.
`MergeDisplayReason.source` in `src/domain/github-context.ts` (line 93)
declares a `"ruleset_configuration"` variant alongside
`"github_pr_state"`, `"branch_protection"`, and `"checks"`, but no
branch in `deriveMergeReasons` currently emits it. The sibling variant
`"branch_protection"` is emitted, at lines 679 and 688, when a positive
classic review count is available, so this is not the whole field going
unused — only the ruleset-sourced variant was declared and left
unwired.

It reports at most one reason. The function is a chain of early
returns — `review_required`, then `changes_requested`, `behind`,
`conflicts`, `checks`, `blocked` — so "checks pending AND review
required" can never both be shown.

Two states render nothing at all. `GitHubMergeStateStatus` includes
`has_hooks` and `unstable`, and both fall through every branch to the
final `return []`, silently producing no reason.

It asserts more than it knows. The `blocked` branch emits the fixed
message "GitHub merge requirements are not satisfied." regardless of
`availability`; the message text never varies, only the small secondary
label does.

Unknown renders as failed. `mergeability_unknown` — whose own copy in
`pr-overview-sheet.tsx` reads "GitHub merge status is unavailable." —
renders through the same `destructiveCard` and `XCircle` treatment as a
confirmed `conflicting`, and pushes the header to "Blocked" because
`evaluateReadiness` sets `_tag: "Blocked"` whenever
`blockers.length > 0`, with no separate tag for "unknown."

`reviewDecision` is unreliable on ruleset repos. A live probe found a
pull request with a genuine approving review from a non-last-pusher
whose GraphQL `reviewDecision` was `null` rather than `APPROVED`. It
appears to reflect only classic branch-protection review rules, not
ruleset-based ones.

`mergeRequirements` does not exist. GraphQL schema introspection
confirms `PullRequest.mergeRequirements` is absent — not preview-gated,
not permission-denied. There is no ready-made structured "why is this
blocked" field to consume.

## The decision

Merge readiness derives from the rules GitHub actually applies, not
solely from classic branch protection. `GitHubAppliedRulesetEvidence`
keeps a bounded, explicitly named set of rule parameters — the ones
Patchdesk actually displays — rather than the raw payload. Bounded
parsing is retained deliberately; the fix is to widen the boundary to
the fields that are needed, not to abandon it. Emitting
`"ruleset_configuration"` as a reason `source` completes what the type
already declared; it is wiring up a variant that was reserved, not
introducing a new one.

The panel reports every applicable blocker rather than the first one
found.

Confidence is expressed in the claim itself. When evidence is
incomplete, the panel says what it does not know instead of asserting a
definite negative in the message and hiding the qualification in a
secondary label.

Unknown is not failure. A state Patchdesk cannot determine gets a
neutral treatment, not the destructive one used for a confirmed
blocker.

`reviewDecision` is not sufficient evidence of a review requirement on
its own; ruleset-derived requirements take precedence where both are
present.

## Rejected alternatives

Show GitHub's own sentence verbatim. No API returns those strings; the
web UI composes them client-side from structured data. Patchdesk must
compose its own from rules it can actually read.

Wait for `mergeRequirements`. Introspection shows it does not exist in
the schema. Designing around it would be designing around nothing.

Ingest the whole ruleset payload. This codebase parses external
payloads into bounded, named shapes at the boundary, per the ADR
"Choose a validation style by data boundary." Widening the boundary to
specific named parameters keeps that discipline; accepting arbitrary
JSON abandons it.

## Consequences

- The panel can name the specific rule blocking a merge, matching what
  the maintainer sees on GitHub.
- Repos governed by Rulesets stop reporting "partial" for evidence
  Patchdesk already holds.
- Every new rule parameter Patchdesk wants to display requires a
  deliberate boundary change — the cost of bounded parsing, accepted on
  purpose.
- A repo where both classic protection and rulesets are unreadable
  still yields a low-confidence state; the panel must say so honestly
  rather than guessing.
- More reasons can appear on screen at once. The panel must stay
  readable when several rules block at the same time.
- `reviewDecision` remains in the projection for classic-protection
  repos, so two sources of review-requirement truth coexist and must be
  reconciled explicitly.
