# Compact Pierre Review Surface design QA

- Reference: `/var/folders/1g/fxyn7wbx7hz0t874dsn560sw0000gn/T/codex-clipboard-9702913a-2f8d-4799-8325-5ccf811372f3.png`
- Implementation: `test-results/compact-pierre-1920x1080.png`
- Secondary viewport: `test-results/compact-pierre-1280x800.png`
- Responsive overflow regression: `test-results/responsive-cutoff-fixed-1280x800.png`
- Combined comparison: `test-results/design-qa-comparison.png`
- Acceptance fixture: saved review for `centraldigital/cfw-bo-customer-management-service#118`, `FINDING-001`, new lines 553-596

## Required surfaces

- The desktop workbench uses compact 13px review and code typography with 28-30px controls.
- Pierre provides unified and split views, all-files and selected-file modes, wrap and horizontal-scroll modes, sticky file headers, file collapse, unchanged-hunk expansion, and progressive virtualized loading.
- Application, review-navigation, and details rails collapse independently and preserve narrow restore controls.
- Finding selection expands the target file, scrolls to its mapped evidence, and preserves the 553-596 selection across view changes.
- File-tree selection expands a collapsed target, loads the all-files stream through that file in patch order, and scrolls Pierre to its file header.
- At 1920x1080 and 1280x800 the page width equals the viewport width, toolbar text remains visible, and the details rail remains beside the diff.
- Accessible mode exposes equivalent selected-line anchors and keeps the mapped range keyboard-focusable.

## Visual comparison

The implementation intentionally keeps Patchdesk's product header, finding navigator, and review inspector, while matching the reference's compact dark review density, narrow file rail, low-height controls, diff-first hierarchy, and subdued borders. The selected finding uses Pierre's range highlight, so the evidence block is more prominent than the reference's ordinary changed-line highlights.

The first packaged pass revealed mount-time eager loading and a stacked details rail at 1280px. The final pass gates virtual loading on user scroll intent, removes the hidden full-patch accessibility duplicate, and keeps the 20rem details inspector in the desktop grid from 1200px upward.

A later constrained-window pass exposed hidden horizontal overflow inside Radix ScrollArea: the 319px inspector viewport expanded to 460px around long review content. The corrected surface forces the internal content wrapper to the rail width, permits long identifiers to wrap, and confines horizontal scrolling to Pierre's code viewport. The packaged 1280px acceptance measurement is now zero overflow for the page, center column, and inspector.

The all-files surface now makes Pierre's `CodeView` the sole vertical scroll owner. Reaching the end of the rendered stream appends the next virtual batch and carries the same wheel gesture into its first file, while the workbench and diff toolbars remain pinned above the viewport.

## Verification

- Packaged Electron screenshots captured through `agent-browser` over CDP.
- Unified and split modes retained `FINDING-001` evidence.
- Accessible selected-line anchors covered new lines 553 through 596.
- All-files progressive loading, file collapse/reopen, and all three rail controls were exercised.
- The browser regression test scrolls the actual Pierre viewport, asserts that the next file enters the viewport, and verifies nonzero viewer scroll position.
- The saved customer-review check selected `configs/uat.json` from the file tree and displayed its code header after the viewer advanced from 38 to 33 remaining files.
- No page-level horizontal overflow or Electron console/page errors were observed.
- No GitHub write confirmation was opened.

final result: passed
