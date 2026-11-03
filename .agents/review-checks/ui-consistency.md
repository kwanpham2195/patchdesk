---
name: ui-consistency
include:
  - "src/renderer/**/*.tsx"
  - "src/renderer/**/*.css"
exclude:
  - "src/renderer/src/components/ui/**"
---

Review only changed `.tsx` and `.css` lines. Shared primitives live in `src/renderer/src/components/ui/` (shadcn: button, dialog, select, tabs, tooltip, popover, dropdown-menu, input, switch, badge, card, and the rest of that folder). Read the primitive before judging.

Questions:

1. Does a changed line restyle a primitive from outside, by overriding its colors, radius, padding, height or typography through `className` where an existing variant or size covers it? Name the variant to use.
2. Does the diff hand-build a control a primitive already provides (a `<button>` styled like `Button`, a custom dropdown, tooltip, tab strip, toggle, dialog or spinner)? Name the primitive.
3. Does a new CSS rule in `styles.css` target a primitive's internals or add a one-off variant? Name the existing variant or say to drop it.
4. If a primitive is genuinely missing a needed variant, say so instead of overriding it; the fix is to extend the primitive in the `ui/` folder, which needs maintainer approval.

Do not review layout, spacing between your own elements, or copy. Do not suggest new abstractions.

Reply `All clear` if nothing applies. Otherwise one line per finding: `file:line — problem — minimal fix`.
