# Adopt latest shadcn Base UI primitives in Patchdesk

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` current as work proceeds.

## Purpose / Big Picture

Patchdesk will replace its legacy Radix/new-york shadcn layer with the latest shadcn Base UI Nova source. The app may look materially different: the target is a mostly stock current shadcn interface, not a pixel-preserving conversion. Keep only the product behavior that makes Patchdesk useful and safe: Pierre diff behavior and colors, Electron isolation, responsive access to review rails, local-review persistence, and explicit GitHub-write confirmation. A maintainer should be able to use the Inbox, command palette, menus, review sheets, dialogs, selects, tooltips, and sidebar with the same keyboard and pointer workflows after the migration.

The migration is intentionally a visual reset to current shadcn defaults. Local wrapper styling, bespoke animation, and density overrides are removed unless a behavior or a documented Patchdesk product constraint requires them. The command palette’s cmdk content remains cmdk, but its local `CommandDialog` becomes the stock shadcn-style command-in-dialog composition: a compact inset search field, calm outer boundary, clear groups, no close control competing with the input, and keyboard hints that never obscure options.

## Progress

- [x] 2026-07-19: Inventory completed. `components.json` reports `style: "new-york"`, `base: "radix"`; 19 renderer UI wrappers import `radix-ui`.
- [x] 2026-07-19: User authorized a current Base UI visual reset instead of preserving legacy `new-york` styling; latest Base UI Nova wrappers are now the intended source of truth.
- [x] 2026-07-19: Command-palette checkpoint committed (`384a237`); migration branch established from it.
- [ ] Record a fast baseline (lint, typecheck, renderer unit tests, build). Slow gates (Playwright, package, packaged smoke, CDP screenshots) are deferred to Milestone 5 per Matthew.
- [ ] Apply the latest `base-nova` preset, regenerate stock wrappers one family at a time, and restore only essential product behavior through consumers and narrow layout classes. Produce one `.migration/<component>.md` report for each primitive family.
- [ ] Sweep all renderer code and styles for Radix imports, Radix state selectors, Radix CSS variables, and `asChild` consumers; remove `radix-ui` only after the sweep is empty.
- [ ] Validate the packaged Electron app over CDP, update this plan’s outcome sections, and request review before any subsequent visual-polish pass.

## Surprises & Discoveries

- Observation: The project uses shadcn’s legacy `new-york` style rather than a Base preset, and it has no resolved preset code.
  Evidence: `pnpm dlx shadcn@latest info --json` reports `style: "new-york"` and `base: "radix"`; `pnpm dlx shadcn@latest preset resolve --json` returns `null`.

- Observation: The migration surface is larger than the primitive-import count because wrapper consumers use Radix’s `asChild`, Radix focus callbacks, state data attributes, and Radix CSS variables.
  Evidence: `src/renderer/src/components/app-shell.tsx`, review workbenches, draft/submission/merge dialogs, and `src/renderer/src/app.tsx` use those contracts; `dropdown-menu.tsx`, `select.tsx`, `popover.tsx`, and `tooltip.tsx` contain `--radix-*` positioning variables.

- Observation: `Command` is cmdk, not Radix, and Pierre is unrelated to either primitive library.
  Evidence: `src/renderer/src/components/ui/command.tsx` imports `cmdk`; `@pierre/diffs` renders the review diff. Neither is in scope for a Base UI conversion.

## Decision Log

- Decision: Perform an explicit whole-project migration in dependency order, but keep one focused commit and one migration report per primitive family.
  Rationale: The user requested a broad migration. Small, independently passing slices keep Electron review workflows usable and make a failed primitive conversion recoverable.
  Date/Author: 2026-07-19 / Codex and Matthew.

- Decision: Apply the latest shadcn `base-nova` preset and use its generated Base UI wrappers as the source of truth.
  Rationale: Matthew explicitly prefers current shadcn defaults and minimal local styling over visual compatibility with the legacy new-york implementation. The migration will still proceed one primitive family at a time so behavior regressions are attributable and recoverable.
  Date/Author: 2026-07-19 / Codex and Matthew.

- Decision: Keep cmdk, Pierre, Sonner, Vaul, input-otp, react-day-picker, and Recharts untouched; use their latest-compatible existing integrations rather than replacing them during this migration.
  Rationale: They are third-party libraries, not Radix wrappers. They must be listed in migration reports as intentionally left alone, not represented as Base UI work.
  Date/Author: 2026-07-19 / Codex and Matthew.

- Decision: Do not remove the current `radix-ui` dependency until every wrapper, consumer, selector, and CSS variable sweep is clean.
  Rationale: Base UI and Radix can coexist during conversion. Removing Radix early would turn a local migration failure into a full renderer outage.
  Date/Author: 2026-07-19 / Codex and Matthew.

- Decision: Defer the slow Milestone 0 gates (Playwright, packaging, packaged smoke, CDP screenshots) to Milestone 5; Milestone 0 records only lint, typecheck, renderer unit tests, and build.
  Rationale: Matthew prioritizes iteration speed during wrapper regeneration. The full Electron/browser proof still happens once before handoff, so the acceptance bar is unchanged.
  Date/Author: 2026-07-19 / Pi and Matthew.

## Outcomes & Retrospective

No implementation has started. Populate this section after the baseline, each milestone, and final packaged Electron verification with actual commands, results, behavior deltas, and any deferred primitive.

## Context and Orientation

Patchdesk is an Electron application. The renderer lives below `src/renderer/src`; `src/renderer/src/components/ui` contains local shadcn wrappers and `src/renderer/src/components` contains the maintainer product surfaces. Renderer access to privileged GitHub and filesystem behavior remains behind the preload/main-process boundary and is outside this migration.

The current primitive dependency is `radix-ui@^1.6.2`; the target is the latest `@base-ui/react` selected by the current shadcn Base Nova generator. Base UI has a different composition model for several primitives: a Radix overlay generally becomes a Base UI `Backdrop` plus `Popup`; positioned content becomes `Portal > Positioner > Popup`; and Radix `asChild` becomes Base UI’s `render` prop. A “wrapper” is the local component that keeps the public Patchdesk import name stable while changing the primitive implementation below it.

The 19 Radix wrappers are:

- `alert-dialog.tsx`, `dialog.tsx`, and `sheet.tsx` for confirmation and modal flows.
- `dropdown-menu.tsx`, `popover.tsx`, `select.tsx`, and `tooltip.tsx` for positioned content.
- `button.tsx`, `badge.tsx`, `button-group.tsx`, `item.tsx`, and `sidebar.tsx`, which use Radix `Slot` polymorphism.
- `checkbox.tsx`, `label.tsx`, `scroll-area.tsx`, `separator.tsx`, `tabs.tsx`, `toggle-group.tsx`, and `toggle.tsx`.

`toggle-variants.ts` contains Radix state selectors and migrates with toggle/toggle-group even though it does not import Radix. `src/renderer/src/app.tsx` owns a dialog that currently prevents Radix automatic focus and manually focuses trigger/ref targets; it must convert to Base UI’s `initialFocus` and `finalFocus` model. The direct consumer set includes `app-shell.tsx`, `review-workbench.tsx`, `diff-workbench.tsx`, `review-diff-view.tsx`, `review-draft-sheet.tsx`, `review-submission-dialog.tsx`, and `merge-confirmation-dialog.tsx`.

Existing behavior evidence is concentrated in `tests/renderer/*.ui.test.tsx` and `tests/browser/`. In particular, `tests/browser/accessibility.spec.ts` covers the command palette, `tests/browser/milestone-5.spec.ts` covers the workspace-profile dialog, `tests/browser/milestone-7.spec.ts` and `milestone-9.spec.ts` cover responsive sheets/sidebar, and `tests/browser/milestone-10.spec.ts` and `milestone-11.spec.ts` cover write-confirmation dialogs. The performance ceiling in `tests/browser/performance.spec.ts` remains `<200ms` for 1,000-file selection.

## Plan of Work

Start from a clean migration branch only. The current checkout contains uncommitted command-palette changes and untracked planning/package artifacts, so implementation must first either commit the intended work or move to a clean worktree; never use a destructive cleanup command. Create a new branch such as `refactor/base-ui-primitives` from the agreed Phase 1.1 checkpoint.

Before changing dependencies, record a baseline with the full renderer and Electron gates. Apply the current `base-nova` preset with the shadcn CLI and inspect the generated diff before allowing an overwrite. Add `@base-ui/react` with `pnpm`, keep `radix-ui`, and inspect the installed `node_modules/@base-ui/react/**/*.d.ts` whenever an API is not covered by the generated wrapper or migration references. Do not infer a prop mapping. Maintain `.migration/project.md` plus one report per migrated component using the exact `Changed`, `Left alone`, `Behavior changes`, and `Verify by hand` headings required by the migration workflow.

Treat the current Base Nova registry wrapper as authoritative for each primitive family. Do not replay legacy wrapper class strings, custom animation, arbitrary color, or typography overrides. Regenerate one component at a time with the shadcn CLI; retain only stable Patchdesk exports, app-level layout classes, and a small adapter when consumers require a product-specific prop. Never use a bulk `shadcn add --all --overwrite` command. After the Dialog wrapper is stable, simplify the existing `CommandDialog`, `CommandInput`, and `CommandList` to the stock shadcn command composition rather than creating a parallel palette.

Regenerate simple/shared wrappers first so overlay and shell work can rely on the new button and utility contracts. Then regenerate overlay families, positioned families, and finally the custom sidebar. At every component boundary, update consumer `asChild` to `render`, remove old visual overrides unless required by behavior, typecheck, run the smallest matching renderer/browser tests, inspect the component’s remaining Radix references, write its report, and commit the family before proceeding.

After the final wrapper, sweep all renderer source and `styles.css` for `radix-ui`, `@radix-ui`, `--radix-`, and Radix-only state selectors. Replace only selectors tied to migrated primitives: for example `data-[state=open]` becomes `data-open`, checkbox state becomes `data-checked`, toggle state becomes `data-pressed`, and open/closed keyframe animations become Base UI `data-starting-style`/`data-ending-style` transition rules. Do not mechanically rewrite unrelated product data attributes such as `data-[state=selected]` in the table or review domain state.

## Milestones

### Milestone 0 — Establish a fast migration baseline

The goal is to distinguish migration regressions from existing failures with fast checks only. On a clean branch, run `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run`, and `pnpm build`. Record exit codes in `.migration/project.md`.

Matthew deferred the slow gates to Milestone 5: `pnpm exec playwright test`, `pnpm package:mac`, `pnpm test:package-smoke`, and the packaged-app CDP screenshots. During Milestones 1-4, verify each family with typecheck, the build, and the smallest matching renderer unit tests only. The full slow suite plus the CDP walkthrough then runs once, at Milestone 5, before handoff. This trades early visual proof for iteration speed; the risk is that a visual regression in a migrated family is only caught at Milestone 5, so per-family commits must stay small and revertible.

### Milestone 1 — Apply Base Nova and regenerate shared primitives

The goal is to establish current shadcn Base Nova source as the component baseline, rather than hand-translating the legacy wrappers. Add the latest `@base-ui/react` alongside Radix, apply the current `base-nova` preset, inspect that configuration diff, then regenerate `button`, `badge`, `button-group`, `item`, `label`, `separator`, `checkbox`, `scroll-area`, `tabs`, `toggle`, and `toggle-group` one component at a time through the shadcn CLI. Keep public Patchdesk import paths stable, but prefer updating consumers to stock `sm`, `icon`, and documented variants over restoring legacy `xs`, arbitrary color, or density variants to the wrappers.

Retain only thin compatibility adapters when a product behavior cannot be expressed by the generated wrapper: for example, a stable exported name or an app-level fixed rail dimension. Convert `asChild` callers to Base `render` only after the generated owning wrapper is in place. Verify checkbox keyboard behavior, tab arrows and manual activation, toggle state, scrollbars, separators, and the Button variants actually retained by consumers.

This reduces risk because all later sheets, menus, dialogs, and sidebar composition rely on the generated button and shared primitive contracts.

### Milestone 2 — Regenerate dialogs, alerts, sheets, and focus restoration

The goal is to preserve all modal and sheet safety behavior while accepting the current Base Nova surfaces. Regenerate `dialog.tsx`, `alert-dialog.tsx`, and `sheet.tsx` from the current Base Nova registry one at a time. Preserve titles, descriptions, keyboard dismissal, focus trapping, mobile/desktop access, and explicit GitHub-write confirmation, but do not restore legacy overlay opacity, radius, animation, or padding classes merely for visual similarity. Use Base `render` for trigger/close consumers where the generated wrapper requires it.

Replace the Radix `onOpenAutoFocus`/`onCloseAutoFocus` logic in `src/renderer/src/app.tsx` with the generated Base UI focus contract, proven against the existing profile-switch workflow. Convert all direct trigger consumers in the review workbenches, draft sheet, submission dialog, merge confirmation, and command palette. Regenerate `command.tsx` from the current shadcn source, then keep only its actual product behavior: route filtering, protected-navigation guard, keyboard selection, a bounded scroll list, Escape/backdrop dismissal, and focus return. Do not retain a custom close icon inside the input or legacy command-palette surface styling. Keep the existing sheet direction behavior, but use generated Base transition hooks rather than copying Radix animation classes.

This milestone is a safety proof point because dialogs gate profile changes and every GitHub write confirmation. A failure must leave the draft and remote-write safeguards intact.

### Milestone 3 — Regenerate positioned menus, selects, popovers, and tooltips

The goal is to preserve placement and keyboard navigation while using the generated current Base Nova visual treatment for floating surfaces. Regenerate `dropdown-menu.tsx`, `select.tsx`, `popover.tsx`, and `tooltip.tsx` one at a time. Adapt consumers to Base Menu anatomy, Select value callbacks, and documented positioning APIs; do not port Radix viewport styling, CSS variables, or custom surface classes into the new wrappers.

Move Tooltip Provider `delayDuration` to `delay` only where its existing product behavior requires it, and update all `TooltipTrigger asChild` callers to `render`. Before transforming a Popover Anchor or unusual focus/dismiss prop, inspect the installed Base UI type declarations and record the conclusion in the affected report instead of guessing.

This milestone reduces risk because these components make compact controls understandable but are easy to visually misplace. It explicitly validates the diff view Options menu, compact sort/select controls, command-palette trigger tooltip, and all submenu paths.

### Milestone 4 — Regenerate the sidebar and adapt the app shell last

The goal is to regenerate `sidebar.tsx` from Base Nova without breaking the usable workspace structure. Adapt the app shell and sidebar consumers to generated APIs, keeping only application behavior such as collapse/restore controls, active-route feedback, fixed desktop rail widths, and narrow-screen sheet access. Do not reapply the legacy sidebar’s local component styling. Preserve the documented desktop workspace widths where they are a product layout contract: 48px title bar, 232px application rail, 48px collapsed application rail, 208px queue rail, and 336px inspector; do not alter Pierre code font, colors, or line height.

This milestone reduces risk because sidebar code is highly customized and is the product’s broadest consumer of polymorphic composition. It is deliberately last, after the Base button, tooltip, sheet, and primitive contracts are stable.

### Milestone 5 — Remove Radix and certify the real Electron product

The goal is a clean Base UI primitive layer with no silent residual Radix behavior. Complete a repository-wide sweep, remove `radix-ui` using `pnpm remove radix-ui`, and confirm `pnpm-lock.yaml` no longer resolves it. Confirm `components.json` identifies the Base Nova preset produced by the current shadcn CLI, then document in `AGENTS.md` that future UI work must start from the current registry source and keep local wrapper customizations minimal.

Run the entire verification suite — including the deferred Milestone 0 gates (`pnpm exec playwright test`, `pnpm package:mac`, `pnpm test:package-smoke`) — package the app, and validate it over CDP using the saved customer-management PR #118 fixture. Capture screenshots at 1920×1080 and 1280×800. Exercise all three rails, command palette, Inbox selection/search/sort, Drafts, History, Settings, review file/finding navigation, diff Options menu, split/unified and all-files/selected-file modes, draft sheet, profile switch, and explicit confirmation dialogs without executing GitHub writes. Inspect `errors`, `console`, page-level horizontal overflow, keyboard focus return, and the 1,000-file performance test.

This is the final proof because source-level typechecks cannot verify Electron focus, positioning, portal behavior, or the remote-write guard UI.

## Concrete Steps

All commands run from `/Users/kwanpham/Work/cfw/patchdesk`.

1. Before implementation, inspect `git status -sb`. Stop if it is not clean; commit intended work or create a separate clean worktree with user approval. Create the agreed migration branch and record its base commit in `.migration/project.md`.

2. Record the fast baseline:

       pnpm lint
       pnpm typecheck
       pnpm test -- --run
       pnpm build

   Expected result: every command exits successfully, except any pre-recorded existing failure is explicitly named before migration work starts. Playwright, packaging, packaged smoke, and CDP screenshots are deferred to Milestone 5 per Matthew.

3. Apply the latest Base Nova preset, add the current Base UI dependency, and inspect its public contracts:

       pnpm dlx shadcn@latest init --preset base-nova --force --no-reinstall
       pnpm add @base-ui/react@latest
       pnpm dlx shadcn@latest info --json
       find node_modules/@base-ui/react -name '*.d.ts' -print

   Expected result: the project records the current Base Nova configuration, Base UI is available while `radix-ui` remains installed, and no wrapper is regenerated yet. For every uncertain prop, inspect the specific declaration before changing source.

4. For each wrapper family, fetch the current shadcn docs, dry-run the single component, then regenerate it from the Base Nova registry. Inspect the diff and reintroduce only product behavior at the consumer or app-layout level; do not translate the old wrapper styling. Run the required leftover scan before that family’s commit:

       pnpm dlx shadcn@latest docs <component>
       pnpm dlx shadcn@latest add <component> --dry-run
       pnpm dlx shadcn@latest add <component> --overwrite
       rg -n 'radix-ui|@radix-ui|IconPlaceholder' src/renderer/src/components/ui/<component>.tsx
       pnpm typecheck

   Expected result: the regenerated wrapper follows the current Base Nova source, has no Radix import or leftover placeholder, consumers compile, and `.migration/<component>.md` names all changed files and manual checks.

5. After all families, sweep only owned renderer source and styles:

       rg -n 'from "radix-ui"|from "@radix-ui|--radix-|data-\[state=(open|closed|checked|unchecked|on)\]' src/renderer/src
       pnpm remove radix-ui
       pnpm install --frozen-lockfile
       rg -n 'radix-ui|@radix-ui' src package.json pnpm-lock.yaml

   Expected result: no Radix dependency or owned source import remains. Investigate any residual class selector before deleting it; some product `data-[state=...]` attributes are not primitive state.

6. Package and launch the final app on an unused port:

       pnpm package:mac
       pnpm test:package-smoke
       open -n release/mac-arm64/Patchdesk.app --args --remote-debugging-port=9234
       agent-browser skills get core
       agent-browser skills get electron
       agent-browser --session patchdesk-base-ui --cdp 9234 snapshot -i

   Re-snapshot after every interaction. Store screenshots under `/tmp/patchdesk-base-ui-<surface>.png` and record their paths in `.migration/project.md`.

## Validation and Acceptance

The migration is accepted when all of the following are true:

- The renderer compiles and all existing functional tests pass without loosening expectations or mocking primitive behavior.
- `radix-ui` is absent from `package.json`, `pnpm-lock.yaml`, and owned renderer source. `cmdk`, Pierre, Sonner, Vaul, input-otp, react-day-picker, and Recharts remain unchanged unless a separate requested migration says otherwise.
- All existing public wrapper imports (`@/components/ui/button`, `dialog`, `sheet`, `select`, `tooltip`, and so on) continue to work for their consumers. No application route needs a new primitive-specific import.
- Command palette opens by `⌘K`, filters and keyboard-selects routes, scrolls results above any keyboard-hint footer, closes with Escape and backdrop click, restores focus to the invoking control, and uses a compact inset search field with no close button overlaid or visually embedded in that field.
- Dropdown menus, the diff Options menu, selects, popovers, and tooltips position relative to their triggers, stay in the viewport, retain keyboard navigation/typeahead where applicable, and do not cause page-level horizontal overflow.
- Alert dialogs and profile-switch dialogs announce their title, focus their intended first control, return focus to their trigger, and preserve cancellation behavior. Draft and GitHub write confirmations still require an explicit user confirmation and are never invoked during QA.
- Mobile sheets open from the left/right controls, trap focus, close normally, and retain the content/actions already covered by the browser suite.
- At 1920×1080 and 1280×800, the documented fixed rail widths and title-bar height remain usable, but component surfaces, typography, spacing, animation, and radius may visibly change to the current Base Nova defaults. At 1279px and mobile, sheet behavior and touch targets remain reachable.
- Pierre unified/split, all-files/selected-file, wrapping, collapse, selected-finding navigation, per-file counters, and its dark diff colors remain unchanged.
- `document.documentElement.scrollWidth - document.documentElement.clientWidth === 0` for Inbox, Drafts, History, Settings, command palette, and the completed review. `agent-browser errors` and `console` report no new errors.
- The 1,000-file performance assertion remains below 200ms; do not relax the existing test.

## Idempotence and Recovery

The baseline commands, typecheck, targeted tests, full build, package, CDP screenshots, and Radix sweeps are safe to repeat. `pnpm add @base-ui/react@latest` is safe to rerun; do not manually edit the lockfile. Each wrapper family must retain its old Radix implementation until its regenerated Base Nova replacement and all consumers compile, then commit that family as one atomic checkpoint.

If a family fails typecheck or changes behavior unexpectedly, revert only that family’s uncommitted migration files, keep `radix-ui` installed, write the observed API gap in `.migration/<component>.md`, and return to the last passing component commit. Do not use `git reset --hard`, bulk restore, or a global shadcn overwrite. If an incomplete migration already has `<component>-base.tsx` files, treat those files and consumer imports as the source of progress and resume rather than restart.

If a Base UI API is unclear, inspect `node_modules/@base-ui/react/**/*.d.ts`, then document the gap and defer the component rather than inventing a mapping. A deferred component remains on Radix and prevents dependency removal; it must be reported honestly in `.migration/project.md`.

## Artifacts and Notes

Implementation creates these durable local artifacts:

- `.migration/project.md`: baseline commit, dependency transition, wrapper/consumer sweep summary, final Radix count, full validation evidence, and outstanding behavior deltas.
- `.migration/<component>.md`: one report per migrated primitive family with the required sections `Changed`, `Left alone`, `Behavior changes`, and `Verify by hand`.
- `PLAN-radix-to-base-migration.md`: this living execution plan. Update its Progress, discoveries, decisions, and outcome after each milestone.

At the final milestone, update `AGENTS.md` with the durable rule that Patchdesk UI wrappers are sourced from the current shadcn Base Nova registry and local wrapper customization requires a demonstrated product behavior or layout need. Do not add a rule until the migration is actually complete.

## Interfaces and Dependencies

- `@base-ui/react`: latest runtime dependency selected at implementation time. Use the generated current Base Nova wrappers first; inspect its per-family declarations for any adapter that the registry source does not cover.
- `radix-ui`: existing runtime dependency, retained only while migration reports identify remaining Radix wrappers; removed at Milestone 5.
- `components.json`: changes to the current Base Nova preset configuration. Do not mix legacy `new-york` wrapper styling back into generated Base UI files.
- `src/renderer/src/components/ui/*`: public local wrapper surface. Export names should remain stable so feature components do not import Base UI directly.
- Consumer API changes to account for: `asChild` to `render`, dialog focus callbacks to `initialFocus`/`finalFocus`, Tooltip Provider `delayDuration` to `delay`, Select positioning/value callback changes, removed Separator `decorative`, and Base UI state/animation data hooks.
- `src/renderer/src/components/ui/command.tsx`: remains cmdk-based and is regenerated from current shadcn command source after the Dialog wrapper is stable. Keep only routing and protected-navigation behavior beyond that source.
- `@pierre/diffs`: remains untouched. Preserve Pierre-specific CSS variables, code font, diff colors, line spacing, virtualized all-files behavior, and selected-line anchors.
