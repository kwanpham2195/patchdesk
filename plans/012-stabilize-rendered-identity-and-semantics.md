# Plan 012: Stabilize Conversation identity and Mermaid interaction semantics

> **Executor instructions**: Execute only after Plan 010 supplies regression coverage. Make the smallest semantic changes and preserve visible design. Run focused accessibility checks before the full suite. Update only this plan's status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a3813b8..HEAD -- src/domain/github-context.ts src/renderer/src/components/conversation.tsx src/renderer/src/components/pull-request-description.tsx tests/renderer/conversation.ui.test.tsx tests/renderer/pull-request-description.ui.test.tsx tests/browser/accessibility.spec.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: Plans 009 and 010
- **Category**: bug
- **Planned at**: commit `a3813b8`, 2026-08-14

## Why this matters

React Doctor reported many index-key and nested-interaction warnings, but most are not equally actionable. The confirmed product seams are narrow: Conversation entries already carry immutable GitHub IDs but render with positional keys, and Mermaid source disclosure is nested inside the button that opens the diagram lightbox. Fixing those sites improves reconciliation and keyboard semantics without rewriting Markdown token rendering or changing the workbench design.

## Current state

- `src/domain/github-context.ts:16-31,164-190` gives issue comments an `id`, reviews an `id`, and general threads an `id`.
- `src/renderer/src/components/conversation.tsx:31-43` renders entries with `key={`${entry._tag}-${index}`}` even though each non-description entry has a stable domain ID.
- `conversation.tsx:142-151` falls back to the comment index even though `GitHubComment.id` is required.
- `src/renderer/src/components/pull-request-description.tsx:680-730` nests an interactive `<details>/<summary>` inside the diagram-opening `<button>`. Activating “Mermaid source” can therefore activate the outer lightbox button and violates nested-interactive semantics.
- Markdown block/list token keys in `pull-request-description.tsx:160-235` are positional over freshly lexed, mostly stateless Markdown output. Do not replace those from a blanket rule count without a demonstrated user-state bug.
- Plan 010 adds independent keyboard-operation tests. Conversation rows are currently stateless, so this plan must not claim a runtime key-regression test that cannot fail against positional keys.

## Commands you will need

- `pnpm test -- --run tests/renderer/conversation.ui.test.tsx tests/renderer/pull-request-description.ui.test.tsx`
- `pnpm build && pnpm exec playwright test tests/browser/accessibility.spec.ts`
- Calibrated React Doctor JSON scan.
- Full repository gates.

## Scope

**In scope**:

- `src/renderer/src/components/conversation.tsx`
- `src/renderer/src/components/pull-request-description.tsx`
- `tests/renderer/conversation.ui.test.tsx`
- `tests/renderer/pull-request-description.ui.test.tsx`
- `tests/browser/accessibility.spec.ts`
- `plans/README.md` status row only

**Out of scope**:

- Changing GitHub/domain identity types.
- Re-keying every Markdown token, static icon list, fixture list, or positional form row.
- Replacing the existing lightbox implementation with a new dependency.
- Converting every `role="dialog"` to native `<dialog>` without a reproduced focus or semantics defect.
- Visual redesign.

## Git workflow

- Branch: `fix/rendered-identity-semantics`
- Commit: `fix: stabilize conversation and diagram controls`
- Stage explicit paths only. Do not push unless instructed.

## Steps

### Step 1: Use immutable Conversation identities

Add a local exhaustive key function or switch in `conversation.tsx`:

- `IssueComment` -> `comment.id`
- `ReviewSummary` -> `review.id`
- `GeneralThread` -> `thread.id`
- `PrDescription` is not rendered as a timeline entry; keep that behavior explicit.

Include the entry tag in the key only if IDs can overlap across GitHub object types. Replace `comment.id ?? index` with required `comment.id` for thread replies. Do not derive identity from body text, timestamps, or array position.

**Verify**: Typecheck and existing Conversation rendering tests pass, and no `no-array-index-as-key` diagnostic remains in `conversation.tsx`. Treat this as a type-backed static correction, not a runtime regression claim.

### Step 2: Separate Mermaid disclosure from the lightbox button

Restructure only the rendered-success branch of `ClickableMermaid` so:

- the button contains the visual diagram target only;
- `<details>/<summary>` is a sibling outside the button;
- both controls remain grouped in the same bordered diagram surface;
- diagram accessibility name and source text remain available;
- opening source never opens the lightbox;
- opening the diagram remains keyboard accessible.

Keep `dangerouslySetInnerHTML` constrained to Mermaid's existing strict configuration and `aria-hidden` visual SVG container. Do not weaken Mermaid security settings.

**Verify**: focused renderer tests prove source and lightbox actions are independent.

### Step 3: Verify accessibility in the browser

Build and run the accessibility suite. Exercise keyboard activation of source disclosure and lightbox, Escape closing, and focus restoration if the existing lightbox contract includes it. Run Axe after the interactive states are open.

**Verify**: `pnpm build && pnpm exec playwright test tests/browser/accessibility.spec.ts` passes with no serious/critical Patchdesk violations.

### Step 4: Rescan and disposition remaining key warnings

Run calibrated React Doctor. Confirm the targeted Conversation and nested-interactive findings are gone. Record remaining `no-array-index-as-key` occurrences as one of:

- confirmed stateful/reorderable defect -> create a separate follow-up plan;
- positional, immutable, or stateless rendering -> evidence-backed rejection;
- unknown -> needs evidence, not an automatic edit.

Do not chase a zero count in this plan.

### Step 5: Run full gates

Run format, lint, typecheck, full Vitest, build, full Playwright, and `git diff --check`.

## Test plan

Conversation keeps its existing rendering smoke test; do not add a key or DOM-identity assertion for stateless rows. The immutable ID requirement is proven by the domain types, exhaustive key mapping, TypeScript, and the targeted React Doctor rescan. For Mermaid, assert source activation does not create the image-viewer dialog and diagram activation does.

## Done criteria

- [ ] Conversation entries and replies use immutable GitHub IDs.
- [ ] Mermaid source disclosure is not nested inside the lightbox button.
- [ ] Focused renderer and browser accessibility tests pass.
- [ ] Targeted React Doctor findings are absent.
- [ ] Remaining index-key warnings have a recorded evidence disposition, not bulk edits.
- [ ] Full repository gates pass.

## STOP conditions

- A Conversation entry lacks an immutable identity in live domain data.
- Stable identity would require changing the renderer DTO or GitHub adapter.
- Separating Mermaid controls changes sanitization or requires raw source injection.
- The visual design cannot be preserved without broader component work.

## Maintenance notes

Stable keys are domain identity, not a performance decoration. New Conversation entry variants must carry or derive immutable GitHub identity before rendering. Keep disclosures and buttons as separate interactive controls even when they share one visual card.
