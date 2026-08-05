---
created_at: 2026-08-04
repos:
  - patchdesk
status: complete
---

# GitHub merge-blocker evidence research

## Question

How can Patchdesk replace the generic `merge_blocked` state with actionable GitHub merge-policy evidence, without treating its own inference as merge authorization?

## Existing Patchdesk behavior

- `GitHubAdapter` already queries GraphQL `PullRequest.mergeable`, `reviewDecision`, and the head commit's status-check rollup in `src/adapters/github/github-adapter.ts`.
- `ReviewWorkbenchProjectionService` collapses `mergeability: "blocked"` into the `merge_blocked` blocker in `src/services/review-workbench-projection.ts`.
- `pr-overview-sheet.tsx` renders that internal enum verbatim. `merge-confirmation-dialog.tsx` translates it only to “blocked by GitHub.”
- This loses GitHub's actual explanation. The observed PR required one approval from a reviewer with write access.

## Official GitHub API evidence

### Pull request state (GraphQL)

GitHub GraphQL `PullRequest` exposes:

- `mergeable`: coarse mergeability (`MERGEABLE`, `CONFLICTING`, or `UNKNOWN`).
- `mergeStateStatus`: detailed aggregate state, including `BLOCKED`, `BEHIND`, `DIRTY`, `DRAFT`, `HAS_HOOKS`, `UNSTABLE`, and `CLEAN`.
- `reviewDecision`: GitHub's aggregate review decision (`APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or null).

This is sufficient to distinguish “review required” from an otherwise generic blocked state, but it does **not** expose the numeric approval rule or whether an approval must come from a writer.

Source: [GitHub GraphQL Pull requests reference](https://docs.github.com/en/graphql/reference/pulls).

### Branch protection (REST)

`GET /repos/{owner}/{repo}/branches/{branch}/protection` returns the base branch's classic protection configuration. Its `required_pull_request_reviews` object includes `required_approving_review_count` and review-dismissal/stale-approval settings.

This can explain the common “N approvals required” rule. It is configuration evidence, not a per-PR pass/fail verdict, and may be unavailable when the token cannot read branch protection or the branch is governed through rulesets instead.

Source: [REST branch protection](https://docs.github.com/en/rest/branches/branch-protection).

### Repository rulesets (REST)

`GET /repos/{owner}/{repo}/rules/branches/{branch}` lists active rules that apply to a branch. It supports modern repository and organization rulesets, which can supersede or complement classic branch protection.

Patchdesk must treat ruleset output as policy configuration. It should not invent an exact failure reason when GitHub only gives the aggregate PR state.

Source: [REST rules endpoints](https://docs.github.com/en/rest/repos/rules).

## Recommended mapping

1. Extend the existing `mergePolicyQuery` with `mergeStateStatus`.
2. Persist a typed remote `GitHubMergeEvidence` alongside the existing policy snapshot:
   - aggregate: `mergeable`, `mergeStateStatus`, `reviewDecision`;
   - optional classic review rule: `requiredApprovingReviewCount`, `dismissStaleReviews`, `requireCodeOwnerReviews`;
   - optional applied-rules summary: rule names/types only when the rules endpoint is authorized and succeeds.
3. Derive presentation blockers in priority order:
   - `reviewDecision === REVIEW_REQUIRED` → “Approval required”; if the classic rule is known, “N approving review(s) required by branch protection.”
   - `reviewDecision === CHANGES_REQUESTED` → “Changes requested.”
   - `mergeStateStatus === BEHIND` → “Branch must be updated with the base branch.”
   - `mergeStateStatus === DIRTY` / `mergeable === CONFLICTING` → “Resolve merge conflicts.”
   - failing required check evidence → “Required checks have not passed.”
   - remaining `BLOCKED` → “GitHub merge requirements are not satisfied,” with an **Open on GitHub** link.
4. Keep the existing `merge_blocked` domain value only as a conservative write gate; add a separate typed, display-only evidence list. GitHub remains the authority for merge execution.
5. Never show raw enum values in the UI. The PR Overview should render display labels and source/availability state, not domain tags.

## Implementation slices

1. **Adapter and domain**
   - Add `mergeStateStatus` to the GraphQL query/schema and `GitHubMergeEvidence` to `src/domain/github-context.ts`.
   - Add bounded REST reads for base-branch protection and applied rules. A 403/404 must yield unavailable optional evidence, not fail the Review refresh.
   - Tests: GraphQL parsing, REST parsing, unavailable/unauthorized evidence.

2. **Remote snapshot and projection**
   - Persist evidence in `ReviewRemoteSnapshot`.
   - Project typed display reasons separately from safety blockers.
   - Tests: exact mapping for review required, changes requested, behind, conflicts, required checks, and unknown blocked.

3. **Renderer**
   - Replace raw values in `pr-overview-sheet.tsx` with a merge-reasons list.
   - Include source labels: “GitHub PR state,” “branch protection,” or “ruleset configuration.”
   - Provide “Open on GitHub” for generic/partial evidence.
   - Tests: no raw enum leakage; exact writer-approval wording when rule evidence exists; safe generic fallback when it does not.

4. **Refresh and safety**
   - Fetch this evidence only during initial PR open and explicit Refresh; no background application of remote policy.
   - A partial policy read must keep merge disabled whenever GitHub reports blocked/unknown.
   - Verify the native bridge opens the exact same-host PR URL only.

## Decision to make before implementation

Confirm whether Patchdesk should make optional branch-protection/ruleset reads with the user’s normal token. Recommendation: yes, but classify 403/404 as partial evidence and keep the GitHub aggregate status as the source of truth.
