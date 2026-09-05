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
- The isolated insight runtime (`runtime/insight/`) has an exact lock and is
  validated during package smoke.

## Codebase map

- `src/domain/` — types and invariants.
- `src/services/` — orchestration.
- `src/adapters/` — I/O (GitHub, storage, providers).
- `src/main/` — Electron main process; `src/renderer/src/` — React.
- `runtime/insight/` — the isolated insight runtime. It builds one Pi agent per
  Insight run (ADR 0041).
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

`pnpm install` runs the root `prepare` script, which installs and builds
`runtime/insight`'s dependencies — the isolated runtime the Insight feature
needs. `pnpm dev` builds that runtime again before starting electron-vite, so
Insight works with no extra step even if the runtime is stale.

If you ran `pnpm install --ignore-scripts`, `prepare` did not run and the
runtime is missing; recover with:

```bash
pnpm --dir runtime/insight install
pnpm --dir runtime/insight build
```

**Fast checks.**

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
```

Use `pnpm test -- --run <file>` for focused root-suite development. The complete pre-push test gate is `pnpm test:all`; it runs the root suite and the separate `runtime/insight` suite.

The inner loop is that focused test file, not the whole project. `pnpm typecheck`
builds a program over `src` and `tests` every time it runs, so run it when a
slice is done rather than after each edit; a syntax error in the file you are
editing is quicker to find by reading the file than by compiling the
repository. `pnpm check` is the one command to run before handing work over.

## Where a test belongs

`AGENTS.md` ("Testing") holds the rules for which layer a test goes in, and
they are not advisory: test at the lowest layer that can observe the behaviour.
Domain and services get a test per behaviour, written before the fix. A hook
that owns timing, generations, optimistic state, or a request payload gets a
`renderHook` test with a fake bridge, never a mounted component. Components get
one smoke test per screen plus the keyboard and focus tests that need a DOM,
queried by role or label — if a component computes something worth asserting,
export the function and test the function. `tests/browser/` is for end-to-end
journeys and for what only a real browser shows, never for a behaviour an RTL
or hook test already proves. There is no assistive-technology lane (ADR 0034):
no axe scans, no screen-reader narration checks, no forced-colors or
reduced-motion checks. Use the shared doubles rather than hand-rolling one.

`tests/browser/` has no accepted-failure list, and it is not getting one: the
pull request gates run the suite on every change to `main`. A browser spec that
fails on `main` is fixed or deleted in the same change that finds it.

## Making changes

Branch from `main` using `<type>/<slug>` with types
`feat`, `fix`, `chore`, `refactor`, `test`, `docs`, `ci`, `perf`.

Commit with a lowercase imperative summary, no trailing period:
`<type>(<scope>): <summary>` (example: `fix(storage): quarantine corrupt review records`).
One logical unit per commit. Do not add AI or co-authored trailers.

## The commit gate

Commits run `pnpm precommit`:

1. `pnpm lint:staged` checks every staged JavaScript and TypeScript file with
   Oxfmt, then Oxlint with denied warnings, and applies the file-size ratchet
   to them.
2. React Doctor scans staged files and remains blocking, unless it cannot read
   the tree it would scan (below).

Meet that gate when a slice is done, not when you go to commit.
`pnpm gate:preflight <paths>` runs the same three checks — the Oxfmt check,
Oxlint with denied warnings, and the size ratchet — over the paths you name,
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
skipped and says so — nothing was scanned, and that is not a pass. When
`package.json` differs and renderer files are staged, the commit fails: the one
scan that mattered is the one that could not run, so restore or stage
`package.json` and retry. Otherwise React Doctor runs as before.

Invoke repo tools through `pnpm exec`. A global `oxfmt` or `oxlint` on `PATH`
may be a different version, and a different version disagrees with the gate:
it rejects files this repository formats correctly, and reformatting to satisfy
it breaks the repository check instead.

The repo-wide Oxlint count ratchet does not run here. It runs once, inside
`pnpm lint:changed` (see "The count ratchet" and "Verifying before
pushing"), which is the shape CI enforces.

Pushes run `pnpm prepush`: `pnpm typecheck`, `pnpm typecheck:scripts`,
`pnpm check:error-ui`, then `pnpm knip:ratchet`. This is where the
whole-project ratchets live locally, because a push is where the whole branch
becomes the unit rather than one commit. `git push --no-verify` skips it, and
CI runs the same checks again on the pull request.

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
`pnpm lint` guards the findings; the ratchet guards the rules.

This claim was tested rather than assumed, both directions: three anti-slop
rules switched off and `.oxlintrc.json` staged alone is **rejected** by
`pnpm lint:changed`, and the same edit staged together with an updated
`lint-baseline.json` is **accepted**. An earlier form of the gate asked
`git ls-files --stage` / `git ls-tree` whether the baseline was present, which
reports a tracked file unconditionally — so it answered "yes" for every change
and the gate never fired. `tests/scripts/` now covers both directions.

Oxlint reads the whole working tree, uncommitted edits included. If unstaged
work moved the number, commit or set that work aside rather than moving the
baseline to match it.

The Knip ratchet (`pnpm knip:ratchet`, baseline `knip-baseline.json`) works
the same way. It is not part of `pnpm precommit`: Knip answers a whole-project
reachability question, so an ordinary mid-refactor commit moves its count for
a reason that has nothing wrong with it, and a gate that rejects that commit
gets switched off. It runs in `pnpm prepush`, in `pnpm check`, and in the pull
request gates.

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
and so does a drop nobody records. It runs in `pnpm prepush`, in `pnpm check`,
and in the pull request gates, not in `pnpm precommit` — it builds a whole
`tsc` program and answers a repository-wide question, not one about the staged
files.

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

`*.generated.ts` is exempt — a generator decides that size, not a reviewer.

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
exemption needs two things at once — nothing outside the import declarations
may gain a line, and at least one specifier must have been added — so a
comment, a blank line between specifiers, or a body statement cannot ride
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

`pnpm check` is the pre-handoff command: it runs `pnpm typecheck`,
`pnpm typecheck:scripts`, `pnpm check:error-ui`, `pnpm test:all`,
`pnpm lint:staged` (checks what you will commit),
`pnpm lint:changed -- origin/main` (checks the whole branch the way the pull
request gates will), then `pnpm knip:ratchet`, in that order, and stops at the
first failure. `pnpm check:error-ui` scans the renderer for a literal
`role="alert"` outside the three primitives that own one (`alert.tsx`,
`field.tsx`, `inline-error.tsx`), so error surfaces stay in those components.
`pnpm lint:staged` reports "no staged source files" when nothing is staged.
The repo-wide count ratchet runs once, inside
`pnpm lint:changed`, which is the shape CI enforces.

`pnpm check` runs both shapes of the changed-source gate on purpose. The
staged shape measures one commit's worth of change against `HEAD`; the branch
shape measures every file the branch has touched since it left `origin/main`,
so a file that stopped formatting cleanly, or grew past the size ceiling,
twenty commits ago is caught before CI finds it.

`pnpm lint:changed` takes its head two ways. With a base and a head it is that
commit pair, which is what CI passes. **With a base alone it reads the index
as head**, from `git merge-base <base> HEAD`, so `pnpm check` reports on the
work in hand rather than only on what is already committed — otherwise the
last command before a handoff would answer about the tree before the fix.
`origin/main` is the pull request's base branch, so a stale remote-tracking
ref checks a stale range: `git fetch` first.

Beyond `pnpm check`:

- `pnpm knip` prints the unused files, exports, and dependencies behind the
  Knip ratchet's number. `pnpm check` runs the ratchet; run `pnpm knip` when
  you need to see which entries make it up.
- For desktop or renderer changes: `pnpm build`, then the focused browser
  suite (`pnpm test:e2e` or `pnpm test:performance`).
- `pnpm cdp:ready` says whether the dev app is reachable over CDP, on
  `REMOTE_DEBUGGING_PORT` or on 9233 when that is unset. Live verification of
  the running app starts there; it prints how to start the app when the port
  is down.

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
- `pnpm test:all`, including the root suite and separate `runtime/insight` suite;
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
timeout for visibility waits. When `CI` is set to anything non-empty, the same
proof allows 400 ms, 600 ms, 200 ms, and a 15 s expect timeout. The two sets
differ because on 2026-09-02 the `macos-14` runner measured 205 to 302 ms
against the 200 ms ceiling with code that passed at 70 to 121 ms locally; about
double the local numbers still fails a regression of the size that matters
while leaving the local budget where it is. Set `CI=1` when running the
browser suite as the merge gate so the wider budget applies, as the `CI=1`
line above does.

`pnpm lint:changed` also checks formatting, which is why it stays beside the
repo-wide `pnpm lint`: one covers the shape of the changed files, the other
covers every finding in the tree. The pull request workflow, when it ran,
did not run package smoke or release operations either.

## Release

A release is one tag. You prepare the version locally, push the tag, and,
since the `Release` workflow is paused as of 2026-09-03, run the same build
and checks locally, ending with a draft GitHub release for you to read
before anyone can install it. Nothing is published without a person
publishing it.

1. Start on `main` with a clean working tree, up to date with `origin`.

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

3. Read the diff, then commit, tag, and push:

   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore: release 0.2.0"
   git tag v0.2.0
   git push origin main v0.2.0
   ```

4. The `Release` workflow (`.github/workflows/release.yml`) would normally
   run on `macos-14` when the tag is pushed; while it is paused, the
   maintainer runs the same steps locally instead, in this order:

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

Bumping the bundled Pi client follows `docs/upgrading-pi.md`.

### Signing and notarization

The release build signs with an Apple Developer ID and notarizes when these
repository secrets are set, and builds unsigned when they are not:

- `CSC_LINK` — the Developer ID Application certificate as a base64 `.p12`;
- `CSC_KEY_PASSWORD` — that certificate's password;
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — the Apple
  account notarization submits under.

`CSC_LINK` alone decides whether the app is signed. With it and the three
`APPLE_` secrets, the download opens on any Mac with a double-click. With
`CSC_LINK` but no `APPLE_` secrets, the app is signed but not notarized. With
none of them the build still succeeds and produces the unsigned app this
project has always shipped, which needs one terminal command before first
launch (see `README.md`, "Install") — say so when you hand it to someone.

The unsigned build is still signed, just anonymously: the `afterPack` hook in
`scripts/sign-mac-adhoc.mjs` runs `codesign --force --deep --sign -` over the
finished bundle before the `.dmg` and `.zip` are built. Without it the app
keeps the signature Electron's binary was linker-signed with, which covers the
executable alone and seals no resources, so `codesign --verify --deep --strict`
fails and macOS rejects a downloaded copy as "Patchdesk.app is damaged and
can't be opened" — a dialog with no way past it. An ad-hoc seal proves
nothing about who built the app and does not get past Gatekeeper, which
still reports the download as damaged; what it does is keep the seal intact
so the app runs once the person clears the quarantine flag with `xattr -cr`,
which `README.md` documents as the install step. The hook stands down
whenever `CSC_LINK` is set: electron-builder
signs and notarizes that build itself, and an anonymous signature has nothing
to add to a real one. `pnpm test:package-smoke` checks the seal and prints
which kind it is.

A secret that was never configured reaches the build as an empty string, not
as an absent variable, and electron-builder reads an empty `CSC_LINK` as "sign
with this". `scripts/package-mac-lib.mjs` drops empty values first, which is
why an unconfigured secret means unsigned rather than a failed build. It is
also where the unsigned build turns signing off, with
`CSC_IDENTITY_AUTO_DISCOVERY=false` rather than the `"identity": null` that
used to sit in `package.json` — that setting disabled signing for every build,
including one that had a certificate.

### Building a package by hand

Package only when asked, when the change is packaging-specific, or when
distribution proof is required. It takes minutes, and a packaged app is
evidence only for the commit it was built from — a build from yesterday says
nothing about the tree in front of you.

Build a macOS package, then smoke-test it:

```bash
pnpm package:mac
pnpm test:package-smoke
```

`pnpm package:mac` runs `pnpm stage:insight-runtime` as part of the build,
which builds and stages the exact isolated insight runtime into the package.
Package smoke runs fixed faux Analysis and Walkthrough fixtures before UI
checks, validates size ceilings for the packaged app and downloads, and reads
the expected version out of `package.json`.

`pnpm package:mac` produces `release/mac-arm64/Patchdesk.app` (the unpacked
app `pnpm test:package-smoke` reads, 278.26 MiB allocated). Its
`Contents/Resources/app.asar` is 25.54 MiB and its
`Contents/Resources/insight-runtime` is 22.74 MiB allocated. The downloads are
`release/Patchdesk-0.0.1-arm64.dmg` (110.66 MiB) and
`release/Patchdesk-0.0.1-arm64-mac.zip` (113.38 MiB) — both sit directly in
`release/`, not in `release/mac-arm64/`. The `.dmg` is the one to hand to
another person; a `.blockmap` sidecar is written next to the zip and is not
part of the handoff.

A local build is never signed: it takes the same path the release build takes
with no secrets set.

## Pull requests

Base branch: `main`. Keep PRs focused on one logical change. User-visible
behavior changes must update the relevant docs; architectural decisions go
through an ADR in `docs/adr/`.
