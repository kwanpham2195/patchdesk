# Plan 008: Migrate Patchdesk quality tooling to Oxc

> **Executor instructions**: Follow this plan step by step on a clean dedicated
> branch after Plans 001-007. Run every verification and confirm its expected
> result before continuing. Preserve the complete active lint policy, not only
> four explicitly configured rules. If a STOP condition occurs, stop and
> report. When done, update this plan's row in `plans/README.md` unless a
> reviewer maintains the index.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 7b4f6e6..HEAD -- \
>   package.json pnpm-lock.yaml eslint.config.js .prettierrc.json \
>   AGENTS.md src tests scripts
> git status -sb
> ```
>
> This migration intentionally runs last because formatter churn would obscure
> review of the functional and packaging plans. If the branch is dirty or Oxc
> versions have advanced, STOP and refresh the baseline before editing.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 001-007; start from a clean dedicated branch
- **Category**: dx / tooling / migration
- **Planned at**: commit `7b4f6e6`, 2026-08-13

## Goal

Replace ESLint and Prettier with Oxlint and Oxfmt while preserving the current
quality contract:

- strict TypeScript remains enforced by `pnpm typecheck`;
- lint has no warnings;
- double quotes and trailing commas remain the format convention;
- the Electron main process, preload, renderer, scripts, and tests are all
  covered;
- formatting changes land separately from behavior changes.

## Why this is worth doing last

The migration can reduce lint/format feedback time, but it has low direct user
gain and Oxfmt would rewrite hundreds of files. Run it only after higher-value
functional work is complete.

The current tooling is local, but its policy is broader than four explicit
rules:

- `eslint.config.js` includes `@eslint/js` recommended rules,
  `typescript-eslint` recommended rules, React Hooks rules, one ignore list,
  Node globals for `scripts/**/*.mjs`, browser/Node globals for TypeScript/TSX,
  and four explicit overrides.
- Oxc has native equivalents for the four explicit overrides:
  `typescript/no-explicit-any`, `typescript/no-non-null-assertion`,
  `typescript/consistent-type-imports`, and
  `react/only-export-components`.
- `.prettierrc.json` only sets double quotes and trailing commas. Oxfmt migrates
  both settings directly. Pin `printWidth` to 80 because Oxfmt defaults to 100
  and Prettier defaults to 80.
- `tsconfig.json` already owns strict type validation. Do not add
  `oxlint-tsgolint` or Oxlint type-aware checking in this migration.

The executor must inventory and map the effective recommended and React Hooks
rules before deleting ESLint. Calling only the four overrides “parity” is
incorrect. If Oxlint cannot express an active error-level rule, STOP for a
policy decision rather than silently weakening lint.

## Audit baseline

Collected 2026-08-13 from the current checkout:

```text
pnpm lint                              PASS in 4.04s
oxlint core + React/import plugins     20 existing warnings in 0.67s
oxlint with Vitest plugin              664 existing warnings
oxfmt migrated settings                would rewrite 307 files
prettier --check                       reports 302 files needing format
```

The Oxc warnings are not evidence of a behavior defect in this migration. They
come from rule families that the current ESLint config does not enable. Do not
expand the lint policy until after the parity migration is complete.

## Non-goals

- Do not replace TypeScript, Vite, SWC, Vitest, Playwright, or electron-vite.
- Do not enable new React, import, Unicorn, Vitest, accessibility, performance,
  style, or type-aware rules.
- Do not fix existing formatting in a behavior PR.
- Do not preserve ESLint or Prettier as a permanent fallback.
- Do not add an Oxc compiler or bundler integration; this is linting and
  formatting only.

## Preconditions

1. Start from a clean, dedicated branch. Do not mix this work with the current
   `fix/inline-conversation-freshness-repair` changes.
2. Confirm the installed pnpm version remains 8.8.0:

   ```bash
   pnpm --version
   git status -sb
   ```

3. Capture the baseline before modifying dependencies:

   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test -- --run
   pnpm build
   ```

4. Keep the following files open while migrating:

   ```text
   package.json
   pnpm-lock.yaml
   eslint.config.js
   .prettierrc.json
   tsconfig.json
   AGENTS.md
   ```

## Phase 1 — Migrate ESLint to Oxlint with rule parity

### 1. Inventory the full active ESLint policy

Before using the migrator, print the effective ESLint configuration for one
representative file in each class:

```bash
pnpm exec eslint --print-config src/services/review-write-gate.ts > /tmp/patchdesk-eslint-ts.json
pnpm exec eslint --print-config src/renderer/src/app.tsx > /tmp/patchdesk-eslint-tsx.json
pnpm exec eslint --print-config scripts/package-smoke.mjs > /tmp/patchdesk-eslint-script.json
```

Create a plan-local migration checklist in the PR description or commit notes
that records every enabled error/warning rule family and its Oxlint mapping.
At minimum include JS recommended, TypeScript recommended, React Hooks, and the
four explicit overrides. The `/tmp` files are evidence only and must not be
committed.

**Verify**: each JSON file parses and contains a non-empty `rules` object.

### 2. Add the migration tool only for generation

Run the official migrator from the repository root. It is a one-off tool and
must not be added to `devDependencies`.

```bash
pnpm dlx @oxlint/migrate@1.78.0 --details
```

If the migrator does not complete or cannot read the flat config, create
`.oxlintrc.json` manually from the current configuration. Do not block the
migration on the generator.

### 3. Create and review `.oxlintrc.json`

The final config must:

- point `$schema` at `./node_modules/oxlint/configuration_schema.json`;
- ignore `dist`, `out`, `out-electron`, `release`, and `node_modules`;
- set Node globals for `scripts/**/*.mjs`;
- set browser and Node globals for TypeScript and TSX files;
- enable the `typescript` and `react` plugins;
- enable the Oxlint categories/plugins that preserve every active recommended
  and React Hooks rule recorded in the inventory;
- preserve these rules and severities:

  ```json
  {
    "typescript/no-explicit-any": "error",
    "typescript/no-non-null-assertion": "error",
    "typescript/consistent-type-imports": "error",
    "react/only-export-components": [
      "warn",
      { "allowConstantExport": true }
    ]
  }
  ```

- disable `react/only-export-components` under
  `src/renderer/src/components/ui/**/*.tsx`;
- avoid enabling categories beyond the migrated rules;
- avoid the Vitest, import, Unicorn, JSX accessibility, and type-aware plugins
  unless a later policy change explicitly adopts their diagnostics.

Use Oxc's native name `react/only-export-components`, not the old
`react-refresh/only-export-components` name.

### 4. Add Oxlint and update scripts

Install a versioned local dependency:

```bash
pnpm add -D oxlint@1.78.0
```

Replace the `lint` command in `package.json` with:

```json
"lint": "oxlint --deny-warnings"
```

Run it before deleting ESLint packages:

```bash
pnpm lint
```

Compare Oxlint diagnostics with the effective ESLint baseline. Resolve only a
configuration mapping error. If Oxlint emits a rule that ESLint did not enforce,
disable that extra rule rather than changing application code. If an ESLint
error-level rule has no Oxlint equivalent, STOP; do not reduce policy silently.

### 5. Remove the old linter

After parity passes, remove:

```bash
pnpm remove eslint eslint-plugin-react-hooks eslint-plugin-react-refresh globals typescript-eslint
```

Delete `eslint.config.js`. Search for stale references:

```bash
rg -n "eslint|react-refresh/only-export-components" \
  --glob '!pnpm-lock.yaml' --glob '!plans/**' .
```

Keep documented references only if they accurately state that Oxlint is the
current linter.

### STOP — lint parity

Stop and ask for a policy decision if any current ESLint rule cannot be
expressed in Oxlint without adding an ESLint JavaScript plugin or type-aware
linting. Do not keep ESLint as a hidden compatibility layer.

## Phase 2 — Migrate Prettier to Oxfmt

### 1. Add Oxfmt and migrate configuration

```bash
pnpm add -D oxfmt@0.63.0
pnpm exec oxfmt --migrate prettier
```

Review the generated `.oxfmtrc.json`. It must preserve:

```json
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 80,
  "sortPackageJson": false
}
```

The explicit `sortPackageJson: false` prevents unrelated package manifest key
ordering changes. Keep Oxfmt sorting features disabled in this migration.

### 2. Add format scripts

Add the following scripts to `package.json`:

```json
"format": "oxfmt",
"format:check": "oxfmt --check"
```

Run the check before writing files:

```bash
pnpm format:check
```

Then run the formatter in a dedicated change:

```bash
pnpm format
pnpm format:check
```

Inspect the diff. Formatting must not alter behavior. Pay close attention to
TSX, CSS, JSON, Markdown, and Electron configuration files.

### 3. Remove Prettier and update wording

```bash
pnpm remove prettier
```

Delete `.prettierrc.json`. Update `AGENTS.md` to say Oxfmt, not Prettier, while
retaining the double-quote and trailing-comma convention.

Search for stale references:

```bash
rg -n "prettier|\.prettierrc" --glob '!pnpm-lock.yaml' --glob '!plans/**' .
```

Do not retain Prettier as a fallback after the Oxfmt format check passes.

### STOP — formatter compatibility

Stop and ask for a decision if Oxfmt cannot format a production file type in
this repository or if formatting a supported file changes its semantics. Do not
silently exclude that file type to preserve Prettier.

## Phase 3 — Verify the production surface

Run the full standard quality gate after both migrations:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm exec playwright test
```

For desktop or renderer changes caused by the formatter, verify the live app
read-only through CDP using the `patchdesk-electron-tester` workflow. The
migration should not require live behavior changes, so this is a smoke check,
not a substitute for the commands above.

Also confirm dependency cleanup:

```bash
pnpm why eslint prettier typescript-eslint
pnpm exec oxlint --version
pnpm exec oxfmt --version
git diff --check
git status -sb
```

`pnpm why` must show no direct dependency on ESLint, Prettier, or
`typescript-eslint`. A transitive dependency is acceptable only when it is not
part of the project tooling contract.

## Commit plan

Create small, ordered commits:

1. `chore: migrate linting to oxlint`
   - `.oxlintrc.json`, `package.json`, `pnpm-lock.yaml`, removal of
     `eslint.config.js`, and lint-related documentation.
2. `style: format code with oxfmt`
   - `.oxfmtrc.json`, formatter scripts, Prettier removal, `AGENTS.md`, lockfile,
     and formatter-only source changes.

Do not combine the formatter rewrite with feature, bug-fix, or generated-file
changes. If the reformat is too large for safe review, land it separately but
keep Oxfmt as the only formatter after its commit.

## Test plan

- Effective configs for representative TS, TSX, and script files are captured
  before migration.
- A checked parity inventory maps every active ESLint error/warning rule family
  to Oxlint or records the STOP decision.
- `pnpm lint` runs with `--deny-warnings` after ESLint removal.
- `pnpm format:check` covers all file types Prettier checked; no silent ignore
  is added for an unsupported production file type.
- Typecheck, full tests, build, Playwright, and live read-only smoke prove the
  tooling rewrite did not change behavior.

## Done criteria

All must hold:

- [ ] Effective JS/TS/React Hooks/explicit rule parity is documented and
      reviewed.
- [ ] No active ESLint error or warning was silently removed.
- [ ] Oxlint 1.78.0 and Oxfmt 0.63.0 are pinned in the lockfile, or this plan
      was refreshed for reviewed newer exact versions before execution.
- [ ] Lint and format migrations are separate reviewable commits.
- [ ] `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, full tests, build, and
      Playwright pass.
- [ ] No direct ESLint, TypeScript-ESLint, or Prettier tooling remains.
- [ ] `git diff --check` has no output.
- [ ] `plans/README.md` marks Plan 008 DONE.

## STOP conditions

Stop and report if:

- The working tree is not clean or another functional plan is in progress.
- An active ESLint error/warning rule has no native Oxlint equivalent.
- Oxfmt cannot format a production file type currently covered by Prettier.
- Migration requires an ESLint compatibility plugin or type-aware lint despite
  this plan's non-goals.
- Formatting changes semantics or cannot be isolated from behavior changes.
- A verification fails twice after one focused correction.

## Maintenance notes

- Review the effective-rule inventory whenever Oxlint categories change; a
  passing command is not parity if rules disappeared.
- Keep formatting-only commits separate from behavior work.
- Do not add type-aware lint until its cost and overlap with strict TypeScript
  are measured in a separate plan.

## References

- Oxc source cache: `~/.cache/checkouts/github.com/oxc-project/oxc`
- Oxlint migration guide:
  <https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint.html>
- Oxfmt migration guide:
  <https://oxc.rs/docs/guide/usage/formatter/migrate-from-prettier.html>
