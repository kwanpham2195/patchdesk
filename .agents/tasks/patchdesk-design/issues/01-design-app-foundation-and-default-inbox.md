# 01 — Design app foundation and default inbox

**What to build:** A designer can run Patchdesk Design in a browser, open the Design index, select a stable scenario URL, and see a faithful populated Patchdesk inbox backed entirely by deterministic mock data.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `Patchdesk Design` has a dedicated browser development command and app title.
- [ ] The default page is a Design index with grouped links to stable scenario IDs.
- [ ] A selected scenario renders the existing Patchdesk shell and populated inbox without Electron, GitHub, credentials, filesystem access, or live services.
- [ ] The mock boundary returns renderer-compatible profile, repository, inbox, settings, and review-opening data.
- [ ] The default inbox scenario is visually and behaviorally usable through the existing renderer flow.
- [ ] The mock state resets to its curated baseline on reload.
