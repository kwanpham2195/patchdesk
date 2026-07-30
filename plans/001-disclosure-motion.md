# 001 — Add restrained disclosure motion

- **Status**: TODO
- **Commit**: ee83cbc
- **Severity**: LOW
- **Category**: Missed opportunities; accessibility
- **Estimated scope**: 4 renderer files plus focused renderer/browser coverage

## Problem

The prepared-PR ExecPlan deliberately adds two occasional disclosure surfaces:
the right-side PR overview's four accordion rows and collapsed Walkthrough
Support. The current Base UI wrapper passes a panel through without any motion,
so the comparable existing checks panel snaps between states.

```tsx
// src/renderer/src/components/ui/collapsible.tsx:13-17 — current
function CollapsibleContent({ ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel data-slot="collapsible-content" {...props} />
  )
}
```

```tsx
// src/renderer/src/components/review-checks.tsx:29-39 — current consumer
<Collapsible open={open} onOpenChange={setOpen} className="border-b">
  <div className="flex items-center justify-between gap-3 py-2">
    <CollapsibleTrigger render={<Button variant="ghost" size="sm" aria-label={`${open ? "Collapse" : "Expand"} checks`} />}>
      Checks
      <ChevronDown data-icon="inline-end" className={open ? undefined : "-rotate-90"} aria-hidden="true" />
    </CollapsibleTrigger>
  </div>
  <CollapsibleContent>
```

The product is a dense desktop review dashboard. Do not add page, diff, file
tree, keyboard-navigation, or Settings-tab motion. This plan addresses only
occasional deliberate disclosure actions.

## Target

Opt-in disclosure panels reveal and hide their contents with a compositor-
friendly clip-path plus opacity transition. Do not animate `height`, `width`,
margin, padding, or `transition: all`. The panel's layout may resolve
immediately; the content reveal is the state cue.

```css
/* exact target values */
:root {
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
}

[data-disclosure-motion="panel"] {
  overflow: clip;
  transition-property: clip-path, opacity;
  transition-duration: 200ms;
  transition-timing-function: var(--ease-in-out);
}

[data-disclosure-motion="panel"][data-starting-style],
[data-disclosure-motion="panel"][data-ending-style] {
  clip-path: inset(0 0 100% 0);
  opacity: 0;
}

[data-disclosure-motion="chevron"] {
  transition: transform 150ms var(--ease-in-out);
}

@media (prefers-reduced-motion: reduce) {
  [data-disclosure-motion="panel"] {
    clip-path: inset(0) !important;
    transition-property: opacity !important;
    transition-duration: 100ms !important;
    transition-timing-function: var(--ease-out) !important;
  }

  [data-disclosure-motion="panel"][data-starting-style],
  [data-disclosure-motion="panel"][data-ending-style] {
    opacity: 0;
  }

  [data-disclosure-motion="chevron"] {
    transition: none !important;
    transform: none !important;
  }
}
```

Use `data-starting-style` and `data-ending-style`: Base UI's installed
Collapsible panel publishes those attributes and its measured dimensions as
`--collapsible-panel-height`. Do not consume that height variable: animating
layout properties is out of scope for this dashboard. The 200ms moving/state
curve and 150ms control cue are below the 300ms UI budget. Reduced-motion users
retain a 100ms opacity cue only; the explicit selectors intentionally override
the existing global `0.01ms !important` safety rule.

## Repo conventions to follow

- **Library decision:** use the installed `@base-ui/react@^1.6.0`
  `Collapsible` primitive. This is an accessible UI-primitives task, not a
  spring, gesture, layout-animation, or exit-animation task, so do **not** add
  `motion`/Framer Motion. Plain CSS transitions on Base UI lifecycle attributes
  are sufficient and avoid a new runtime dependency.
- Use the existing Base UI wrapper in
  `src/renderer/src/components/ui/collapsible.tsx`; do not add a motion library
  or a second accordion component.
- Keep the app's Tailwind/shadcn styling model. Place reusable selectors and
  motion tokens in `src/renderer/src/styles.css` beside the existing `:root`
  variables and reduced-motion media query.
- The installed Base UI `Sheet` is the transition exemplar:
  `src/renderer/src/components/ui/sheet.tsx:29-54` uses transition state
  attributes for an occasional spatial surface. The PR overview Sheet already
  has that motion. Do not add another entrance animation to it.
- The prepared-PR ExecPlan is authoritative for scope: only its PR overview
  rows and Walkthrough Support opt in. Existing `ReviewChecks` and
  `PullRequestDescription` remain unchanged unless the surrounding planned
  overview passes the opt-in prop.

## Steps

1. In `src/renderer/src/styles.css`, add `--ease-out` and
   `--ease-in-out` to `:root` with the exact cubic-bezier values above. Add the
   exact `[data-disclosure-motion]` selectors after the existing app-frame
   rules, then add the reduced-motion override inside the existing
   `@media (prefers-reduced-motion: reduce)` block. Do not alter the global
   reduced-motion rule for unrelated components.
2. In `src/renderer/src/components/ui/collapsible.tsx`, add an optional
   `motion?: "disclosure"` prop to `CollapsibleContent`. When it is supplied,
   set `data-disclosure-motion="panel"`; otherwise preserve the current
   markup and attributes exactly. This must be opt-in, not a new default for
   every existing collapsible.
3. During ExecPlan Milestone 2, give each of the four PR overview rows the
   `motion="disclosure"` prop. Give each row's chevron
   `data-disclosure-motion="chevron"`, and derive its rotation only from that
   row's open state. Description and Checks remain initially open; Existing
   threads and Your local review remain initially closed. The 430px right
   Sheet retains its current 200ms entrance and fixed footer.
4. During ExecPlan Milestone 4, convert Walkthrough Support at
   `src/renderer/src/components/narrative-walkthrough.tsx:314-332` to the same
   opt-in `Collapsible`. It starts closed, uses the same chevron data attribute,
   and preserves its existing support list plus Mark Support reviewed control.
   Do not animate chapter changes, the focused diff, `j`/`k` navigation, or
   Back to files.
5. Add focused UI assertions for the opt-in data attributes and default open
   states in the relevant PR-overview and NarrativeWalkthrough renderer tests.
   Add a Design/browser assertion that expanding and immediately collapsing a
   row leaves one coherent state and does not hide or delay the footer actions.

## Boundaries

- Do NOT add Framer Motion, React Spring, GSAP, WAAPI helpers, dependencies,
  keyframes, timers, or JavaScript-driven animation state.
- Do NOT animate height, width, margin, padding, top, left, or use
  `transition: all`.
- Do NOT change the established Sheet, Popover, Dialog, inline composer,
  Settings tabs, file tree, diff rendering, or keyboard navigation.
- Do NOT make motion a condition for focus, Escape dismissal, screen-reader
  state, GitHub confirmation, loading, or any other behavior.
- If the Base UI Collapsible no longer emits `data-starting-style` and
  `data-ending-style` at the stamped dependency version, STOP and report the
  drift rather than inventing an imperative animation path.

## Verification

- **Mechanical**:

  ```sh
  pnpm lint
  pnpm typecheck
  pnpm test -- --run tests/renderer/prepared-review-flow.ui.test.tsx tests/renderer/completed-review-flow.ui.test.tsx tests/renderer/narrative-walkthrough.ui.test.tsx
  pnpm test:design
  ```

  Expected: all commands pass; only the planned overview and Support carry the
  opt-in data attributes.

- **Feel check**: a dedicated tester subagent, not the primary implementation
  agent, opens the Design app and isolated packaged app. In the PR overview,
  open/close Checks and Your local review rapidly; then open/close Walkthrough
  Support. Confirm that the Sheet itself slides only once, content does not
  jump visibly through an intermediate state, rapid retoggles settle to the
  final state, footer actions stay fixed and immediately usable, and diff/file
  selection remains instant. Inspect at 10% playback in DevTools' Animations
  panel where available.

- **Reduced-motion check**: in the same dedicated tester run, emulate
  `prefers-reduced-motion: reduce`. Confirm the chevron no longer rotates and
  panel placement does not move, while a brief 100ms opacity cue remains. Also
  confirm `Escape`, focus return, and the two confirmation-gated actions still
  work while a disclosure transitions.

- **Done when**: only the two ExecPlan disclosure surfaces animate; their
  visual behavior is calm at normal speed, coherent at slow speed, and gentler
  rather than absent with reduced motion.
