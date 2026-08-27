# Target sighted keyboard-and-mouse users

> **Status: Accepted. Implemented.**

Patchdesk is a desktop tool for maintainers who read code diffs on screen. Its
user can see, can read code, and works with a keyboard and a mouse. The app
does not serve screen readers, switch access, forced-colors mode, or
reduced-motion preferences, and it does not claim to.

Today the codebase carries an assistive-technology lane that nobody uses:
`tests/browser/accessibility.spec.ts` (554 lines, 15 Playwright tests, an
`@axe-core/playwright` dependency, its own `pnpm test:a11y` script, and a line
in the pre-handoff gate), 12 `aria-live` regions and 25 `sr-only` spans whose
only job is to narrate state to a screen reader, and `prefers-reduced-motion`
and `forced-colors` rules in `styles.css`. Every one of these must be kept
green on every change, for a user the product does not have.

## The decision

Patchdesk supports one audience: a sighted person reading left-to-right code,
using a keyboard and a mouse. Nothing is built or tested for assistive
technology.

Removed:

- `tests/browser/accessibility.spec.ts`, the `@axe-core/playwright`
  dependency, the `test:a11y` script, and their mentions in `CONTRIBUTING.md`
  and `docs/test-cases.md`.
- Screen-reader narration: `aria-live` regions and `sr-only` text that exist
  only to announce a state change. A visible banner or badge carries the same
  information.
- The `prefers-reduced-motion` and `forced-colors` rules in `styles.css`, and
  the 400 percent zoom and forced-colors checks that tested them.

Kept, because they serve the sighted keyboard user or the test suite:

- Keyboard navigation and focus management: file, hunk, and thread jumps
  (`use-review-*-navigation`, `review-diff-keyboard-nav.ts`), Escape and
  Enter handling, the focus trap Base UI gives dialogs. These are how a
  reviewer moves through a diff fast. They are product behaviour, not
  accessibility.
- `aria-label` and `role` attributes. They are the stable handles the test
  suite queries by (`getByRole`, `getByLabelText`), which is what keeps tests
  independent of copy and class names. Base UI components require them.
- `role="alert"` and `role="status"` on visible banners. They cost nothing and
  tests query them.

## Why

A test lane that guards a feature nobody uses is pure maintenance: it fails
on unrelated changes, needs its own dependency and script, and its findings
are never acted on by a user. Removing it makes the remaining suite say what
the product is.

The line between "accessibility" and "product" was drawn by asking who the
feature serves. Keyboard navigation serves the maintainer reading the diff.
A live region serves a screen reader. Only the second goes.

## Rejected alternatives

**Keep the axe lane as a non-blocking check.** A check nobody fixes is noise
that trains people to ignore red. If it is not a requirement, it is not a
gate.

**Remove `aria-label` and roles too.** Rejected. They are not there for a
screen reader any more; they are there for the tests, and removing them would
push tests back onto copy strings and CSS classes, which is the brittleness
the test strategy is trying to remove.

**Keep `prefers-reduced-motion`.** It is two lines and harmless, but it is a
promise. Patchdesk makes no promise about motion preferences, so the rule
goes with the rest.

## Consequences

- No screen-reader user can use Patchdesk. This was already true in practice;
  it is now stated.
- `pnpm test:e2e` drops 15 specs and one dependency. The pre-handoff gate in
  `docs/test-cases.md` loses the accessibility line.
- Any future request for assistive-technology support is a new product
  decision and a new ADR, not a bug.
