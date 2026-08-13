---
created_at: 2026-08-13
repos:
  - patchdesk
status: complete
plan: plans/008-migrate-quality-tooling-to-oxc.md
---

# Oxlint rule parity

The effective ESLint configuration was captured before migration for:

- `src/services/review-write-gate.ts`: 69 enabled rules;
- `src/renderer/src/app.tsx`: 69 enabled rules;
- `scripts/package-smoke.mjs`: 80 enabled rules.

The temporary JSON evidence was stored under `/tmp/patchdesk-eslint-*.json` and
was not committed.

## Mapping

- ESLint recommended: migrated to native Oxlint core rules with the same error
  severity and file overrides.
- TypeScript-ESLint recommended: migrated to the native `typescript` plugin.
- React Refresh `only-export-components`: migrated to the native
  `react/only-export-components` rule with its warning severity,
  `allowConstantExport`, UI-wrapper override, and existing inline exceptions.
- React Hooks: the plugin was registered, but the effective configurations had
  no enabled `react-hooks/*` rules. No active Hook rule was removed.
- Explicit TypeScript rules: `typescript/no-explicit-any`,
  `typescript/no-non-null-assertion`, and
  `typescript/consistent-type-imports` remain errors.
- `no-undef`: enabled through Oxlint's native nursery rule for JavaScript and
  disabled for TypeScript, which matches the former effective configuration.
- `no-dupe-args` and `no-octal`: Oxlint rejects both as module/strict-mode
  syntax errors. Temporary fixtures confirmed nonzero exits for each case.

The migration enabled no import, Unicorn, Vitest, accessibility, performance,
or type-aware rule family. `pnpm lint` uses `oxlint --deny-warnings`.
