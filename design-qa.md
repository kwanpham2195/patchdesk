# Call Flow design QA

## Comparison target

- Source visual truth: `/var/folders/1g/fxyn7wbx7hz0t874dsn560sw0000gn/T/codex-clipboard-2xN8K2.png`
- Final implementation: `/private/tmp/patchdesk-call-flow-continuous-reading-1283.png`
- Full-view comparison: `/private/tmp/patchdesk-call-flow-continuous-reading-comparison.png`
- Call Diff implementation: `/private/tmp/patchdesk-call-flow-call-diff-1283.png`
- Call Diff full-view comparison: `/private/tmp/patchdesk-call-flow-call-diff-comparison.png`
- New only implementation: `/private/tmp/patchdesk-call-flow-new-only-final-1283.png`
- New only full-view comparison: `/private/tmp/patchdesk-call-flow-new-only-comparison.png`
- Focused path-panel comparison: `/private/tmp/patchdesk-call-flow-go-compact-final-focus-comparison.png`
- Long Go search evidence: `/private/tmp/patchdesk-call-flow-go-toolbar-query-1283.png`
- Minimum-window evidence: `/private/tmp/patchdesk-call-flow-continuous-reading-960.png`
- Minimum-window Call Diff evidence: `/private/tmp/patchdesk-call-flow-call-diff-960.png`
- Source-navigation evidence: `/private/tmp/patchdesk-call-flow-go-source-navigation.png`
- State: Patchdesk dark theme, Go Review #717, Paths, New only, and Call Diff views, expanded entry tree, changed-file navigator visible.

## Viewport and density

The source image is 2566 × 1616 pixels and represents a 1283 × 808 CSS viewport at 2× density. The source was downsampled to 1283 × 808 for comparison.

The Electron implementation was captured through CDP at a 1283 × 808 CSS viewport and 1× output density. The Call Diff and New only comparison images are 2566 × 808 pixels because each joins the normalized 1283 × 808 source with one 1283 × 808 implementation capture. The minimum supported Patchdesk window was also checked at 960 × 640 CSS pixels.

## Full-view comparison

The final screen keeps the reference hierarchy: changed-file navigation on the left, revision and path counts at the top, view controls, language coverage, a status legend, context and search controls, and dense expandable path rows with source locations. The revised panel has a shorter summary header, a compact two-row command area, 14 px entry carets, and smaller path-row padding. Patchdesk keeps its existing application header, Review tabs, Inter and Ioskeley Mono fonts, semantic color tokens, and native navigator.

Call Diff extends that hierarchy with two equal panes. Before is bound to the base SHA and shows removed paths. After is bound to the head SHA and shows added paths. New only keeps the normal tree width and removes deleted calls while retaining the unchanged ancestors that explain each added path.

The reference contains a synthetic TypeScript data set. The live evidence uses nine Go entry paths and four impacted files. This is a data difference, not a layout mismatch. The implementation follows the reference's file transition bands so calls that cross source files stay easy to trace. Rows show compact line references such as `L187`; the file band and native hover title retain the full source path.

## Focused comparison

The focused comparison checks readable typography, row height, status color, control placement, tree indentation, source-path alignment, borders, and the Paths/Raw hierarchy. The long-search capture verifies that `RefreshRolePermissionCache` fits without the earlier clipping. No image or custom vector asset appears in either surface. Patchdesk uses the installed Lucide icons and shadcn/Base UI controls.

## Required fidelity surfaces

- Fonts and typography: Patchdesk uses its existing sans and mono families. Heading, metadata, source paths, and path-node weights remain distinct and readable at both tested viewports.
- Spacing and layout: The main groups, dividers, toolbar density, tree indentation, and navigator proportions match the reference intent. Call Diff keeps two readable columns at 960 × 640. Long Go names truncate inside their pane instead of expanding the window.
- Colors and tokens: All surfaces use Patchdesk semantic background, border, foreground, muted, destructive, success, accent, and focus tokens. The implementation adds no independent dark palette.
- Image quality: The target contains no product imagery, logo treatment, or decorative asset that the Call Flow panel must reproduce. Existing Patchdesk and file-type assets remain unchanged.
- Copy and content: Labels state that paths are inferred, identify the immutable revision, distinguish added, removed, and unchanged steps, and explain source navigation and Shift-click selection. Before and After show their base and head SHA prefixes. New only states that required ancestors remain. The language control reports Go as one of five packaged languages.
- Icons: The 14 px entry caret, branch, search, information, copy, and navigator icons come from the installed icon set and align with their controls. Expand all uses text instead of an ambiguous double-chevron icon.
- States and interactions: Paths, New only, Call Diff, Raw, long-symbol search, context visibility, expand or collapse, Go language coverage, and Go source navigation were exercised in the live Electron app. Call Diff showed 10 removed base steps and 58 added head steps. New only removed the base-only paths and retained the added Go entries. Source navigation opened `internal/handler/role-permission-hdl/http.go` at the canonical Diff. A clean reload and interaction pass produced no page errors.
- Accessibility: Controls use semantic buttons, labels, pressed or expanded state, keyboard focus styles, and readable status text. The layout remains usable at the 960 × 640 minimum window.

## Comparison history

### Pass 1

- P2: The first implementation removed the Review navigator from Call Flow. The reference kept a changed-file tree beside the paths.
- Fix: Reused Patchdesk's existing Review navigator and resize behavior on the Call Flow screen.
- Post-fix evidence: `/private/tmp/patchdesk-call-flow-css-comparison-v2.png`.

### Pass 2

- P2: At the 960 × 640 minimum window, the breakpoint grid placed the navigator above the panel and hid its tree.
- Fix: Kept the Call Flow navigator in a stable three-column grid and reserved its divider column below the resize breakpoint.
- Post-fix evidence: `/private/tmp/patchdesk-call-flow-minimum-v3.png`.

### Live interaction follow-up

- The CDP browser denied clipboard permission. The first Copy raw action caused an unhandled rejection.
- Fix: Contained the rejected promise and showed `Copy failed` in the control. The main-process log recorded no new unhandled rejection after the fix.

### Compact Go pass

- P2: Entry carets used Lucide's 24 px default, which was too large for the compact rows.
- Fix: Reduced entry carets to 14 px while keeping the full row as the trigger.
- P2: The 176 px search clipped a real Go symbol, and the double-chevron Expand all control was ambiguous.
- Fix: Made search responsive at 208 px for the minimum window and 256 px at the reference viewport, restored explicit Show all context and Expand all labels, and shortened the context status copy.
- Post-fix evidence: `/private/tmp/patchdesk-call-flow-go-toolbar-query-1283.png` and `/private/tmp/patchdesk-call-flow-go-compact-final-960-v2.png`.

### Continuous reading pass

- P2: Rounded count badges, always-visible search, and individually boxed path rows made the result read as a control panel instead of one call trace.
- Fix: Replaced count badges with quiet metadata, collapsed empty search to an icon trigger, removed row rounding, added light semantic row tint, added file transition bands, and replaced repeated full paths with line numbers. The full path remains available as hover text.
- Source: User comparison against the original Plannotator Call Flow reference on 2026-08-23.
- Post-fix evidence: `/private/tmp/patchdesk-call-flow-continuous-reading-comparison.png` and `/private/tmp/patchdesk-call-flow-continuous-reading-960.png`.

### Call comparison and focus pass

- P2: The combined Paths tree made it slow to answer what the call path became when one function lost calls and gained replacements.
- Fix: Added side-by-side Before and After panes bound to the base and head SHAs. Added New only to keep added calls with only their required unchanged ancestors.
- Post-fix evidence: `/private/tmp/patchdesk-call-flow-call-diff-comparison.png`, `/private/tmp/patchdesk-call-flow-new-only-comparison.png`, and `/private/tmp/patchdesk-call-flow-call-diff-960.png`.

## Findings

No actionable P0, P1, or P2 difference remains. The implementation keeps Patchdesk's application frame instead of copying Plannotator's frame. This is an intentional product constraint.

## Follow-up polish

No P3 change is required for handoff.

final result: passed
