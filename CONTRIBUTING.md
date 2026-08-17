# Contributing to Patchdesk

Patchdesk is a local-first Electron workbench for preparing, inspecting, and
explicitly running pull-request reviews. Read `README.md` for setup and
commands, and `CONTEXT.md` for the domain language used across the codebase.

## Development environment

- pnpm 8.8.0 and Node >= 22.19.0 (pinned in `package.json`).
- `pnpm install` installs the pre-commit hook automatically (husky).
- Development runs on macOS; `pnpm package:mac` builds the release package.

## Codebase map

- `src/domain/` — types and invariants.
- `src/services/` — orchestration.
- `src/adapters/` — I/O (GitHub, storage, providers).
- `src/main/` — Electron main process; `src/renderer/src/` — React.
- `runtime/flue/` — the isolated Flue 2 insight runtime.
- `tests/` mirrors those boundaries; browser coverage in `tests/browser/`.
- Architecture: `docs/architecture.md`; decisions: `docs/adr/`.

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

## Pull requests

Base branch: `main`. Keep PRs focused on one logical change. User-visible
behavior changes must update the relevant docs; architectural decisions go
through an ADR in `docs/adr/`.
