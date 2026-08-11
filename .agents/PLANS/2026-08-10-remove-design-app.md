---
created_at: "2026-08-10"
repos:
  - patchdesk
status: complete
---

# Remove the Design app

## Scope

Remove the separate Vite Design app and its deterministic mock bridge. Preserve the production Electron renderer, Walkthrough UI, production browser tests, and approved HTML design artifacts under `.agents/archive/`.

## Steps

1. Delete `src/design/`, `vite.design.config.ts`, Design-only browser and unit tests.
2. Remove Design scripts and documentation from `package.json`, `README.md`, and `AGENTS.md`.
3. Prove no application references remain, then run the standard lint, typecheck, unit, build, and browser gates.

## Risk

The removed app is isolated from production source, but its old mock surface may have masked a reference. Typecheck, search, and the production build will detect that drift.

## Verification

- `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run`, and `pnpm build` passed.
- The full production browser suite remains blocked by 24 existing workbench/accessibility fixture failures; none references the removed Design app.
