---
created_at: "2026-08-07"
repos:
  - patchdesk
status: ready-for-review
---

# Research: Pierre Diffs features for Patchdesk

## Question

Which features from Pierre's Diffs playground are worth considering for Patchdesk's Review diff surface, and which should remain out of scope because they conflict with Patchdesk's review, ownership, or write-safety contracts?

## Sources and method

- Live playground: <https://diffs.com/playground>, explored with `agent-browser` at desktop and constrained widths.
- Upstream source cached with `$librarian` at `/Users/kwanpham/.cache/checkouts/github.com/pierrecomputer/pierre`.
  - Source inspected at checkout commit `3b70f81a`.
  - The checkout refresh reported remote tag conflicts and retained this clean checkout; live UI observations came from the public playground.
- Patchdesk current commit: `dac7e60`.
- Installed dependency: `@pierre/diffs` `1.2.12`.

## Observed Pierre capabilities

### Diff presentation controls

The playground exposes the following controls:

- Split or unified layout.
- Normal, window virtualizer, element virtualizer, and CodeView surfaces.
- Light/dark/system color mode and separate light/dark themes.
- Diff indicators: bars, classic, or none.
- Inline diff granularity: word-alt, word, character, or none.
- Hunk separators: line info, basic line info, simple, or metadata.
- Line hover highlighting: disabled, line and number, line only, or number only.
- Backgrounds, line numbers, wrapping, and annotations toggles.
- An explicit interaction mode: select lines, add comment, or no line interactions.
- A `Copy link` action. The playground serializes presentation settings and selected line ranges into URL parameters.
- At narrow widths, the full control surface moves into an Options drawer instead of overflowing the page.

Evidence: `apps/docs/app/(diffs)/playground/PlaygroundClient.tsx` lines 87–104, 235–610, 775–870; `searchParams.ts` lines 1–151.

### Inline annotations and comments

The playground uses Pierre's annotation framework to render content directly below a selected diff line:

- Hovering a line exposes a gutter `+` utility.
- A comment form is inserted at the selected line and receives focus automatically.
- Submitted comments become compact avatar cards with author, timestamp, body, and Delete.
- Seeded threads show replies plus Add reply, Resolve, and Delete actions.
- Open comment forms prevent multiple comment forms from stacking.
- Annotation line numbers are remapped when edit-mode changes move lines.

Evidence: `PlaygroundClient.tsx` lines 870–915 and 1072–1137; `PlaygroundComments.tsx` lines 13–232; `_examples/Annotations/Annotations.tsx`.

### Multi-file and editing surfaces

The CodeView and virtualizer demos add:

- Sticky file headers.
- Per-file Edit toggles.
- Mixed diff and plain-file items in one scroll container.
- Window-level or element-level virtualization.
- Persistent per-item edit sessions and annotation remapping.

The upstream examples also demonstrate accept/reject hunk actions, merge-conflict resolution, and token-hover tooltips.

Evidence: `PlaygroundCodeView.tsx`, `PlaygroundVirtualizerView.tsx`, `_examples/LiveEditing/LiveEditing.tsx`, `_examples/AcceptRejectExample/AcceptRejectExample.tsx`, `_examples/MergeConflict/MergeConflict.tsx`, and `_examples/TokenHover/TokenHover.tsx`.

## Patchdesk parity

Patchdesk already has much of the underlying Pierre capability:

- Split/unified layout and wrap/scroll preferences.
- All-files versus selected-file viewing.
- Progressive CodeView streaming and sticky file headers.
- Collapsible unchanged context and file-level viewed state.
- Current Finding annotations rendered inline.
- Local inline comment selection, gutter `+` utility, and a local composer.
- Custom file headers, file statistics, and safe navigation to current evidence.
- Profile-scoped persisted view preferences.

Evidence: `src/renderer/src/components/review-diff-view.tsx` lines 196–343, 540–866; `src/renderer/src/components/diff-workbench.tsx`; `src/renderer/src/review-view-preferences.ts`.

The following Pierre options are currently fixed in Patchdesk rather than user-configurable:

- `lineHoverHighlight` is not passed.
- `diffIndicators` is fixed to `bars`.
- `lineDiffType` is fixed to `word-alt`.
- `hunkSeparators` is fixed to `line-info`.
- There is no shareable URL for an exact Review/file/line location.

## Candidate port areas

These are research candidates, not implementation decisions.

### A. Line hover highlighting and gutter affordance

- Value: makes the existing local-comment `+` action easier to discover and gives the selected line a stronger visual target.
- Fit: high. Patchdesk already enables `enableGutterUtility`, `renderGutterUtility`, and line selection for local authoring.
- Scope: add a persisted `lineHoverHighlight` preference and pass it through the three Pierre surfaces; verify keyboard and mouse comment flows.
- Risk: low. No domain, API, GitHub, or model contract changes.

### B. A compact diff Options drawer

- Value: lets maintainers tune dense or noisy diffs without adding permanent toolbar clutter.
- Possible controls: indicators, inline diff granularity, hunk separator style, line hover, backgrounds, and line numbers.
- Fit: medium/high. `ReviewViewPreferences` already persists view choices.
- Risk: low/medium. The main decision is which controls are useful enough to expose and how to avoid preference overload.

### C. Shareable exact-snapshot line links

- Value: supports handing another maintainer a precise file and line location.
- Required identity: Review ID, immutable Review session or reviewed SHA, file path, diff side, and line range. Presentation preferences can remain optional.
- Fit: medium. Patchdesk already has stable Review identity, selected paths, selected ranges, and safe current-evidence mapping.
- Safety requirement: a link must not silently navigate to a newer revision or outdated Finding. It should resolve the represented snapshot first and show an explicit unavailable state when it cannot.
- Risk: medium/high because this crosses routing, snapshot loading, and stale-evidence behavior.

### D. Richer inline local-comment presentation

- Value: make local draft comments visually closer to Pierre's compact avatar/thread cards, with clearer reply/resolve state where those actions are Patchdesk-owned.
- Fit: medium. Patchdesk already renders `InlineCommentComposer` and Finding annotations, but local draft ownership and GitHub Published feedback must remain separate.
- Risk: medium. Do not copy GitHub reply/resolve semantics into local drafts without an explicit product contract.

## Candidates to defer

- Live editing: useful in Pierre's editor demo, but Patchdesk's Review diff is primarily an inspection and evidence surface. Editing code would need a separate ownership and persistence contract.
- Accept/reject hunks: potentially useful for an AI patch-application workflow, but not a Review annotation action and not a safe shortcut to GitHub writes.
- Merge-conflict resolver: a separate conflict-resolution product surface, not a PR evidence-viewer enhancement.
- Token-hover documentation: language-specific, high maintenance, and not directly tied to Patchdesk's Review decision workflow.
- A full Pierre control clone: the playground is a component laboratory; copying every option would add noise to Patchdesk's focused workbench.

## Constraints from Patchdesk's current contract

- Keep Files as the source-of-truth evidence surface.
- Keep local Review drafts distinct from GitHub Published feedback.
- Keep Findings navigation limited to current safely mapped evidence.
- Do not let presentation settings change represented GitHub state or freshness.
- Do not add a shortcut around explicit GitHub confirmation, exact-head checks, or merge readiness.
- Preserve the existing persistent Review draft and overlay/dock ownership decisions from the unified Review workbench specification.

Relevant Patchdesk sources:

- `.agents/tasks/unified-review-workbench/spec.md`
- `.agents/PLANS/003-pr-overview-status-sidebar.md`
- `src/renderer/src/components/review-diff-view.tsx`
- `src/renderer/src/components/diff-workbench.tsx`
- `src/renderer/src/review-view-preferences.ts`

## Open questions for product/design review

1. Should line hover be always on, or only when local comment authoring is active?
2. Which two or three diff controls materially help maintainers, rather than turning the workbench into a playground?
3. Should shared links target the exact immutable Review session, or only copy a local navigation state for the current window?
4. Should local inline comments gain threaded reply/resolve presentation now, or remain a single maintainer-authored draft item?
5. Is a compact Options drawer preferable to adding more controls beside the existing Files/Insights workbench actions?

## Research conclusion

The strongest low-risk opportunity is to improve the existing local comment path with Pierre-style line hover highlighting and a clearer gutter affordance. A small Options drawer is the next bounded opportunity. Shareable exact-snapshot links are valuable but require a separate routing and stale-evidence design before implementation. Editing, hunk application, conflict resolution, and token documentation should not be mixed into the current Review diff pass.
