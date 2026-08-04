# Unified Review Workbench

This task package owns the remaining spec and design repair for Patchdesk's
unified Review workbench. The original implementation program is complete and
archived. Start new implementation work from the current repair ExecPlan.

## Start here

Read these files in order:

1. [Product specification](spec.md)
2. [Core no-regression contract](research/02-research-core-no-regression-contract.md)
3. [UI design reference](design/design.md)
4. [Current UI inventory](design/current-ui-inventory.md)
5. [Design-conformance review](2026-08-03-design-conformance-review.md)
6. [Spec/code review](2026-08-03-spec-code-review.md)
7. [Combined spec and design repair ExecPlan](plans/2026-08-03-unified-review-spec-and-design-repair.md)
8. [Implementation handoff](IMPLEMENTATION-HANDOFF.md)

The specification and ADRs own behavior. The design reference owns layout and
interaction composition when it agrees with those contracts. The two reviews
record current code and UI gaps. The combined repair ExecPlan is the only active
implementation plan.

## Active implementation

- [Combined spec and design repair ExecPlan](plans/2026-08-03-unified-review-spec-and-design-repair.md) — TODO

The repair covers all 18 spec/code findings and all 16 design findings. It
includes protected-route and lifecycle safety matrices, deterministic UI
states, focused tests, full repository gates, and required packaged/live
Electron verification.

## Archived implementation

The [plan archive](plans/archive/README.md) contains the completed program plan
and its Foundation, Unified UI, Insights, and Feedback and merge phases. These
files are historical references. Do not execute them again.

## Architecture decisions

- [0001: Manual GitHub refresh](../../../docs/adr/0001-manual-github-refresh.md)
- [0002: Preserve Review drafts across revisions](../../../docs/adr/0002-preserve-review-drafts-across-revisions.md)
- [0003: Retain the latest successful artifacts](../../../docs/adr/0003-retain-the-latest-successful-artifacts.md)
- [0004: Use one progressive Review workbench](../../../docs/adr/0004-use-one-progressive-review-workbench.md)
- [0005: Follow the pull-request lifecycle](../../../docs/adr/0005-follow-the-pull-request-lifecycle.md)
- [0006: Separate draft and Published feedback](../../../docs/adr/0006-separate-draft-and-published-feedback.md)
- [0007: Limit Insight comment mapping to Findings](../../../docs/adr/0007-limit-insight-comment-mapping-to-findings.md)
- [0008: Seed Review drafts from Analysis](../../../docs/adr/0008-seed-review-drafts-from-analysis.md)
- [0009: Structure the Analysis Review body](../../../docs/adr/0009-structure-the-analysis-review-body.md)
- [0010: Choose an Analysis completion action per run](../../../docs/adr/0010-choose-an-analysis-completion-action-per-run.md)
- [0011: Make Analysis merge policy configurable](../../../docs/adr/0011-make-analysis-merge-policy-configurable.md)
- [0012: Run Insight types independently](../../../docs/adr/0012-run-insight-types-independently.md)
- [0013: Keep model runs bounded and non-authoritative](../../../docs/adr/0013-keep-model-runs-bounded-and-non-authoritative.md)
