# UI guide

This document says which shared primitive to reach for when you build a screen.
The Insights tab of the Review workbench is the worked example throughout, because it uses every primitive once.
A primitive is a component under `src/renderer/src/components/ui/`; the shared styles and colour tokens live in `src/renderer/src/styles.css`.

## Surfaces

The window is three layers, each one shade lighter than the one behind it, in both themes.
The shell (`--shell`) is the window itself and the titlebar.
The working area sits on a rounded, hairline-bordered panel painted `--background`; this is the `main` element in `app-shell.tsx`.
Side columns and cards sit on `--card`: the Review details column on Pull requests and the metadata column on Conversation are both `bg-card`. The Visited pull requests column is the exception: it sits on `--shell`, so it reads as window chrome for navigation.
A box that has to stand out inside a card column, such as the status block at the top of Review details, steps up once more to `--muted`.
Do not skip a layer, and do not invent a fourth shade.
Every border defaults to `--border` through a rule in `@layer base`, so a `border-<colour>` utility on an element overrides it; `border-transparent` hides every side, so use a side colour such as `border-l-transparent` when a sibling rule like `divide-y` draws the others.

## Tabs

`Tabs` wraps Base UI's Tabs. `TabsList` has three looks, chosen with `variant`:

- `ghost`: a screen's top strip. The Conversation / Diff / Insights strip uses it; the active tab is a quiet pill on the card colour.
- `line`: a secondary rail under the strip. The Brief / Walkthrough / Analysis rail uses it; the active tab has an underline.
- `default`: the filled grey track shadcn ships. No screen uses it today; keep it for a compact switch inside a dialog or a settings form.

Base UI activates tabs manually: the arrow keys move focus along the list, and Enter or Space selects. Do not pass `activateOnFocus`.

## Status badges

A state is shown as one `Badge`, and the tone comes from a plain function, never from a bare grey word or an inline `variant` picked at the call site.
`InsightStatusIcon` in `src/renderer/src/components/insight-status-icon.tsx` draws the five Insight states: a green check for Current, an amber history clock for Outdated, a `Spinner` for Running, a red circle-x for Failed, and a muted dashed circle for Not run. `INSIGHT_STATUS_LABELS` in `src/renderer/src/insight-status.ts` holds the words; Current has none.
The Brief / Walkthrough / Analysis tabs show the icon alone, with the word in a tooltip and the tab's accessible name; Current shows nothing, and a Not run tab has no icon and a dimmer name. PR overview and the Pull requests inspector show the icon and the word.
Add a new state to that function, so the rail and the PR overview sheet change together.

## Empty, running, and failed states

An Insight that has not been generated, or is running, is one centred `Empty` with a border, not a paragraph in the panel.
Put the Insight's icon (or a `Spinner`) in `EmptyMedia variant="icon"`, one `EmptyTitle`, one sentence in `EmptyDescription` that says what the Insight gives the reviewer, and the generate button in `EmptyContent`.
A failed run stays an `Alert`, because it carries the error message and may sit above a retained result that is still readable.

## Cards that navigate

A card whose whole surface opens something is a `button` element, not a `Card` with an `onClick`.
Its first row is the icon, the name, and a `ChevronRight` pushed to the right.
The body is a fixed two-line slot (`line-clamp-2 min-h-10`), so cards in a row stay the same height whether or not there is a headline.
The footer holds the status `Badge` and, when there is a retained result, the retained time.
Give the button `ui-state-transition` and the hover lift (`hover:-translate-y-px hover:border-primary/40 hover:bg-accent hover:shadow-sm`), and a `focus-visible` ring so the keyboard sees the same card the pointer does.

## Icons

Each Insight type has one glyph, declared in `src/renderer/src/insight-icons.ts` as `INSIGHT_ICONS`.
The empty states and the PR overview sheet read from it.
Add a type there; never import a Lucide icon for an Insight inline.

## Motion

Put `ui-state-transition` on anything whose colour, border, shadow, or position changes on hover or focus.
It transitions those properties over 150ms, which is the one duration for state changes.
Do not add an animation library; Base UI's `data-starting-style` and `data-ending-style` cover open and close.
The reduced-motion rule at the end of `styles.css` collapses every transition and animation to an instant when the OS asks for less motion, so nothing you add needs its own reduced-motion branch.

## Copy

The reader knows GitHub and has used an AI tool, so never explain either.
A description under a title has to add a fact the title does not carry; when it cannot, the title stands on its own and there is no description.
Nothing narrates what the app is doing to itself, reassures the reader, or repeats a fix instruction beside the control that already performs it.

- Keep internal vocabulary out of user copy: Electron process, projection, bounded, represented, alias manifest.
- Status and error copy is one sentence: the cause, and at most one action.
- A situation several screens share gets one wording. Write-failure sentences come from `forbiddenWriteCopy`, `unconfirmedWriteCopy`, and `rateLimitedWriteCopy` in `src/renderer/src/review-copy.ts`, and sign-in and read-failure sentences from `src/renderer/src/github-read-failure-copy.ts`. Call those rather than retyping the sentence.

## Pointers

- Layers of code and who owns what: `docs/architecture.md`.
- Adding or composing a shadcn/ui component: the `shadcn` skill listed in `AGENTS.md`.
