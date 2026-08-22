# Contributing to Patchdesk

Patchdesk is a local-first Electron workbench for preparing, inspecting, and
explicitly running pull-request reviews. See `README.md` for what Patchdesk
is and how to install the packaged app; this file covers building it from
source and contributing changes. Read `CONTEXT.md` for the domain language
used across the codebase.

## Development environment

- pnpm 8.8.0 and Node >= 22.19.0 (pinned in `package.json`). Electron 43.1.1
  embeds a compatible Node release.
- `pnpm install` installs the pre-commit hook automatically (husky).
- Development runs on macOS; `pnpm package:mac` builds the release package.
- The isolated Flue 2 insight runtime (`runtime/flue/`) has an exact lock
  and is validated during package smoke.

## Codebase map

- `src/domain/` — types and invariants.
- `src/services/` — orchestration.
- `src/adapters/` — I/O (GitHub, storage, providers).
- `src/main/` — Electron main process; `src/renderer/src/` — React.
- `runtime/flue/` — the isolated Flue 2 insight runtime.
- `tests/` mirrors those boundaries; browser coverage in `tests/browser/`.
- Architecture: `docs/architecture.md`; decisions: `docs/adr/`.

## Building and running

From a fresh clone, `pnpm install` followed by `pnpm dev` is all that is
needed:

```bash
pnpm install
pnpm dev
```

`pnpm install` runs the root `prepare` script, which installs and builds
`runtime/flue`'s dependencies — the isolated runtime the Insight feature
needs. `pnpm dev` builds that runtime again before starting electron-vite, so
Insight works with no extra step even if the runtime is stale.

If you ran `pnpm install --ignore-scripts`, `prepare` did not run and the
runtime is missing; recover with:

```bash
pnpm --dir runtime/flue install
pnpm --dir runtime/flue build
```

**Fast checks.**

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
```

Use `pnpm test -- --run <file>` for focused root-suite development. The complete pre-push test gate is `pnpm test:all`; it runs the root suite and the separate `runtime/flue` suite.

## Making changes

Branch from `main` using `<type>/<slug>` with types
`feat`, `fix`, `chore`, `refactor`, `test`, `docs`, `ci`, `perf`.

Commit with a lowercase imperative summary, no trailing period:
`<type>(<scope>): <summary>` (example: `fix(storage): quarantine corrupt review records`).
One logical unit per commit. Do not add AI or co-authored trailers.

## The commit gate

Commits run `pnpm precommit`:

1. `pnpm lint:staged` checks every staged JavaScript and TypeScript file with
   Oxfmt, then Oxlint with denied warnings.
2. React Doctor scans staged files and remains blocking.

The staged gate is check-only. It rejects partially staged source files and
never changes the index or working tree. If it blocks, run
`pnpm exec oxfmt --write <files>` and
`pnpm exec oxlint --fix --deny-warnings <files>`, review the changes, and
stage the intended files explicitly.

Repo-wide `pnpm lint` remains a diagnostic while untouched legacy findings are
migrated. Every staged source file must be clean, but untouched findings do
not block focused changes.

Do not silence findings by weakening rules, adding casts, or faking
`SAFETY:` comments. Genuine I/O boundaries keep `unknown` via targeted
per-file overrides in `.oxlintrc.json` with a boundary contract comment
(see `AGENTS.md`, "Anti-slop migration").

## Verifying before pushing

- `pnpm typecheck`
- `pnpm test:all` (root suite and separate `runtime/flue` suite)
- `pnpm lint:staged` (checks what you will commit)
- For desktop or renderer changes: `pnpm build`, then the focused browser
  suite (`pnpm test:e2e` or `pnpm test:a11y`, `pnpm test:performance`).

Pull requests targeting `main` run the `Pull request gates` workflow on
`macos-14`. It runs these named checks in order:

- `pnpm lint:changed -- <base> <head>` for changed JavaScript and TypeScript
  files only;
- `pnpm typecheck`;
- `pnpm test:all`, including the root suite and separate `runtime/flue` suite;
- `pnpm test:bundle`; and
- `pnpm test:e2e`.

CI checks changed-file formatting and lint only while untouched repo-wide
legacy findings remain. It does not run package smoke or release operations.

## Release package

Build a macOS directory package, then smoke-test it:

```bash
pnpm package:mac
pnpm test:package-smoke
```

`pnpm package:mac` runs `pnpm stage:flue-runtime` as part of the build,
which builds and stages the exact isolated Flue runtime into the package.
Package smoke runs fixed faux Analysis and Walkthrough fixtures before UI
checks.

`pnpm package:mac` produces both `release/mac-arm64/Patchdesk.app` (the
unpacked app `pnpm test:package-smoke` reads) and
`release/Patchdesk-0.1.0-arm64-mac.zip` (~196 MiB) — note the zip sits
directly in `release/`, not in `release/mac-arm64/`. That zip is what you
hand to another developer; a `.blockmap` sidecar is written next to it and
is not part of the handoff.

The packaged build is ad-hoc signed, not Apple-signed or notarized, so the
recipient must clear the quarantine attribute before first launch (see
`README.md`, "Install") — pass that instruction along with the zip.

## Pull requests

Base branch: `main`. Keep PRs focused on one logical change. User-visible
behavior changes must update the relevant docs; architectural decisions go
through an ADR in `docs/adr/`.
