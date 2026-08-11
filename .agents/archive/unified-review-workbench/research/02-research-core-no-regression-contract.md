# Research: Core no-regression contract

Date: 2026-08-01

Question: Which existing Patchdesk contracts must the unified Review workbench preserve?

## Conclusion

The redesign may replace prepared, completed, model-review, and read-only UI branches. It must preserve Patchdesk's lifecycle, revision identity, freshness gates, local draft ownership, explicit GitHub writes, bounded model behavior, merge safety, sandbox, and recovery evidence.

The core contract is behavior, not the current component tree. Layout and styling may change when the same information, safety boundary, and user action remain reachable.

## P0 no-regression contracts

### One Review and one persistent workbench

- One Review follows an open pull request across commits, Analysis, drafting, publication, and later discussion. Publishing and Analysis completion are milestones, not terminal states.
- A Review session remains immutable and bound to one profile, pull request, head revision, and patch.
- Only a GitHub merged or closed state makes the Review terminal. Prior code, Insights, and Published feedback remain inspectable.
- Do not reintroduce prepared, completed, model-review, manual-review, or read-only modes in routes, renderer contracts, labels, or accessibility copy.

Evidence: [spec.md](../spec.md#L154-L161), [CONTEXT.md](../../../../CONTEXT.md#L7-L28), [ADR 0005](../../../../docs/adr/0005-follow-the-pull-request-lifecycle.md#L1-L5).

### Stable GitHub state and explicit refresh

- The visible GitHub snapshot changes only after an explicit refresh. Background detection may set `Updates available`, but it must not replace visible commits, discussion, checks, or review state.
- Show the last refresh time. Do not infer remote updates from elapsed time alone.
- Pause review publication, Published feedback mutation, thread mutation, and merge while updates are detected or freshness is unavailable.
- Keep code, Insights, and local Review draft editing available while remote writes are paused.
- Apply refresh atomically to the same workbench. A head change creates a newer immutable Review session.
- A failed refresh preserves the prior readable local state.

Evidence: [spec.md](../spec.md#L174-L183), [ADR 0001](../../../../docs/adr/0001-manual-github-refresh.md#L1-L7), [review submission tests](../../../../tests/services/review-submission-service.test.ts#L177-L199).

### Local draft ownership and anchor safety

- Keep one Review draft shared by Files and Insights. It contains the Review body, inline comments, replies, and thread actions.
- Analysis may seed an empty draft. It must not overwrite maintainer-edited content without a previewed merge or explicit replacement.
- Preserve every unpublished draft item across refresh and migration.
- Move an inline draft only after one exact match for its selected code and bounded context on the same path and diff side.
- Missing or ambiguous anchors retain their original context under `Needs attention`. The maintainer must reattach, convert to Review body text, or remove them before publication.
- Never silently delete or omit draft content.

Evidence: [spec.md](../spec.md#L185-L192), [spec.md](../spec.md#L226-L233), [ADR 0002](../../../../docs/adr/0002-preserve-review-drafts-across-revisions.md#L1-L5).

### Optional and revision-bound Insights

- Files remains fully usable without Analysis. Model work is optional.
- Analysis and Walkthrough may run independently, with at most one active run per type.
- Keep the latest successful result visible while its replacement runs. Replace it only after a successful, current, validated completion.
- Failed or cancelled replacements preserve the retained result.
- Old-revision results remain readable as `Outdated`, but cannot navigate old evidence, populate current Findings, create Review draft content, authorize publication, or influence merge policy.
- Remote activity warns and revokes publication authorization. It does not cancel an active Insight run.
- Walkthrough stays finite, tool-free, cancellable, and bound to stored artifacts. It does not create Findings or inline Review draft items.

Evidence: [spec.md](../spec.md#L194-L205), [ADR 0003](../../../../docs/adr/0003-retain-the-latest-successful-artifacts.md#L1-L7), [ADR 0012](../../../../docs/adr/0012-run-insight-types-independently.md#L1-L7).

### Trusted prompts and bounded model authority

- Patchdesk, not the model, owns the workflow. The app prepares immutable context and patch artifacts, selects the requested model and reasoning level, starts one finite run, validates the result, maps it to the current revision, and decides what the UI may retain or publish.
- Keep a fixed instruction hierarchy: trusted Patchdesk policy first, repository-selected review criteria second as untrusted evidence, and prepared pull-request data last as untrusted evidence. Patch text, PR text, comments, checks, tool output, `AGENTS.md`, configured rules, and other repository content cannot grant tools, change the output schema, or override safety policy.
- Analysis may use only the session-bound inspection surface for the prepared revision: list changed files, literal search across changed files, bounded line reads, and immutable Git reads. It has no arbitrary shell, checkout mutation, credential, GitHub-write, publication, thread, or merge capability.
- Walkthrough receives bounded stored context and patch artifacts, uses no tools, and has no write surface. It returns only an ordered semantic explanation linked by exact request-local hunk aliases. It cannot create Findings, draft comments, or actions.
- Model outputs must pass strict, size-bounded schemas and semantic consistency checks. Invalid, oversized, malformed, stale, or mismatched output fails the replacement run and leaves the last successful result intact.
- The model may propose Finding coordinates and prior-Finding assessments, but Patchdesk computes final diff mapping, postability, draft creation, freshness, publication authorization, and merge eligibility. The model never publishes directly.
- Incremental Analysis uses an exact base/head comparison, its incremental patch, and tokenized prior-Finding evidence. A prior Finding may be `still_present`, `resolved`, or `unverified`; resolution requires comparison evidence.
- Keep model/provider diagnostics bounded and local. Prompts, hidden reasoning, provider events, credentials, raw command output, local paths, and stack traces must not become model output, renderer recovery copy, or GitHub content.

The product may remove `read-only` from user-facing labels and rewrite that phrase inside model instructions. The capability boundary remains: model runs can inspect only their prepared evidence and can never mutate the checkout or GitHub.

Evidence: [review rubric](../../../../src/services/review-rubric.ts#L15-L72), [review runner](../../../../src/services/model-review-runner.ts#L14-L74), [review workflow](../../../../src/workflows/review-pr.ts#L12-L62), [model result schema](../../../../src/domain/review-result.ts#L120-L170), [walkthrough workflow](../../../../src/workflows/generate-walkthrough.ts#L8-L149), [prompt hierarchy tests](../../../../tests/services/review-rubric.test.ts#L5-L75), [walkthrough boundary tests](../../../../tests/workflows/generate-walkthrough.test.ts#L114-L198).

### Structured Analysis and deterministic Findings

- Analysis produces structured content in this order: Review Scope, Pull Request Overview, Reviewed Changes, optional Verification, Findings, Verdict, and optional Human Reviewer Callouts.
- Patchdesk computes Finding mapping from the immutable patch. Model output cannot declare a Finding postable.
- Only a current Mapped finding may become a proposed inline comment. General or non-postable concerns remain naturally in the Review body without an `Unmapped` category.
- Adding a Finding creates an independent editable draft copy. Later Analysis runs cannot mutate that copy.
- Every successful replacement creates a fresh Finding set. Dismissals require a human reason and do not carry between runs.

Evidence: [spec.md](../spec.md#L207-L224), [ADR 0007](../../../../docs/adr/0007-limit-insight-comment-mapping-to-findings.md#L1-L9), [ADR 0009](../../../../docs/adr/0009-structure-the-analysis-review-body.md#L1-L7).

### Explicit and recoverable GitHub publication

- Preview the exact Review body, included inline comments, included thread actions, GitHub decision, current head, and warnings before publishing.
- A publication choice authorizes one run and one immutable revision only. Cancel it when revision, remote state, draft safety, or Analysis outcome changes.
- Preserve the two-stage pending-review and submit protocol, durable ordered evidence, idempotency, and unknown-outcome reconciliation underneath the simplified UI.
- Do not clear the Review draft until GitHub confirms the complete intended outcome.
- Confirmed content becomes GitHub-owned Published feedback. Start a new empty Review draft for later feedback.
- Partial or unknown outcomes preserve local intent and evidence and block conflicting retries.
- Editing or deleting Published feedback follows GitHub permissions. A submitted review decision is a review record, not a deletable comment.

Evidence: [spec.md](../spec.md#L235-L253), [ADR 0006](../../../../docs/adr/0006-separate-draft-and-published-feedback.md#L1-L5), [publication tests](../../../../tests/services/review-submission-service.test.ts#L43-L76).

### Maintainer-owned merge decisions

- Analysis merge policy is profile-scoped: Advisory, Require acknowledgement, or Block. Require acknowledgement is the default.
- Added-to-draft high-severity Findings remain open. Dismissed Findings stop affecting Analysis policy. Missing or outdated Analysis has no policy effect.
- GitHub branch rules, current-head equality, required checks, mergeability, unresolved write safety, and explicit merge confirmation remain non-configurable blockers.
- Every merge is an explicit SHA-bound GitHub action.

Evidence: [spec.md](../spec.md#L255-L263), [ADR 0011](../../../../docs/adr/0011-make-analysis-merge-policy-configurable.md#L1-L9), [current journey research](../../current-user-journeys/01-research-current-user-journeys.md#L233-L255).

### Security, persistence, and bounded recovery

- Keep the renderer sandboxed with no Node.js or shell access.
- Keep the local API loopback-only, origin-checked, and protected by a per-launch capability.
- Do not persist GitHub credentials.
- GitHub writes and external link opening remain explicit user actions.
- Exclude provider errors, prompts, local paths, secrets, and stack traces from renderer recovery copy.
- Migration preserves unpublished drafts, remote-write evidence, retained Analysis, retained Walkthrough, immutable revision identity, and terminal merge evidence.
- Unsafe legacy data remains preserved behind bounded recovery. Cleanup stays profile-owned, path-checked, serialized, idempotent, and limited to non-running sessions.

Evidence: [README.md](../../../../README.md#L24-L28), [spec.md](../spec.md#L149-L161), [spec.md](../spec.md#L265-L270).

### Accessibility, responsive reachability, and performance

- Files, Findings, Commits, Insights, the Review draft, publication, and merge remain keyboard-operable.
- Preserve focus during background changes and restore it after previews and overlays close.
- Announce bounded Insight and publication progress without replacing the active surface.
- Communicate freshness, Insight status, Finding state, draft attention, and merge readiness with text and icons, not color alone.
- Keep required controls reachable at 1280px and 1440px without viewport-level horizontal overflow.
- Preserve existing large-diff and streaming performance assertions.

Evidence: [spec.md](../spec.md#L272-L280), [spec.md](../spec.md#L284-L298), [browser workbench tests](../../../../tests/browser/review-workbench.spec.ts#L577-L641).

## Replaceable UI and implementation details

These are not regression obligations:

- The prepared/completed renderer split and its duplicated action wiring.
- `read-only` terminology or a separate read-only destination.
- Existing component names, routes, DOM structure, spacing, or control placement.
- Exact prompt sentences, section wording, default model, default reasoning level, or prompt-tuning strategy, provided the trusted hierarchy, evidence boundary, tool restrictions, structured result contract, and lifecycle behavior remain intact.
- A permanent right rail. The current design uses an on-demand overlay; the GitHub context and merge-readiness information still must remain reachable.
- Walkthrough-created inline comments. The unified contract limits Insight-to-inline mapping to current Mapped findings; manual comments still originate from current Files evidence.
- User-facing Analysis or Walkthrough history, previous-revision code viewing, semantic Finding matching, persisted commit selection, commit-scoped Analysis, Findings grouping/search, or an `Unmapped` category.

## Acceptance gate

The protected browser and loopback API remain the primary acceptance seam. One seeded journey must cover Files, Findings, Commits, Insights, Analysis completion, Review draft editing, remote-update detection, explicit refresh, anchor recovery, one confirmed GitHub review, and terminal pull request projection.

The regression suite must separately prove freshness gating, exact draft carry-forward, Insight retention, deterministic Finding mapping, publication recovery and idempotency, merge policy, accessibility, responsive reachability, and large-diff performance.

Evidence: [spec.md](../spec.md#L282-L298).
