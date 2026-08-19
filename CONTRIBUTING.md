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

## Making changes

Branch from `main` using `<type>/<slug>` with types
`feat`, `fix`, `chore`, `refactor`, `test`, `docs`, `ci`, `perf`.

Commit with a lowercase imperative summary, no trailing period:
`<type>(<scope>): <summary>` (example: `fix(storage): quarantine corrupt review records`).
One logical unit per commit. Do not add AI or co-authored trailers.

## The commit gate

Commits run `pnpm precommit`:

1. React Doctor scan on staged files (blocking).
2. `pnpm lint:staged` — oxlint `--fix` over staged files only; blocks if
   unfixable findings remain.

The anti-slop lint migration is in progress, so `pnpm lint` is red
repo-wide (~1850 findings, tracked in `.agents/PLANS/2026-08-16-anti-slop-migration.md`).
Only the files you stage are checked, so commits work as long as the staged
files are clean. If a commit is blocked, fix the findings in the staged
files (anti-slop rules are not auto-fixable), then `git add` them again.

Do not silence findings by weakening rules, adding casts, or faking
`SAFETY:` comments. Genuine I/O boundaries keep `unknown` via targeted
per-file overrides in `.oxlintrc.json` with a boundary contract comment
(see `AGENTS.md`, "Anti-slop migration").

## Verifying before pushing

- `pnpm typecheck`
- `pnpm test -- --run`
- `pnpm lint:staged` (checks what you will commit)
- For desktop or renderer changes: `pnpm build`, then the focused browser
  suite (`pnpm test:e2e` or `pnpm test:a11y`, `pnpm test:performance`).

There is no CI yet. The local gates are the contract.

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
