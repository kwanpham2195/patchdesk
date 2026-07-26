# PR description generation

**Status:** Proposed; awaiting review

## Summary

Patchdesk should help a PR manager turn an existing pull request into a clear,
reviewer-focused description without silently overwriting the author’s work.
The user explicitly requests **Generate PR description**, chooses the model and
reasoning level, reviews an editable Markdown proposal, and then either copies
it or explicitly confirms an update to GitHub.

The first version is a suggested update, not an automatic rewrite. It starts
from the current PR body, preserves protected human content and repository
context, adds only evidence-backed sections, and shows a diff before any write.
It follows the local `github-pr-body` writing rules: explain motivation before
details, use an inverted pyramid, keep the body short, derive API/test/release
content from evidence, and never invent motivation, test results, issue links,
trade-offs, or claims about the change.

## Goals

- Generate a concise, reviewer-focused PR description from the exact PR
  snapshot, current body, diff, checks, commits, and available issue/stack
  context.
- Preserve human-authored notes, images, attachments, links, rollout warnings,
  and stack metadata byte-for-byte in the initial proposal.
- Make the proposal editable and reviewable before copy or GitHub update.
- Re-check the PR body and current `HEAD` immediately before an explicit GitHub
  update, and reject stale proposals instead of overwriting newer work.
- Use a separate finite LLM workflow with the same model/reasoning selection,
  diagnostics, capability checks, and stale-snapshot handling as the narrative
  walkthrough.
- Keep GitHub writes in the privileged main process and behind the existing
  explicit confirmation boundary.
- Produce standard reviewer sections only when supported by the diff or
  observed checks.
- Support stacked PRs by describing the net change from that PR’s base to head,
  not the entire stack against trunk.

## Non-goals

- Generating or changing the PR title in V1.
- Automatically updating a PR when a review completes, a branch changes, or a
  workbench opens.
- Automatically creating issues, comments, assignments, labels, reviewers,
  merges, or releases.
- Rewriting or “improving” a human note, stack block, image, attachment, link,
  warning, or rollout instruction.
- Inventing motivation, trade-offs, issue links, API impact, test results,
  release notes, or manual verification.
- Adding hidden Patchdesk markers to the saved PR body in V1.
- Creating a second durable review-draft or comment store.
- Exposing `gh`, credentials, local paths, raw model output, process handles,
  stack internals, or GitHub write tokens to the renderer.

## Audience and writing contract

Patchdesk serves maintainers and PR managers who understand basic GitHub, Git,
and LLM concepts. The generated body may use `PR`, `HEAD`, branches, checks,
`read-only`, model, and `Reasoning` where those concepts help a reviewer make
a decision. It must not expose Patchdesk implementation terms such as
quarantine, worktree, checkout, session, attempt, runtime, agent, or lifecycle.

The description starts with the reason the PR exists and then explains the net
change. When natural, the first paragraph follows:

    In order to <concrete situation>, this PR <does the change>.

The generator must not use a circular summary such as “In order to implement
this PR, this PR implements this PR.” If the motivation is not present in the
PR body, commits, linked issues, or user-provided context, it must say that the
motivation is not documented rather than guessing.

Generated descriptions use sentence case, short paragraphs, and concise
bullets. They do not narrate every changed file or repeat type signatures.

## Product contract

### Entry point

The completed review workbench exposes **Generate PR description** only for a
stable, prepared snapshot with enough PR context to form a safe proposal. The
action is unavailable while preparation is pending, a review attempt is
running, the local snapshot needs preparation, or the reviewed `HEAD` is stale.

Selecting the action opens a compact dialog with:

- `Model`, sourced from the active Pi catalog;
- `Reasoning`, with `Low`, `Medium`, and `High`;
- a statement that generation reads the saved PR snapshot and does not write
  to GitHub;
- a clear unavailable-catalog state when no enabled model exists.

The dialog restores the existing valid per-profile model/reasoning preference.
It does not start a request until the user confirms **Generate PR description**.

### Proposal states

The renderer receives only these user-facing states:

- **Not generated:** offer Generate PR description.
- **Generating:** show that a description is being drafted for the reviewed
  snapshot; keep the PR identity visible.
- **Ready:** show the editable proposal and a current-versus-suggested diff.
- **Failed:** show concise failure copy and **Retry generation**; do not show
  raw model output.
- **Stale:** explain that the PR body or reviewed `HEAD` changed and offer
  generation for the current snapshot.

The proposal is in-memory in V1. Restarting the app or clearing local review
data removes the proposal but does not remove or change the GitHub PR body.

### Review and save actions

The ready surface contains:

- an editable Markdown editor for the suggested body;
- a rendered preview or equivalent diff view;
- **Copy description**;
- **Update PR description**;
- evidence warnings for unverified tests, missing motivation, missing issue
  context, stale data, or omitted sections.

Copying never writes to GitHub. Updating opens an explicit confirmation that
names the PR and explains that the reviewed body will be replaced by the
edited proposal. The main process re-reads the current PR body and current
`HEAD` before applying. If either differs from the generation snapshot, the
update is rejected as stale and the user must regenerate or manually reconcile
the changes.

The user can edit or remove generated content before saving. The initial
proposal is conservative and preserves protected material, but the final write
is the user’s explicitly reviewed Markdown.

## Body composition

### Protected content

The proposal composer begins with the raw PR body obtained from the configured
GitHub host. It preserves:

- a leading human note when the first non-empty paragraph begins with a person
  emoji or similar human marker; preserve every byte through its closing `---`
  separator, or only that leading paragraph when no separator exists;
- images, attachments, and their surrounding Markdown;
- important links, issue references, warnings, and rollout notes;
- existing stack metadata blocks, including `<!-- stack:links:start -->` through
  `<!-- stack:links:end -->`;
- any existing non-empty human-authored sections unless the user edits them in
  the proposal editor.

The generator never invents a human note. It does not reflow, retitle, or
reword protected content. A malformed raw-body response, literal leading quote,
or escaped newline payload fails closed instead of producing a destructive
proposal.

### Standard sections

The composer uses this structure, deleting sections that do not apply:

1. Opening motivation and high-level change.
2. Optional reviewer context such as Concepts, Feature breakdown, Example,
   FAQ, Docs, or Related issues.
3. `### Code changes`, a high-level scope table whose net added/deleted text
   rows sum to the base-to-head diff totals. It classifies changed text into
   broad categories such as core/source, tests, documentation/examples,
   applications, templates, or config/tooling. It is not a file inventory.
4. `### API changes` when the diff adds, changes, or removes public API,
   explicitly marking breaking changes.
5. `### Related issues` when issue search finds relevant evidence not already
   linked naturally in the opening.
6. `### Change type` with exactly one checked value among `bugfix`,
   `improvement`, `feature`, `api`, and `other`.
7. `### Test plan` with only supported manual steps and test types checked.
8. `### Release notes` only for user-facing behavior, with imperative bullets.

The composer adapts to an existing repository PR template when a matching
heading is unambiguously present and empty or still contains a placeholder. It
does not replace non-empty content. When no safe insertion point exists, it
adds the generated sections after the preserved body in the proposal and
labels any unverified information explicitly. The user may edit the result
before saving.

Routine CI-equivalent commands are not padded into the body. A test plan names
targeted tests or meaningful manual checks. If a test was not observed, the
proposal says `Not verified` or omits the claim.

## Evidence and LLM contract

The LLM receives a bounded, main-process-built input containing:

- PR number, repository, title, base branch, head branch, reviewed `HEAD`, and
  current `HEAD` when available;
- the current raw body and identified protected ranges;
- the base-to-head diff or stored snapshot patch, bounded by the same limits
  used for review context;
- commit subjects and bodies relevant to motivation;
- observed checks and their states;
- related issue links found through the configured GitHub integration;
- stack relationship and net base/head scope when the PR is stacked;
- the selected model and reasoning level.

The workflow prompt requires the model to:

- return structured reviewer sections, not an arbitrary full-body rewrite;
- use only supplied evidence;
- distinguish observed facts from inference;
- omit unsupported sections;
- never claim tests passed without an observed result;
- never invent issue links or motivation;
- keep the description short and reviewer-oriented;
- preserve protected content by returning additions or safe section proposals.

The normalized result contains bounded section text, a single change type,
test-plan items with evidence status, release-note items, API-impact entries,
related-issue references, and warnings. Raw model output is never rendered or
written.

## Architecture

The feature follows Patchdesk’s existing domain, service, adapter, and
authenticated loopback API boundaries.

### Domain

Create `src/domain/pr-description.ts` for:

- `PrDescriptionSnapshot` containing profile/session identity, reviewed `HEAD`,
  current body hash, patch hash, and base/head scope;
- bounded proposal and section types;
- protected-body range metadata;
- evidence status and warning types;
- deterministic validation of exactly one change type and valid test/API/
  release sections.

The domain never performs GitHub I/O, model calls, or Markdown writes. It
normalizes the model’s structured result and composes a safe initial proposal
from the raw current body plus generated sections.

### Workflow and adapter

Create a finite `workflow:generate-pr-description` under
`src/workflows/generate-pr-description.ts`. It reads only the artifacts passed
by the main process and returns the bounded structured result.

Create `src/services/flue-cli-pr-description-invoker.ts` around the fixed Flue
command. It owns process arguments, timeout, stderr, event handling, and
terminal JSON parsing. It never forwards model prose or a process handle to the
renderer.

### Main-process service

Create `src/services/pr-description-service.ts`. It:

- loads current body, base/head diff, checks, commits, stack context, and issue
  evidence through main-process adapters;
- captures the generation snapshot and body/patch hashes;
- invokes the fixed workflow with the explicit model/reasoning choice;
- normalizes and composes the proposal;
- rejects late results when a newer generation exists;
- returns `stale` if body, reviewed `HEAD`, patch, or PR identity changed;
- records bounded diagnostic events for preparation, generation, parse, and
  apply failures;
- never writes GitHub data during generation.

The service owns an in-memory proposal record per profile/session. It does not
create a second durable draft store.

### Local API and GitHub write boundary

Add authenticated, renderer-origin-bound routes in `src/main/local-api.ts` and
the matching preload allowlist in `src/main/desktop-bridge.ts`:

- `POST /v1/reviews/pr-description/generate` with profile/session/model/
  reasoning;
- `POST /v1/reviews/pr-description/load` with profile/session;
- `POST /v1/reviews/pr-description/apply` with profile/session, edited body,
  expected body hash, expected reviewed `HEAD`, and explicit acknowledgement.

The apply route re-reads the PR body and `HEAD`, rejects mismatches, validates
the edited body, and calls the configured GitHub writer. It must not accept a
repository host, owner, PR number, workflow path, or filesystem path from the
renderer when those values already belong to the prepared session.

No PR-description route is published from `src/app.ts`. No renderer code gets
`gh`, credentials, or direct GitHub write access.

### Renderer

Extend `src/renderer/src/renderer-contracts.ts` and
`src/renderer/src/renderer-models.ts` with strict proposal/lifecycle parsing.
Add the dialog and editor to `src/renderer/src/flows/completed-review-flow.tsx`
and the completed workbench. Reuse the existing model catalog and per-profile
execution preference. Keep the editor and proposal state independent from
review batch comments, Files-mode selection, walkthrough section progress,
and diff view state.

## Stale data, failure handling, and safety

Generation is snapshot-bound. A new request supersedes an older request. A
body, patch, base/head, or PR identity change makes the proposal stale. The
renderer offers regeneration rather than applying a proposal to newer content.

Apply failures are user-actionable:

- unavailable GitHub writer → retry or copy only;
- body/HEAD changed → refresh and regenerate;
- invalid edited Markdown or missing acknowledgement → correct the editor;
- authorization failure → show a concise access message and retain the local
  proposal;
- unknown internal failure → show an incident ID and retain the local proposal.

Diagnostics record category, phase, retryability, identifiers, timestamp,
duration, incident ID, and redacted detail. They never contain credentials,
full diffs, absolute paths, raw PR text, or raw model output.

The apply path is an explicit GitHub write and must retain the existing
confirmation boundary. There is no background update, automatic retry of the
write, or merge side effect.

## Verification

### Domain and service tests

Cover:

- protected human-note byte preservation with and without a closing separator;
- image, attachment, link, warning, and stack-block preservation;
- malformed or escaped body rejection;
- standard section composition and exactly one change type;
- API changes included only when public API evidence exists;
- code-change table totals matching base-to-head diff totals;
- test-plan and release-note claims requiring evidence;
- related issue links never invented;
- stacked PR net scope using base-to-head rather than trunk;
- stale body/HEAD/patch rejection;
- late generation suppression and retry;
- redacted diagnostics;
- apply re-checking body hash and `HEAD` before GitHub write.

### Renderer tests

Cover:

- no generation request before the user clicks the action;
- model/reasoning selection and preference restoration;
- generating, ready, failed, and stale states;
- editable Markdown proposal and current-versus-suggested diff;
- Copy description without a GitHub request;
- Update PR description requiring explicit confirmation;
- access or stale errors retaining the proposal for retry/copy;
- no renderer-visible `gh`, credentials, paths, raw model output, or internal
  lifecycle vocabulary.

### Browser and packaged tests

Fixture the local API so browser tests can prove:

1. opening a completed PR exposes Generate PR description;
2. generation does not start automatically;
3. a structured proposal preserves the human note, links, image, and stack
   block;
4. the user edits and reviews the diff;
5. Copy description does not call the apply route;
6. Update PR description shows confirmation and applies only after approval;
7. a changed body or `HEAD` shows the stale state and blocks the write;
8. the narrative walkthrough, review batch, and Files mode remain unaffected.

Run the required desktop and package gates from `AGENTS.md`. Interactive
packaged-app verification must be performed by the dedicated tester subagent;
the primary agent does not drive the packaged UI.

## Acceptance criteria

- A PR manager can generate a concise suggested update from an existing PR.
- The initial proposal preserves human notes, images, attachments, links,
  warnings, rollout notes, and stack blocks byte-for-byte.
- The proposal follows reviewer-focused GitHub PR-body conventions and does not
  invent motivation, issue links, test results, API impact, release notes, or
  trade-offs.
- `### Code changes` totals match the actual PR base-to-head diff, and
  `### API changes` appears only when applicable.
- The user can edit and inspect a complete Markdown diff before any write.
- Copying never writes to GitHub.
- Updating requires explicit confirmation and is rejected if the PR body or
  reviewed `HEAD` changed since generation.
- Human content outside the edited proposal remains protected by default; no
  hidden Patchdesk markers are added to the saved body in V1.
- Generation and apply failures are concise, retryable where appropriate, and
  diagnosable without leaking secrets or implementation details.
- Existing narrative walkthrough, review execution, recovery, comment, and
  Files-mode behavior remain unchanged.

## Open questions for review

- Should generated sections be appended whenever a template section is
  non-empty, or should the user be able to explicitly choose a target section
  before generation?
- Should Copy description copy only the generated sections or the complete
  edited Markdown body?
- Should V1 include issue search when the configured GitHub token cannot search
  repository issues, or omit Related issues entirely in that case?
