# 05 — Design parity and scenario verification

**What to build:** The Design app has repeatable automated evidence that its indexed product surfaces match the shared Patchdesk renderer across representative interactions, themes, and desktop widths.

**Blocked by:** 02 — Inbox scenario coverage and local interactions; 03 — Review workbench scenarios; 04 — Settings and configuration scenarios

**Status:** ready-for-agent

- [ ] The scenario registry has unique stable IDs and complete Design index coverage.
- [ ] Browser tests open the Design index and representative direct scenario URLs.
- [ ] Browser tests assert accessible product landmarks, visible state copy, navigation, and local interaction outcomes.
- [ ] Visual evidence covers 1440×900 light and dark themes for the Design index and representative product surfaces.
- [ ] Responsive checks cover the existing narrower desktop behavior.
- [ ] Static verification runs lint, typecheck, focused tests, build, and browser tests for the Design surface.
- [ ] A dedicated tester returns screenshots and concrete live-browser evidence without modifying the repository.
