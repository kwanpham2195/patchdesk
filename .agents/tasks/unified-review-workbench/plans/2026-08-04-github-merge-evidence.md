---
created_at: 2026-08-04
repos:
  - patchdesk
status: complete
spec: .agents/tasks/unified-review-workbench/research/03-research-github-merge-reasons.md
---

# GitHub merge-evidence plan

## Goal

Replace Patchdesk’s raw/generic merge-blocker display with safe, actionable GitHub evidence. A maintainer should see the exact available reason—such as a required approval—while GitHub remains the authority for whether a merge can execute.

## Scope and invariant

- Initial PR open and explicit Refresh fetch remote merge evidence. No background application of remote state.
- GitHub aggregate merge state remains the hard write gate.
- Branch-protection and ruleset reads are optional evidence only. A 403/404 or unsupported endpoint must not fail Review refresh.
- Do not claim an exact policy failure unless GitHub supplied both the relevant configuration and matching PR state.
- Never render internal tags such as `merge_blocked`.

## Steps

1. Extend the existing GitHub GraphQL merge-policy query and parser.
   - Add `mergeStateStatus` next to `mergeable` and `reviewDecision`.
   - Add strict parsing and an explicit unavailable state rather than string casts.
   - Test parse behavior for `BLOCKED`, `BEHIND`, `DIRTY`, `DRAFT`, unknown values, and missing fields.

2. Read optional base-branch policy evidence through the existing command runner.
   - Read classic branch protection: `GET /repos/{owner}/{repo}/branches/{base}/protection`.
   - Capture only bounded review-policy fields: required approval count, stale-review dismissal, code-owner requirement.
   - Read active branch rules only if the configured GitHub host/API supports it.
   - Classify authorization/not-found/unsupported responses as absent optional evidence; classify malformed successful payloads as adapter failure.
   - Test normal, 403, 404, malformed, and command-timeout paths.

3. Model and persist typed merge evidence.
   - Add a `GitHubMergeEvidence` value in `src/domain/github-context.ts` and include it in `ReviewRemoteSnapshot`.
   - Retain existing `MergeReadiness` safety blocker tags for gates, but add a separate typed display-reason projection.
   - Preserve snapshot hash determinism and parse every persisted field.
   - Add snapshot round-trip and migration-safe tests.

4. Project human-readable reasons without overclaiming.
   - `REVIEW_REQUIRED` + known count → “N approving review(s) required by branch protection.”
   - `REVIEW_REQUIRED` without a readable rule → “Approval required by GitHub.”
   - `CHANGES_REQUESTED` → “Changes requested.”
   - `BEHIND` → “Update this branch with the base branch.”
   - `DIRTY`/conflicts → “Resolve merge conflicts.”
   - blocked with insufficient evidence → “GitHub merge requirements are not satisfied.”
   - Include source/availability labels: GitHub PR state, branch protection, or ruleset configuration.
   - Test precedence when several constraints apply.

5. Render merge reasons in PR Overview and the merge-confirmation dialog.
   - Replace raw blocker enum rendering in `pr-overview-sheet.tsx`.
   - Keep the confirmation dialog’s merge action disabled whenever existing readiness is blocked or unknown.
   - Link generic/partial evidence to the already-safe **Open on GitHub** action.
   - Add renderer tests: no raw tags, exact approval wording, generic fallback, and disabled merge action.

6. Verify the real surface.
   - Focused domain/adapter/projection/renderer tests first.
   - `pnpm test -- --run`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `git diff --check`.
   - Dedicated `$patchdesk-electron-tester` QA against an isolated Electron profile: approval-required fixture, blocked fallback, and no GitHub writes.
   - Fresh reviewer subagent before completion.

## Acceptance criteria

- A PR blocked because it lacks a required approval displays an approval requirement, not `merge_blocked`.
- If GitHub cannot disclose policy configuration, Patchdesk shows a safe generic reason and Open on GitHub.
- Optional policy-read failures never make an otherwise readable Review fail to refresh.
- Merge remains unavailable until GitHub’s actual merge state permits it.
- No raw domain tags appear in the UI.

## Phase 2 evidence (2026-08-04)

- Status: complete for standalone optional policy evidence adapter; snapshot persistence, projection, and renderer integration remain out of scope for this phase.
- Adapter: `getMergePolicyEvidence` reads bounded classic branch-protection review fields and applied branch-rule names/types through `CommandRunner`. Forbidden, not-found, and unsupported endpoint responses become per-source unavailable evidence; malformed successful payloads and command timeouts remain typed adapter failures.
- Safety: the read-only evidence method is separate from merge-policy readiness and the existing branch-protection capability path; it cannot authorize or issue GitHub writes.
- Tests: focused adapter coverage includes normal, 403, 404, unsupported, malformed, and timeout paths, plus explicit argv endpoint assertions.

## Phase 1 evidence (2026-08-04)

- Status: complete for GraphQL merge-state parsing and typed snapshot representation; optional REST policy reads, projection, and renderer work remain out of scope for this phase.
- Adapter: `mergeStateStatus` is queried and mapped strictly to typed lower-case statuses; unknown enum values map to `unknown`, while null/missing fields map to `unavailable`.
- Persistence: `GitHubMergeEvidence` is optional on `ReviewRemoteSnapshot`, validated on save/load, included in deterministic hashes, and omitted safely for legacy snapshots.
- Tests: focused adapter and remote-store suites cover all documented merge-state statuses, unknown/missing values, round-trip persistence, legacy omission, and invalid evidence.
- Validation: `pnpm exec vitest run tests/adapters/github-adapter.test.ts tests/storage/review-remote-store.test.ts`, `pnpm lint`, `pnpm typecheck`, and `git diff --check` pass.

## Phase 3–4 evidence (2026-08-04)

- Status: complete for optional policy evidence refresh/persistence and typed workbench display projection.
- Refresh fetches `getMergePolicyEvidence` only during explicit refresh (and initial open through refresh), tolerates optional read failures, and persists partial per-source availability alongside aggregate merge state.
- Workbench projection derives one precedence-ordered human-readable reason with source, availability, and safe Open-on-GitHub intent; existing `MergeReadiness` blockers remain unchanged for write gates.
- Tests: remote snapshot policy round-trip/hash, partial unavailable projection, and explicit refresh persistence coverage.
- Validation: focused Vitest suites, `pnpm lint`, and `pnpm exec tsc --noEmit` pass.

## Phase 3–4 blocker fixes (2026-08-04)

- Zero approval counts are omitted as unavailable evidence; unrelated applied rules no longer influence approval wording or source labels.
- Merge reasons with `openOnGitHub` now expose an explicit action in the PR Overview and blocked merge dialog through the validated external-link path.
- Lifecycle-free controller opens prepare and project the session directly again; durable lifecycle opens retain initial snapshot refresh behavior.
- Regressions cover zero/unrelated policy evidence, safe external navigation, and lifecycle-free first-open behavior.
- Validation: focused suites, lint, typecheck, build, and diff check pass. Full suite ran with one reproducible unrelated dashboard expectation failure (`restores an exact persisted workbench destination after restart`: expected two `Files` tabs, received one).

## Risks

- GitHub branch protection and rules endpoints vary by token permission, repository policy model, and Enterprise version. Evidence must remain optional.
- A configuration rule is not always a per-PR verdict; do not replace GitHub’s aggregate PR state with local inference.
- Ruleset APIs can change independently of GraphQL schema; bound and parse them at the adapter seam.

## Completion evidence

- 2026-08-04: Phases 1–4 were independently reviewed; final review found no blockers.
- 2026-08-04: `pnpm test -- --run` passed 106 files / 794 tests; `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `git diff --check` passed.
- 2026-08-04: Isolated Electron QA verified approval wording, disabled merge safety, no raw enum leakage, no GitHub/model writes, and no overflow. The generic blocked fallback is covered by renderer tests because the live fixture did not expose that state.
