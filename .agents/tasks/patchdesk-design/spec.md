---
created_at: 2026-07-27
repos:
  - patchdesk
status: ready-for-agent
triage_label: ready-for-agent
---

# Patchdesk Design interactive visual prototype

## Problem Statement

Patchdesk's UI is currently coupled to its desktop runtime and live service
boundaries. Designers need a safe, repeatable way to review the exact product
surface, explore realistic states, and propose visual changes before real data
and service behavior are implemented. A prototype that duplicates the UI would
quickly drift from Patchdesk and would not provide a trustworthy design
baseline.

## Solution

Create **Patchdesk Design**, a standalone browser application in the Patchdesk
repository. It reuses the existing renderer components, styles, shell, and
flows, but supplies typed in-memory mock data and actions at the renderer
boundary. The app opens with a Design index, exposes stable URL-addressable
design scenarios, and keeps all mock changes local to the current session.

Patchdesk Design is an interactive visual prototype: it preserves the current
product UI and interactions while making data, loading, failure, confirmation,
and completion states available for design review without GitHub credentials,
filesystem access, Electron, or live services.

## User Stories

1. As a designer, I want to open Patchdesk Design with one local command, so that I can begin reviewing the product surface without configuring Electron or GitHub.
2. As a designer, I want the Design index to list every available scenario, so that I can discover the complete visual review surface.
3. As a designer, I want each scenario to have a stable identifier and direct URL, so that I can share an exact design state with another person.
4. As a designer, I want the Design index to group scenarios by product area, so that I can understand the relationship between inbox, workbench, settings, and dialogs.
5. As a designer, I want the default inbox scenario to look like the current Patchdesk inbox, so that design review starts from a faithful product baseline.
6. As a designer, I want to see realistic pull requests with different review, check, draft, waiting, running, and merge-readiness states, so that the layout is tested against representative content.
7. As a designer, I want to inspect an empty inbox, so that the no-content experience can be designed intentionally.
8. As a designer, I want to inspect loading and request-failure states, so that feedback and recovery surfaces are part of the design review.
9. As a designer, I want to inspect cached or degraded inbox data, so that the product communicates freshness limitations clearly.
10. As a designer, I want to open a pull request from the inbox, so that I can review the transition from queue to workbench.
11. As a designer, I want to inspect a prepared review snapshot, so that I can design the workbench before analysis is run.
12. As a designer, I want to inspect a running review, so that progress, reconnect, and activity states can be reviewed.
13. As a designer, I want to inspect a completed review with findings, comments, checks, and merge warnings, so that the full review outcome is represented.
14. As a designer, I want to open submission and merge confirmation surfaces, so that explicit write-confirmation UX is included in design review.
15. As a designer, I want to inspect Settings with profile, appearance, watchlist, environment, and storage content, so that the configuration surface is designed with realistic density.
16. As a designer, I want to change appearance and diff-theme preferences locally, so that light and dark visual treatments can be reviewed without changing real Patchdesk settings.
17. As a designer, I want mock actions to produce predictable success, failure, loading, and confirmation outcomes, so that each interaction can be reviewed repeatedly.
18. As a designer, I want mock edits to reset on reload, so that every design review starts from a known baseline.
19. As a designer, I want the product surface to remain free of Design-only navigation controls, so that screenshots represent the real Patchdesk UI.
20. As a designer, I want the Design index to remain outside the product shell, so that scenario discovery does not alter the product layout.
21. As a designer, I want the browser-rendered product surface to reuse the same renderer components as Patchdesk, so that visual changes do not silently diverge between Design and production.
22. As a designer, I want the prototype to work at the desktop baseline and narrower responsive widths, so that layout decisions account for constrained space.
23. As a designer, I want both light and dark themes to be available at the desktop baseline, so that color and contrast decisions are reviewable.
24. As a designer, I want screenshots and interaction checks for stable scenarios, so that “the UI is the same” has repeatable evidence.
25. As a maintainer, I want mock payloads to satisfy the same renderer-facing contracts as production payloads, so that the prototype exposes contract drift early.
26. As a maintainer, I want the mock bridge to have no access to GitHub, credentials, the filesystem, or Electron privileges, so that running the Design app cannot mutate real state.
27. As a maintainer, I want Patchdesk Design to remain in the repository after production implementation begins, so that it can serve as a permanent visual reference and regression target.
28. As a maintainer, I want the current renderer working-tree baseline to be used deliberately, while unrelated dirty files remain untouched, so that the prototype reflects the latest intended UI without absorbing unrelated work.

## Implementation Decisions

- The product name is **Patchdesk Design** and its development command is `pnpm dev:design`.
- The Design app is a separate browser entrypoint in the same repository. It does not replace or modify the production Electron entrypoint.
- Existing renderer components, styles, design tokens, shell, flows, dialogs, and interaction surfaces remain the visual source of truth. The Design app adds composition and data seams rather than duplicating product markup.
- The highest test seam is a single renderer-facing desktop/API bridge. Patchdesk Design installs a typed in-memory implementation of that bridge before mounting the existing renderer application.
- The mock bridge owns deterministic response data, action results, settings changes, and scenario-specific state. It does not call the local API, GitHub, the filesystem, Electron preload, or production services.
- Mock data uses the existing renderer and domain-facing shapes. Data shape compatibility is required; mock side effects are intentionally local and deterministic.
- A scenario registry defines stable scenario IDs, titles, descriptions, and product-area grouping. The Design index links to scenarios through URL query parameters.
- The default Design URL is the Design index. A scenario URL renders only the selected Patchdesk product surface and does not add Design controls inside that surface.
- The first scenario set covers populated, empty, loading, error, and cached inbox states; prepared, running, and completed review workbench states; Settings; submission; and merge confirmation.
- Scenario state is session-only. Reloading a scenario resets its mock store to the curated baseline.
- The visual parity target is the app-rendered surface at 1440×900 in light and dark themes, with responsive checks at narrower desktop widths. Native macOS window chrome is outside the parity target.
- The current renderer working tree is the visual baseline, including the confirmed Settings scrolling correction. Unrelated dirty task, research, and test files are not part of the Design extraction.
- Patchdesk Design is retained after production implementation and becomes a visual reference and regression target rather than disposable scaffolding.

## Testing Decisions

- Tests verify external behavior: scenario discovery, visible product surfaces, navigation, mock state changes, reset behavior, theme rendering, and safe isolation. They do not assert internal component structure or mock implementation details.
- The scenario registry is tested for unique stable IDs and complete index coverage.
- The mock bridge is tested at the renderer boundary for valid production-shaped responses, deterministic scenario selection, local settings changes, and absence of live-service requirements.
- Renderer tests cover representative Design scenarios and key interactions using the same component-level testing patterns already used for the inbox, review workbench, dialogs, and settings.
- Browser tests open the Design index and direct scenario URLs, assert accessible product landmarks and visible state copy, and verify that representative interactions remain local.
- Visual checks capture the index and product surfaces at 1440×900 in light and dark themes. Responsive checks cover the existing narrower-width behavior without introducing a mobile-only design target.
- A dedicated tester owns interactive browser and packaged-app verification and returns screenshots plus concrete evidence. The primary agent performs static checks, typecheck, build, and test-suite commands.
- The repository verification sequence remains the source of truth for renderer changes: lint, typecheck, unit/integration tests, production build, browser tests, and any applicable package checks.

## Out of Scope

- Redesigning the current Patchdesk product surface before the visual-parity baseline is established.
- Replacing the existing renderer with a second markup implementation or a separate design system.
- Live GitHub requests, GitHub writes, credentials, API tokens, filesystem access, local review storage, Electron preload, or native window behavior.
- Persisting mock edits across reloads or across users.
- A production mobile application or a separate mobile information architecture.
- Changing production domain or service behavior solely to support the Design app.
- Automatically promoting a Design scenario change into production without an explicit implementation decision.
- Publishing the Design app as a user-facing production distribution in this first slice.

## Further Notes

- The glossary and architecture decision for this feature are recorded in the repository context and ADR documents.
- The Design app should keep scenario names product-facing and stable even if the underlying mock implementation changes.
- If a future design experiment requires a visual departure from Patchdesk, it should be added as an explicitly named scenario or decision rather than silently changing the parity baseline.
