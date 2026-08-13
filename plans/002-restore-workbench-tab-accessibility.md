# Plan 002: Restore valid Review workbench navigation semantics

> **Executor instructions**: Follow this plan step by step. Run each
> verification and confirm its expected result before continuing. Use the
> smallest accessible correction; do not redesign the workbench. If a STOP
> condition occurs, stop and report. When done, update this plan's row in
> `plans/README.md` unless a reviewer maintains the index.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 7b4f6e6..HEAD -- \
>   src/renderer/src/components/review-workbench.tsx \
>   tests/browser/accessibility.spec.ts
> git diff --stat -- \
>   src/renderer/src/components/review-workbench.tsx \
>   tests/browser/accessibility.spec.ts
> git diff --cached --stat -- \
>   src/renderer/src/components/review-workbench.tsx \
>   tests/browser/accessibility.spec.ts
> ```
>
> If the navigation no longer consists of the three custom `TabButton`
> controls described below, STOP and reassess this plan before editing.

## Status

- **Priority**: P1 — quick, isolated critical accessibility correction
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug / accessibility
- **Planned at**: commit `7b4f6e6`, 2026-08-13

## Why this matters

Conversation, Diff, and Insights are rendered as ARIA tabs, but their parent is
a plain `div` and their content is not exposed as tab panels. Axe reports the
critical `aria-required-parent` rule. Screen readers receive an invalid widget
contract, and the custom controls do not implement tab keyboard behavior.

The lowest-risk fix is to describe these controls as the ordinary view-switch
buttons they already behave as. Do not expand this small correction into a Tabs
migration unless current behavior proves that a true tab widget is required.

## Current state

`src/renderer/src/components/review-workbench.tsx:776-798` renders the control
row as a plain `div`:

```tsx
<div data-review-workbench-tabs>
  <TabButton active={activeTab === "conversation"}>Conversation</TabButton>
  <TabButton active={activeTab === "diff"}>Diff</TabButton>
  <TabButton active={activeTab === "insights"}>Insights</TabButton>
</div>
```

`TabButton` near lines 1297-1320 adds only:

```tsx
<button type="button" role="tab" aria-selected={active} ...>
```

There is no `tablist`, linked `tabpanel`, roving focus, or arrow-key behavior.
The component otherwise behaves correctly as three buttons that conditionally
show one view. Keep its visual active state.

The repository does contain a complete Base UI wrapper in
`src/renderer/src/components/ui/tabs.tsx`, used by `review-navigator.tsx` and
`settings-modal.tsx`. That is the right choice for a future true tab widget,
but it is unnecessary for this narrow semantic repair.

`tests/browser/accessibility.spec.ts` already runs Axe on
`#workbench-fixture`; its no-serious-violations case is the product regression
seam.

## Commands you will need

- Accessibility gate:
  `pnpm test:a11y -- --grep "workbench-fixture"`
- Focused browser command after an existing build:
  `pnpm exec playwright test tests/browser/accessibility.spec.ts --grep "workbench-fixture"`
- Typecheck: `pnpm typecheck`
- Lint: `pnpm lint`
- Build: `pnpm build`
- Whitespace: `git diff --check`

Expected: all commands exit 0 and Axe reports no serious or critical product
violations.

## Scope

**In scope**

- `src/renderer/src/components/review-workbench.tsx`
- `tests/browser/accessibility.spec.ts` only if a named regression is needed
- `plans/README.md` status only

**Out of scope**

- Visual redesign, motion, spacing, or responsive layout
- Workbench state shape or navigation routing
- Migrating the control to Base UI Tabs
- Accessibility defects outside this three-control group
- Generated Markdown, Pierre, merge, or Insight changes

## Git workflow

- Stay on the current branch unless asked otherwise.
- Stage explicit files only. Do not push or commit unless asked.
- If asked to commit, use `fix: restore workbench navigation semantics`.

## Steps

### Step 1: Preserve the failing accessibility proof

Run the existing targeted Axe case before editing:

```bash
pnpm build
pnpm exec playwright test tests/browser/accessibility.spec.ts \
  --grep "workbench-fixture"
```

Expected current result: failure includes `aria-required-parent` for the
Conversation, Diff, and Insights controls. If it already passes, inspect the
built output and STOP if live source and built source disagree.

If the existing output does not clearly name this regression, split or add one
focused test named `Review workbench view switcher has valid semantics` using
the same `seriousProductViolations()` helper. Do not weaken exclusions.

### Step 2: Make the controls truthful ordinary buttons

In `TabButton`:

1. Remove `role="tab"`.
2. Remove `aria-selected`.
3. Add `aria-pressed={active}` so assistive technology still receives the
   currently selected view.
4. Keep `type="button"`, click behavior, visible labels, and active visual
   classes unchanged.
5. Keep the `data-review-workbench-tabs` selector unless its name is asserted as
   ARIA semantics. It is a test/style hook, not a role.

Do not add `role="tablist"` alone. A partial tab widget would keep the
accessibility contract incomplete.

**Verify**:

```bash
pnpm build
pnpm exec playwright test tests/browser/accessibility.spec.ts \
  --grep "workbench-fixture"
```

Expected: the targeted case passes with no `aria-required-parent` violation.

### Step 3: Check behavior and quality

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run tests/renderer/review-workbench-flow.ui.test.tsx
pnpm build
pnpm exec playwright test tests/browser/accessibility.spec.ts
git diff --check
```

Expected: all commands exit 0; the full accessibility file has no serious or
critical product violations; the view-switch behavior tests still pass.

## Test plan

- Existing Axe workbench fixture proves the invalid ARIA hierarchy is gone.
- Existing renderer tests prove click selection still opens Conversation, Diff,
  and Insights.
- If adding a focused assertion, verify each control is a button, the active one
  has `aria-pressed="true"`, and inactive controls have `false`.
- Do not add arrow-key tests because ordinary buttons use normal Tab and Enter
  or Space behavior, not tab-widget roving focus.

## Done criteria

- [x] No custom workbench view button has `role="tab"` or `aria-selected`.
- [x] The active control exposes `aria-pressed` without changing visuals.
- [x] The `#workbench-fixture` Axe test passes.
- [x] All accessibility cases pass without a new exclusion.
- [x] Existing view-switch behavior tests pass.
- [x] `pnpm lint`, `pnpm typecheck`, and `pnpm build` pass.
- [x] `git diff --check` has no output.
- [x] `plans/README.md` marks Plan 002 DONE.

## STOP conditions

Stop and report if:

- Product requirements or current tests require arrow-key tab navigation rather
  than ordinary view-switch buttons.
- Removing the tab role causes a serious regression in an established assistive
  contract.
- The fix requires changing shared `ui/tabs.tsx` or unrelated components.
- The existing Axe case remains red because of a different serious violation;
  report it separately and do not mask it.
- A verification fails twice after one focused correction.

## Maintenance notes

Use ARIA roles only when the complete interaction pattern exists. If this view
switcher later becomes a true tab widget, migrate the whole group to the
existing Base UI `Tabs`, `TabsList`, `TabsTrigger`, and `TabsContent` wrappers
in one change, including keyboard and panel tests.
