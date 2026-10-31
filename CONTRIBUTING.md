# Contributing to Patchdesk

Patchdesk is a local-first Electron workbench for preparing, inspecting, and
explicitly running pull-request reviews. See `README.md` for what Patchdesk
is and how to install the packaged app; this file covers building it from
source and contributing changes. Read `docs/product-description/glossary.md`
for the domain language used across the codebase.

## Development environment

- pnpm 8.8.0 and Node >= 22.19.0 (pinned in `package.json`). Electron 43.7.7
  embeds a compatible Node release.
- `pnpm install` installs the pre-commit hook automatically (husky).
- Development runs on macOS; `pnpm package:mac` builds the release package.
- Insight generation uses an installed Codex or Pi CLI and its local account.
  See `docs/adr/0056-run-insights-through-native-cli-accounts.md`.

## Codebase map

- `src/domain/`: types and invariants.
- `src/services/`: orchestration.
- `src/adapters/`: I/O (GitHub, storage, providers).
- `src/main/`: Electron main process. `src/renderer/src/`: React renderer.
- `src/adapters/codex/` and `src/adapters/pi-cli/`: native CLI integrations.
  Guide and Walkthrough use host-validated operations through those clients.
- `tests/` mirrors those boundaries; browser coverage in `tests/browser/`.
- Architecture: `docs/architecture.md`; decisions: `docs/adr/`.
- UI conventions: `docs/ui-guide.md`.

## Building and running

From a fresh clone, `pnpm install` followed by `pnpm dev` is all that is
needed:

```bash
pnpm install
pnpm dev
```

`pnpm install` runs the root `prepare` script to install Husky. `pnpm dev`
starts electron-vite. New Insight runs require Codex or Pi CLI on the app's
launch PATH and an external login to that CLI. Patchdesk lists account models
only after an explicit Load models action. It bundles no API-key Insight
runtime. See [Upgrading Pi](docs/upgrading-pi.md) for the Pi integration.

**Dev profile.** `pnpm dev` keeps its config, data and cache apart from the
installed app: `~/.config/patchdesk-dev`, `~/.local/share/patchdesk-dev` and
`~/.cache/patchdesk-dev`, so a setting changed in the dev app never reaches an
installed Patchdesk and the two never write the same Review records. The dev
profile starts empty. `pnpm dev:copy-profile` copies `config.json` and the
profiles from `~/.config/patchdesk` so the dev app starts with the same
workspaces and watchlists; it copies no data or cache, and refuses when the dev
config exists unless you pass `--force`. `PATCHDESK_DEV_SHARED=1 pnpm dev` runs
the dev app against the installed roots for a check that needs the real store;
the app logs which roots it uses at startup (topic `paths`).

**Worktree dev profile.** In a linked git worktree, `pnpm dev` keeps its
config, data, cache and Electron user data in the gitignored
`.patchdesk-dev/` folder, derives the CDP and Vite ports from the worktree
path (stable across restarts, printed on the `dev:` startup line) and uses its
own MCP socket and `refs/patchdesk-dev-<hash>` ref namespace, so it runs
beside the main dev app and the installed app. The first run seeds it:
`config.json` (notifications off, so no background watching or desktop
notifications) and profiles from `~/.config/patchdesk`, and a copy of the
main dev app's data store from `~/.local/share/patchdesk-dev`. The dev store
is the source because a dev build refuses Review files an older installed
release wrote. Data only flows into the worktree. Delete `.patchdesk-dev/` to
reseed. `PATCHDESK_DEV_SHARED=1` opts out. `pnpm cdp:ready` and
`pnpm -s mcp:shim` resolve the current checkout's port and socket.

**The MCP shim.** The dev app listens on
`~/.local/share/patchdesk-dev/mcp/patchdesk.sock`, so it and an installed
Patchdesk can listen side by side (ADR 0052). `pnpm -s mcp:shim`
runs the shim the dev app's main build writes to `out/main/mcp-shim.js`
against that socket (with `PATCHDESK_DEV_SHARED=1` the app listens on
`~/.local/share/patchdesk/mcp/patchdesk-dev.sock`; set `PATCHDESK_MCP_SOCKET` to it); `pnpm -s mcp:shim --check` calls `list_repositories` and
prints the result. Keep `-s`: without it pnpm prints its banner to stdout,
which is the MCP channel. To register it with a client, give the client the
command `pnpm -s mcp:shim` with this checkout as its working directory.

**Fast checks.**

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
```

During implementation, use source inspection, formatting, lint, typechecking,
and live verification. Defer unit tests and test-running checks until final
verification unless the maintainer explicitly approves an exception.
At final verification, `pnpm test -- --run <file>` targets an affected test file,
and `pnpm check:package root` runs the root package's typechecks, import and
error-UI checks, lint, and whole test suite. Root is the only package selection;
missing or unknown names fail. Commits run changed-file checks only (see "The
commit gate"); the full `pnpm check` runs once at landing.

## Where a test belongs

`AGENTS.md` ("Testing") holds the rules for which layer a test goes in, and
they are not advisory: test at the lowest layer that can observe the behaviour.
Necessary repairs to existing tests are included in an approved fix. New scenarios
or expanded coverage require separate approval, and no new renderer tests are
allowed until asked. Implement first and verify behavior before adding approved
tests. For approved hook coverage of timing, generations, optimistic state, or
request payloads, use a fake bridge rather than a mounted component.
Approved component coverage queries meaningful rendering and actions by role or label. Test component logic
through observable behaviour; extract domain logic when it has a separate
responsibility, without exporting
internals solely for tests. `tests/browser/` is for end-to-end journeys and
for what only a real browser shows. Keep detailed behaviour assertions at their
lowest useful layer; a small end-to-end journey may exercise the same behaviour
to prove the layers work together. There is no assistive-technology lane (ADR 0034):
no axe scans, no screen-reader narration checks, no forced-colors or
reduced-motion checks. Use the shared doubles rather than hand-rolling one.

`tests/browser/` has no accepted-failure list. Pull request CI is paused; run the
local merge gates below. Repair failures caused by approved work and rerun without
another pause. Stop for unrelated failures or repairs outside scope. Ask before
removing intentional code or tests.

## Making changes

Branch from `main` using `<type>/<slug>` with types
`feat`, `fix`, `chore`, `refactor`, `test`, `docs`, `ci`, `perf`.

Commit with a lowercase imperative summary, no trailing period:
`<type>(<scope>): <summary>` (example: `fix(storage): quarantine corrupt review records`).
One logical unit per commit. Do not add AI or co-authored trailers.

## The commit gate

Commits run `pnpm precommit`, which checks the staged paths and stops at the
first failure (`planStagedChecks` in `scripts/precommit.mjs` is the list):

1. Always: `pnpm lint:staged` checks every staged JavaScript and TypeScript
   file with Oxfmt, then Oxlint with denied warnings, and applies the
   file-size ratchet to them. Staged Markdown files get `oxfmt --check`. A
   Markdown-only commit runs nothing else.
2. `pnpm typecheck` when a `.ts`/`.tsx` file or `tsconfig.json` is staged.
3. `pnpm typecheck:scripts` when `scripts/`, `tsconfig.json`,
   `tsconfig.scripts.json` or its baseline is staged.
4. `pnpm check:imports` when JavaScript or TypeScript under `src/`, `tests/`,
   `scripts/` or `tools/` is staged; `pnpm check:error-ui` when `src/renderer/`
   is staged.
5. `pnpm lint:changed -- origin/main` when `.oxlintrc.json`, a rule under
   `tools/oxlint/`, or `lint-baseline.json` is staged, so the config rule and
   the count ratchet still apply.
6. `pnpm knip:ratchet` when code under `src/`, `tests/` or `scripts/`,
   `knip.json`, `knip-baseline.json` or `package.json` is staged.
7. `tests/scripts/context-budget.test.ts` when code under `src/`, `AGENTS.md`
   or `context-budget.json` is staged: the budget file must equal the measured
   byte sizes of the model-facing text (Insight output guidance, session
   prompts, the MCP tool list, `AGENTS.md`). Update it with
   `node scripts/check-context-budget.mjs --write`; run it after shrinking
   measured text too, or the budget test blocks the next `src/` commit. The
   `commit-msg` hook (`scripts/check-context-budget.mjs`) fails a commit that
   grows any value over `HEAD`'s budget (`HEAD^`'s when amending) unless the
   message has a line `context-increase: <reason>`. It measures the working
   tree, so it also fails while `AGENTS.md` or `src/` has unstaged changes, and
   it skips merges. The `CI` workflow compares the sizes on `main` with the
   budget before the push and passes when any pushed commit has the line.
8. `vitest related --run` over the staged code files, not the whole suite.
   A failing test outside their import graph does not block the commit, and
   `related` misses tests that only spawn a script, so script changes rely on
   the landing check.
9. React Doctor scans staged files when anything under `src/` is staged, and
   remains blocking unless it cannot read the tree it would scan (below).

The full `pnpm check` is the landing gate. Run it on the rebased head before
merging; it is the only place the whole suite, `pnpm lint:changed` over the
branch and the cross-file ratchets are guaranteed to run.

Meet that gate when a slice is done, not when you go to commit.
`pnpm gate:preflight <paths>` runs the same three checks, Oxfmt, Oxlint with
denied warnings, and the size ratchet, over the paths you name,
reading them from the working tree instead of from the index, so nothing has
to be staged first. Ten slices each fixing their own two files is ten small
corrections; one commit of seventy files is a single large one. It also keeps
what the gate judges close to what you wrote: `lint:staged` judges a staged
file absolutely, not by what your change added, so a slice that touches a file
already carrying findings inherits every one of them at commit time.

React Doctor reads `package.json`, and several sessions share this checkout, so
another session staging that file leaves it different between the index and the
working tree. React Doctor aborts on that, which says nothing about your
change, so `pnpm precommit` decides instead of letting the abort through. When
`package.json` differs and no `src/renderer/` file is staged, the scan is
skipped and says so. Nothing was scanned, so this is not a pass. When
`package.json` differs and renderer files are staged, the commit fails: the one
scan that mattered is the one that could not run, so restore or stage
`package.json` and retry. Otherwise React Doctor runs as before.

Invoke repo tools through `pnpm exec`. A global `oxfmt` or `oxlint` on `PATH`
may be a different version, and a different version disagrees with the gate:
it rejects files this repository formats correctly, and reformatting to satisfy
it breaks the repository check instead.

The repo-wide Oxlint count ratchet runs through `pnpm lint:changed` (see "The count ratchet" and "Verifying before pushing").

Pushes run no hook: the landing `pnpm check` validates the whole branch, and
a push-time copy of its checks only repeated them.

The staged gate is check-only. It rejects partially staged source files and
never changes the index or working tree. If it blocks, run
`pnpm exec oxfmt --write <files>` and
`pnpm exec oxlint --fix --deny-warnings <files>`, review the changes, and
stage the intended files explicitly.

Repo-wide `pnpm lint` is clean and blocking. The repository reports zero
Oxlint findings, and the local merge gate runs `pnpm lint` over the whole
tree, so a finding anywhere fails the build, not only one in a file the change
happens to touch. There is no legacy backlog left to work around.

### The count ratchet

The count ratchet runs Oxlint over the whole repository and compares the
finding count with the baseline recorded in `lint-baseline.json`, which is now
`0`. Three rules:

- The count rose. The check fails and names both numbers. Fix the new
  finding, or raise `findings` deliberately when the increase is reviewed.
- The count fell. The check fails too, and asks you to set `findings` to the
  new number and stage `lint-baseline.json` in the same commit. Updating the
  baseline records the lower count so a later increase fails the check.
- `.oxlintrc.json` (or an Oxlint plugin under `tools/oxlint/`) changed while
  `lint-baseline.json` is not part of the change at all. The check fails
  before Oxlint even runs. "Part of the change" is read off the change's own
  path list from `git diff --cached --name-only` on a commit or the base/head
  diff in CI. **Staging `lint-baseline.json` unchanged does not satisfy this
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
`pnpm lint` guards the findings; the ratchet guards the rules.

This claim was tested rather than assumed, both directions: three anti-slop
rules switched off and `.oxlintrc.json` staged alone is **rejected** by
`pnpm lint:changed`, and the same edit staged together with an updated
`lint-baseline.json` is **accepted**. An earlier form of the gate asked
`git ls-files --stage` / `git ls-tree` whether the baseline was present, which
reports a tracked file unconditionally, so it answered "yes" for every change
and the gate never fired. `tests/scripts/` now covers both directions.

Oxlint reads the whole working tree, uncommitted edits included. If unstaged
work moved the number, commit or set that work aside rather than moving the
baseline to match it.

The Knip ratchet (`pnpm knip:ratchet`, baseline `knip-baseline.json`) works
the same way. It runs in `pnpm check` and in `pnpm precommit` when its inputs are staged.
Pull request CI is paused; the local merge gate also runs it.

The Knip baseline is zero. Every unused file, export, and type has been
removed or made module-private, so the ratchet and a bare blocking `pnpm knip`
are now the same gate. Fix a new finding by deleting the dead code or dropping
the `export` keyword; do not raise the baseline.

### The `scripts/` typecheck ratchet

`pnpm typecheck` covers `src` and `tests`. It cannot cover `scripts/`: those
modules are plain JavaScript, and `tsconfig.json`'s `include` does not list
them. `tsconfig.scripts.json` does, with `allowJs` and `checkJs`, and
`pnpm typecheck:scripts` (baseline `scripts-typecheck-baseline.json`) holds
the count the same way the Oxlint and Knip ratchets hold theirs: a rise fails,
and so does a drop nobody records. It runs in `pnpm check`, in the local merge gate, and in `pnpm precommit` when `scripts/` or the TypeScript configs are staged.

Seven hand-written `scripts/*.d.mts` files stood beside these modules until
2026-08-29. They were not a convenience: TypeScript prefers a declaration file
over its `.js` sibling both when resolving an import and when expanding an
`include` glob, so those files kept the real implementations out of every
program the repository ever compiled. Nothing had type-checked the code they
described. Deleting them is what turned this check on, and it is why the
declarations no longer exist to drift: `tests/scripts/**` now checks against
the implementations themselves.

Unlike the other two, this baseline does not start at zero. It starts at 131,
because that is what the first run found. 124 of the 131 are an implicit `any`
on a parameter or a destructured binding, each one a JSDoc annotation away
from gone; annotating them is its own piece of work. Lower the baseline as
they land. Do not raise it.

### The size ratchet

`pnpm lint:staged` and `pnpm lint:changed` both apply it to every changed
JavaScript and TypeScript file. Two rules:

- **No file may grow past 1,000 lines.** A file at 999 lines cannot become
  1,001, and a file already at 3,020 cannot become 3,021. The ceiling is
  absolute, so it composes: forty commits of five lines each meet it in the
  same place one commit of two hundred does.
- **A new file may not exceed 500 lines.** A rename is not a new file: the
  ratchet reads the old path's count at the base revision first.

`*.generated.ts` is exempt because its generator controls the file size.

The ceiling replaced an earlier rule that only blocked a file _already over_
1,000 lines. That left a blind band: anything between 501 and 999 lines could
grow freely, and the change that carried a file over the line could carry it
as far as it liked. Two files in this repository did exactly that.
`tests/scripts/lint-staged.test.ts` went 763 → 1,111 in one commit and
`tests/services/review-workbench-projection.test.ts` went 981 → 1,097 in
another; both sit above the ceiling now and are frozen there. Replaying the
ceiling over the 39 commits that touched source since the ratchet landed
blocks those two changes and nothing else.

Growth that is **only added import specifiers** is exempt (see
`isImportSpecifierOnlyGrowth` in `scripts/file-growth-lib.mjs`). Without it
the ratchet refuses the change that makes a file smaller: naming an imported
type instead of repeating it inline costs one line inside an import
declaration, and a file already at the ceiling could not spend it. The
exemption requires both conditions: nothing outside import declarations may
gain a line, and at least one specifier must be added. This prevents a
comment, a blank line between specifiers, or a body statement from riding
along. Which lines are import lines is decided by parsing the declaration
whole, and the two revisions are compared by the text of the lines that
differ rather than by a count of each kind, so moving where the import region
ends buys nothing. It never applies to a new file, which has no base to
compare against.

Do not silence findings by weakening rules, adding casts, or faking
`SAFETY:` comments. Genuine I/O boundaries keep `unknown` via targeted
per-file overrides listed file by file in `.oxlintrc.json`'s `overrides`
array, never by a directory glob, and a `SAFETY:` comment must state the
invariant the surrounding code checked, not restate what the code does.

## Verifying before pushing

`pnpm check` is the landing gate: run it on the rebased head before merging. It runs `pnpm typecheck`,
`pnpm typecheck:scripts`, `pnpm check:error-ui`, `pnpm check:imports`,
`pnpm test:all`,
`pnpm lint:staged` (checks what you will commit),
`pnpm lint:changed -- origin/main` (checks the whole branch as the local
merge gate does), then `pnpm knip:ratchet`, in that order, and stops at the
first failure. `pnpm check:error-ui` scans the renderer for a literal
`role="alert"` outside the three primitives that own one (`alert.tsx`,
`field.tsx`, `inline-error.tsx`), so error surfaces stay in those components.
`pnpm check:imports` rejects parent-climbing module specifiers, not filesystem paths or fixture strings. Root-owned code imports across directories through package `#src/*`, `#tests/*`, `#scripts/*`, and `#tools/*`; `#package` and `#resources/*` cover root assets. Portable anti-slop plugins use package-local `#anti-slop/*`. Keep `./` imports for files in the same directory. `pnpm lint:staged` reports "no staged source files" when nothing is staged.
The repo-wide count ratchet runs once inside `pnpm lint:changed`.

Full checks serialize through `patchdesk-full-check.lock` in
Git's common directory, shared by all worktrees. Later runs wait and print the
lock path, then fail after ten minutes. Success, command failure, and handled
SIGINT/SIGTERM release the owned lock after the owned process group finishes.
If that group does not stop, the gate fails and retains the lock. A crash
or SIGKILL also leaves the lock in place. Inspect `owner.txt` and confirm the owner
and its children have stopped before manually removing it. Never remove an
active lock or stop another check to get the gate through.

`pnpm check` runs both shapes of the changed-source gate on purpose. The
staged shape measures one commit's worth of change against `HEAD`; the branch
shape measures every file the branch has touched since it left `origin/main`,
so a file that stopped formatting cleanly, or grew past the size ceiling,
twenty commits ago is caught before CI finds it.

`pnpm lint:changed` takes its head two ways. With a base and a head it is that
commit pair, which is what CI passes. **With a base alone it reads the index
as head**, from `git merge-base <base> HEAD`. This lets `pnpm check` report on
the staged change instead of the tree before the fix.
`origin/main` is the pull request's base branch. Run `git fetch` first so a
stale remote-tracking ref does not make the check use an outdated range.

Beyond `pnpm check`:

- `pnpm test:coverage` runs the root suite under V8 coverage over `src/`
  (fixture routes excluded) and prints a summary; the HTML report lands in
  `coverage/`, which is ignored. There is no coverage threshold; the number is
  for orientation, not a gate.
- `pnpm knip` prints the unused files, exports, and dependencies behind the
  Knip ratchet's number. `pnpm check` runs the ratchet; run `pnpm knip` when
  you need to see which entries make it up.
- For desktop or renderer changes: `pnpm build`, then the focused browser
  suite (`pnpm test:e2e` or `pnpm test:performance`).
- `pnpm cdp:ready` says whether the dev app is reachable over CDP, on
  `REMOTE_DEBUGGING_PORT` or on 9233 when that is unset. Live verification of
  the running app starts there; it prints how to start the app when the port
  is down.

The `CI` workflow (`.github/workflows/ci.yml`) runs typecheck, lint and the
root suite on `ubuntu-latest`, and the build, bundle check and browser suite
on `macos-14`, on every push to `main` only. It backs up the landing gate
after the fact; it does not gate pull requests.

The `Pull request gates` workflow, which used to run these checks on
`macos-14` for every pull request targeting `main`, has been paused since
2026-09-03. Its steps are now run by hand on the maintainer's machine before
a merge, in this order:

- `pnpm lint:changed -- <base> <head>` for changed JavaScript and TypeScript
  files only, plus the Oxlint count ratchet;
- `pnpm knip:ratchet -- <base> <head>`;
- `pnpm typecheck:scripts -- <base> <head>`;
- `pnpm check:error-ui`;
- `pnpm lint` over the whole repository;
- `pnpm typecheck`;
- `pnpm test:all`, which runs the root suite;
- `pnpm build`, once, for both checks below it;
- `pnpm check:bundle` against that build; and
- `pnpm exec playwright test` against that same build.

The local equivalent, in this order:

```bash
git fetch origin
pnpm lint:changed -- origin/main HEAD
pnpm knip:ratchet -- origin/main HEAD
pnpm typecheck:scripts -- origin/main HEAD
pnpm check:error-ui
pnpm lint
pnpm typecheck
pnpm test:all
pnpm build
pnpm check:bundle
CI=1 pnpm exec playwright test
```

The gate builds once. `pnpm test:bundle` and `pnpm test:e2e` each run
`pnpm build` first, which is what you want locally and a wasted second build
when repeated, so the merge gate runs `pnpm build` as its own step and then
the two check-only commands underneath it.

The browser suite carries two timing budgets, both stated in
`tests/browser/timing-budget.ts`. A local run holds the performance proof to
a 200 ms worst interaction, a 300 ms main-thread gap during filtering and
selection, a 100 ms gap during scrolling, and Playwright's default 5 s expect
timeout for visibility waits. Selection is timed in the page from pointerdown
to the `data-selected-path` commit, and filtering is timed from Node, from
`fill` until the matching tree item is visible; on 2026-09-15 an Apple M2 Pro
at load1 3.4 to 4.3 measured worst selections of 23 to 31 ms and worst filters
of 20 to 54 ms. When `CI` is set to anything non-empty, the same proof allows
400 ms, 600 ms, 200 ms, and a 15 s expect timeout. Those numbers date from
2026-09-02, when the `macos-14` runner measured 205 to 302 ms for selection
timed from Node across Playwright's click retries; that figure is not
comparable with the in-page number, and the CI budget stays until a `CI=1` run
records in-page numbers. Set `CI=1` when running the
browser suite as the merge gate so the wider budget applies, as the `CI=1`
line above does.

`pnpm lint:changed` also checks formatting, which is why it stays beside the
repo-wide `pnpm lint`: one covers the shape of the changed files, the other
covers every finding in the tree. The pull request workflow, when it ran,
did not run package smoke or release operations either.

## Release

A release is one tag. You prepare the version on a branch, land the release
commit through a pull request, and push the tag on the merged commit; the
`Release` workflow then runs the checks, builds the package, and opens a
draft GitHub release for you to read before anyone can install it. Nothing
is published without a person publishing it. The `Pull request gates`
workflow stays paused (see above); only `Release` runs in CI, since
2026-09-30.

1. Branch `chore/release-<version>` from `origin/main` with a clean working
   tree: `git fetch origin && git switch -c chore/release-0.2.0 origin/main`.
   Every change to `main` goes through a pull request, releases included.

2. Prepare the version:

   ```bash
   pnpm release:prepare 0.2.0
   ```

   It refuses to run when the working tree is dirty or when the tag already
   exists. Otherwise it sets `version` in `package.json`, renames the
   changelog's `## Unreleased` heading to `## 0.2.0 - <today's date>`, opens a
   fresh empty `## Unreleased` above it, and prints the commands in the next
   step. It never commits, tags, or pushes: the diff is meant to be read
   first.

3. Read the diff, commit, push the branch, and land the pull request with a
   rebase merge. The repository allows only rebase merges, and GitHub's
   rebase merge rewrites the commit SHA, so the tag goes on the merged
   commit, not the branch commit:

   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore: release 0.2.0"
   git push -u origin chore/release-0.2.0
   gh pr create
   gh pr merge <number> --rebase --delete-branch
   git switch main && git pull --ff-only
   git tag v0.2.0
   git push origin v0.2.0
   ```

   Pushing the tag starts the `Release` workflow.

4. The `Release` workflow (`.github/workflows/release.yml`) runs on
   `macos-14` when the tag is pushed. Watch it with `gh run watch`. If it
   cannot run, the maintainer runs the same steps locally instead, in this
   order:

   ```bash
   pnpm --silent release:notes 0.2.0 > release-notes.md
   pnpm lint
   pnpm typecheck
   pnpm test:all
   pnpm package:mac
   pnpm test:package-smoke
   gh release create v0.2.0 --draft --title v0.2.0 --notes-file release-notes.md release/Patchdesk-0.2.0-arm64.dmg release/Patchdesk-0.2.0-arm64-mac.zip
   ```

   `pnpm release:notes` extracts the `## <version>` section of
   `CHANGELOG.md`, so what the release page says is the entry reviewed in
   step 3 rather than a generated list of commit subjects. `pnpm lint`,
   `pnpm typecheck`, and `pnpm test:all` repeat here because a tag can land
   on a commit that never went through the gates, so the release checks the
   exact tree it is about to ship before `pnpm package:mac` builds it and
   `pnpm test:package-smoke` checks the built app. `gh release create` then
   opens a **draft** GitHub release with the `.dmg` and the `.zip` attached.
   `release-notes.md` is a scratch file that `.gitignore` does not list;
   delete it after the draft is created rather than adding an ignore rule
   for it. `release/` is not cleaned between builds, so older versions'
   downloads sit beside the new ones and a glob would attach them all.

5. Open the draft release, read the notes, and publish.

6. Once the release is published, update the Homebrew tap. Homebrew fetches
   the `.dmg` from the published release URL, so a draft release cannot be
   installed; `pnpm release:cask` refuses a draft for that reason.

   ```bash
   pnpm release:cask 0.2.0
   ```

   It finds the tap checkout through `brew --repository kwanpham2195/patchdesk`
   (or `PATCHDESK_TAP_DIR`), refuses when that tree is dirty, when release
   `v0.2.0` is missing or still a draft, or when
   `release/Patchdesk-0.2.0-arm64.dmg` has not been built, and otherwise sets
   `version` and `sha256` in `Casks/patchdesk.rb` from that `.dmg`. Like
   `release:prepare`, it never commits or pushes. Read the diff in the tap,
   then run the commands it prints there:

   ```bash
   git add Casks/patchdesk.rb
   git commit -m "Bump patchdesk to 0.2.0"
   git push origin main
   brew update && brew audit --cask kwanpham2195/patchdesk/patchdesk && brew upgrade --cask patchdesk
   ```

   The cask also links the MCP launcher onto `PATH`, and keeps this line
   across bumps (ADR 0052):

   ```ruby
   binary "#{appdir}/Patchdesk.app/Contents/Resources/bin/patchdesk"
   ```

   A `.dmg` install gets the same command with
   `ln -s /Applications/Patchdesk.app/Contents/Resources/bin/patchdesk /usr/local/bin/patchdesk`.

Changing the supported external Pi CLI integration follows `docs/upgrading-pi.md`.

### Signing and notarization

The release build signs with an Apple Developer ID and notarizes when these
repository secrets are set, and builds unsigned when they are not:

- `CSC_LINK`: the Developer ID Application certificate as a base64 `.p12`;
- `CSC_KEY_PASSWORD`: that certificate's password;
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`: the Apple
  account notarization submits under.

`CSC_LINK` alone decides whether the app is signed. With it and the three
`APPLE_` secrets, the download opens on any Mac with a double-click. With
`CSC_LINK` but no `APPLE_` secrets, the app is signed but not notarized. With
none of them the build still succeeds and produces an unsigned app. It needs
the terminal command in `README.md`, "Install", before first launch. Mention
this when handing the app to someone.

The build without a Developer ID certificate receives an ad-hoc signature.
The `afterPack` hook in `scripts/sign-mac-adhoc.mjs` runs
`codesign --force --deep --sign -` over the finished bundle before building
the `.dmg` and `.zip`. Without this signature, Electron's linker signature
covers only the executable, not the resources. Then
`codesign --verify --deep --strict` fails and macOS rejects the download with
"Patchdesk.app is damaged and can't be opened." An ad-hoc signature does not
identify who built the app or satisfy Gatekeeper. It keeps the bundle's seal
intact so the app can run after the user clears its quarantine flag with
`xattr -cr`, as described in `README.md`. When `CSC_LINK` is set, this hook
does not run. Electron-builder signs and notarizes the app. The package smoke
test checks the seal and reports its type.

Before it signs, the same hook sets Electron fuses on the app binary: it turns
off `NODE_OPTIONS` and the `--inspect` arguments, and makes the app load only
from an `app.asar` whose hash matches `Info.plist`. `RunAsNode` stays on,
because the `patchdesk` CLI and the Pi explanation helper run the binary as Node.
To check a build:

```bash
npx @electron/fuses read --app release/mac-arm64/Patchdesk.app
```

A secret that was never configured reaches the build as an empty string, not
as an absent variable, and electron-builder reads an empty `CSC_LINK` as "sign
with this". `scripts/package-mac-lib.mjs` drops empty values first, which is
why an unconfigured secret means unsigned rather than a failed build. It is
also where the unsigned build turns signing off with
`CSC_IDENTITY_AUTO_DISCOVERY=false`. The previous `"identity": null` setting in
`package.json` disabled signing for every build, including builds with a
certificate.

### Building a package by hand

Package only when asked, when the change is packaging-specific, or when
distribution proof is required. A packaged app is evidence only for the commit
it was built from. A build from yesterday says nothing about the current tree.

Build a macOS package, then smoke-test it:

```bash
pnpm package:mac
pnpm test:package-smoke
```

`pnpm package:mac` builds the app and packages the Pi explanation helper and
MCP shim. It does not stage an API-key Insight runtime. Package smoke validates
the packaged launchers, startup, UI, and size ceilings, and reads the expected
version out of `package.json`. It does not prove live native generation.

`pnpm package:mac` produces `release/mac-arm64/Patchdesk.app`, the unpacked
app `pnpm test:package-smoke` reads. The downloads are
`release/Patchdesk-<version>-arm64.dmg` and
`release/Patchdesk-<version>-arm64-mac.zip`. Both downloads sit
directly in `release/`, not in `release/mac-arm64/`. Hand off the `.dmg` to
another person. The `.blockmap` sidecar beside the zip is not part of the
handoff.

A local build is never signed: it takes the same path the release build takes
with no secrets set.

### Installing a package by hand

`pnpm install:mac` builds and installs the app on this Mac: it runs
`pnpm package:mac`, copies `release/mac-arm64/Patchdesk.app` into `/Applications`, registers it
with Launch Services, prints the installed version, and opens it. To install
a build you already have without packaging again, run the install step alone:

```bash
pnpm install:mac
node scripts/install-mac.mjs            # install the existing build
node scripts/install-mac.mjs --no-open  # install it without opening it
```

Set `PATCHDESK_INSTALL_DIR` to another existing absolute folder, for example
`PATCHDESK_INSTALL_DIR=~/Applications` when `/Applications` is not writable.
If Patchdesk is running from that folder, the script asks it to quit and waits
up to 20 seconds; if it is still running, the script stops without copying
anything. The first time it does this, macOS asks whether your terminal may
control Patchdesk; if you decline, quit Patchdesk yourself and run again. Copies running from anywhere else, such as the dev app or
`release/`, are left alone. The new app is copied into a hidden sibling first
and swapped in by rename, so a failed install leaves the previous app in
place.

A local build carries no quarantine flag, so it needs no `xattr` step. The
install replaces a Homebrew-cask install in place, and the next
`brew upgrade --cask patchdesk` that finds a newer release overwrites it.

## Pull requests

Every change goes through a PR, including copy and instructions.
Base branch: `main`. Keep PRs focused on one logical change. User-visible
behavior changes must update the relevant docs; architectural decisions go
through an ADR in `docs/adr/`.
