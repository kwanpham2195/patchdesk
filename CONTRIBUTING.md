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
   Oxfmt, then Oxlint with denied warnings, applies the file-size ratchet to
   them, and then runs the repo-wide Oxlint count ratchet over the staged
   change.
2. React Doctor scans staged files and remains blocking.

The count ratchet runs on every commit, not only in a pull request, and it
runs even when nothing source-like is staged: a lone `.oxlintrc.json` change
is exactly what it exists to gate. It adds about 1 second to a commit.

The staged gate is check-only. It rejects partially staged source files and
never changes the index or working tree. If it blocks, run
`pnpm exec oxfmt --write <files>` and
`pnpm exec oxlint --fix --deny-warnings <files>`, review the changes, and
stage the intended files explicitly.

Repo-wide `pnpm lint` is clean and blocking. The repository reports zero
Oxlint findings, and the pull request gates run `pnpm lint` over the whole
tree, so a finding anywhere fails the build, not only one in a file the change
happens to touch. There is no legacy backlog left to work around.

### The count ratchet

The count ratchet runs Oxlint over the whole repository and compares the
finding count with the baseline recorded in `lint-baseline.json`, which is now
`0`. Three rules:

- The count rose. The check fails and names both numbers. Fix the new
  finding, or raise `findings` deliberately when the increase is reviewed.
- The count fell. The check fails too, and asks you to set `findings` to the
  new number and stage `lint-baseline.json` in the same commit. A drop nobody
  records is a drop that can drift back up unnoticed.
- `.oxlintrc.json` (or an Oxlint plugin under `tools/oxlint/`) changed while
  `lint-baseline.json` is not part of the change at all. The check fails
  before Oxlint even runs. "Part of the change" is read off the change's own
  path list — `git diff --cached --name-only` on a commit, the base/head diff
  in CI — so **staging `lint-baseline.json` unchanged does not satisfy this
  rule**: it leaves no diff entry, and nothing then tells that change apart
  from one that never touched the file. A config edit that moves no count
  must still write something into the baseline; say so in its `note`
  ("recounted after X, still 0"). Deleting a config file counts as changing
  it.

  This rule does not catch a change that loosens some findings away and adds
  the same number of new ones. The count nets back to the baseline, so the
  baseline is correct and there is nothing to object to. No gate comparing
  one number with one number can see that; catching it would need a baseline
  of finding identities rather than of finding totals.

The baseline is read with `git show <revision>:lint-baseline.json`, out of
the commit under test rather than the working tree, so an edit you never
staged still reads as the old number.

At a baseline of `0`, a blocking `pnpm lint` already covers the first rule and
empties the second: a new finding fails lint, and the count cannot fall below
zero. The third rule is why the ratchet stays. A green `pnpm lint` proves only
that nothing violates the rules that are switched on; it says nothing about
which rules those are. Turn a rule off, or add a per-file override, and the
count stays at zero and lint stays green. The config gate is the only check
that makes such a change announce itself, by refusing any `.oxlintrc.json` or
`tools/oxlint/` edit that does not change `lint-baseline.json` alongside it.
It also runs on every commit, where CI runs only on a pull request. `pnpm
lint` guards the findings; the ratchet guards the rules.

This claim was tested rather than assumed, both directions, with a real
pre-commit hook in a throwaway worktree: three anti-slop rules switched off
and `.oxlintrc.json` staged alone is **rejected**, and the same edit staged
together with an updated `lint-baseline.json` is **accepted**. An earlier form
of the gate asked `git ls-files --stage` / `git ls-tree` whether the baseline
was present, which reports a tracked file unconditionally — so it answered
"yes" for every change and the gate never fired. `tests/scripts/` now covers
both directions.

Oxlint reads the whole working tree, uncommitted edits included. If unstaged
work moved the number, commit or set that work aside rather than moving the
baseline to match it.

The Knip ratchet (`pnpm knip:ratchet`, baseline `knip-baseline.json`) works
the same way. It is not part of `pnpm precommit`: Knip answers a whole-project
reachability question, so an ordinary mid-refactor commit moves its count for
a reason that has nothing wrong with it, and a gate that rejects that commit
gets switched off. It runs in `pnpm check` and in the pull request gates.

The Knip baseline is zero. Every unused file, export, and type has been
removed or made module-private, so the ratchet and a bare blocking `pnpm knip`
are now the same gate. Fix a new finding by deleting the dead code or dropping
the `export` keyword; do not raise the baseline.

Do not silence findings by weakening rules, adding casts, or faking
`SAFETY:` comments. Genuine I/O boundaries keep `unknown` via targeted
per-file overrides listed file by file in `.oxlintrc.json`'s `overrides`
array, never by a directory glob, and a `SAFETY:` comment must state the
invariant the surrounding code checked, not restate what the code does.

## Verifying before pushing

`pnpm check` is the pre-handoff command: it runs `pnpm typecheck`,
`pnpm test:root`, `pnpm lint:staged` (checks what you will commit), then
`pnpm knip:ratchet`, in that order, and stops at the first failure.
`pnpm lint:staged` reports "no staged source files" when nothing is staged
and still runs the count ratchet, so the repo-wide finding count is checked
either way.

Beyond `pnpm check`:

- `pnpm test:all` (root suite and separate `runtime/flue` suite) — the
  complete test gate; `pnpm check` only runs the root suite.
- `pnpm knip` prints the unused files, exports, and dependencies behind the
  Knip ratchet's number. `pnpm check` runs the ratchet; run `pnpm knip` when
  you need to see which entries make it up.
- For desktop or renderer changes: `pnpm build`, then the focused browser
  suite (`pnpm test:e2e` or `pnpm test:performance`).

Pull requests targeting `main` run the `Pull request gates` workflow on
`macos-14`. It runs these named checks in order:

- `pnpm lint:changed -- <base> <head>` for changed JavaScript and TypeScript
  files only, plus the Oxlint count ratchet;
- `pnpm knip:ratchet -- <base> <head>`;
- `pnpm lint` over the whole repository;
- `pnpm typecheck`;
- `pnpm test:all`, including the root suite and separate `runtime/flue` suite;
- `pnpm test:bundle`; and
- `pnpm test:e2e`.

`pnpm lint:changed` also checks formatting, which is why it stays beside the
repo-wide `pnpm lint`: one covers the shape of the changed files, the other
covers every finding in the tree. CI does not run package smoke or release
operations.

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
