# Plan 003: Correct the write-safety and development-runtime documentation

> **Executor instructions**: Follow this plan step by step. This is a small
> documentation correction, not an authorization redesign. Confirm every claim
> against current code and active ADRs. If a STOP condition occurs, stop and
> report. When done, update this plan's row in `plans/README.md` unless a
> reviewer maintains the index.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 7b4f6e6..HEAD -- README.md package.json AGENTS.md \
>   docs/adr/0014-use-github-pending-reviews-for-review-drafting.md \
>   docs/adr/0015-authorize-finding-review-commands-from-analysis.md
> git diff --stat -- README.md package.json AGENTS.md
> git diff --cached --stat -- README.md package.json AGENTS.md
> ```
>
> `package.json` and `AGENTS.md` already contain unrelated React Doctor and
> implementation-principle edits. Preserve them. If current write behavior or
> supported runtime differs from **Current state**, STOP before documenting it.

## Status

- **Priority**: P1 — quick correction of the primary safety statement
- **Effort**: S
- **Risk**: LOW
- **Depends on**: Plans 001-002
- **Category**: docs / dx / safety
- **Planned at**: commit `7b4f6e6`, 2026-08-13

## Why this matters

The README says every GitHub write requires explicit confirmation, but the
active product also has explicit Finding commands and historical Analysis
publication code with different authorization wording. The development section
lists only a subset of the verification and packaging commands and gives no
supported Node runtime.

A maintainer should be able to read one concise current safety statement and
reproduce the expected local gates. Correcting these docs is cheap and prevents
future plans from reasoning from a false contract.

## Current state

`README.md` currently says:

```text
GitHub reviews, comments, merges, and other writes always require an explicit
confirmation.
```

The active current decisions are more precise:

- ADR-0014: GitHub pending review is the sole editable draft; each write has an
  explicit maintainer action and durable intent/receipt recovery.
- ADR-0015: **Add to review** is one explicit Finding command per GitHub write;
  it never runs automatically when Analysis finishes.
- `AGENTS.md`: writes require explicit UI confirmation except an immutable
  per-Analysis-run authorization. Live transport and renderer inspection show
  that exception is unreachable, but only Plan 005 has approval to change the
  hard rule and delete its dormant machinery. Until then README must either
  name the dormant documented exception narrowly or avoid a universal claim;
  this docs plan must not change architecture.

`package.json` defines these supported gates beyond the README's current list:

```text
pnpm build
pnpm test:e2e
pnpm test:a11y
pnpm test:performance
pnpm package:mac
pnpm test:package-smoke
```

The repository pins pnpm 8.8.0. The current direct Node types are Node 24 and
the packaged Electron in Plan 006 must meet Flue's selected Node floor. Before
Plan 006, document the runtime actually used and proven by the current package,
not an unverified future requirement.

## Commands you will need

- Inspect current versions: `node --version`, `pnpm --version`
- Verify commands exist:
  `node -e 'const p=require("./package.json"); console.log(p.scripts)'`
- Markdown whitespace: `git diff --check -- README.md`
- Standard check: `pnpm lint`

## Scope

**In scope**

- `README.md`
- `plans/README.md` status only

**Out of scope**

- `AGENTS.md` hard-rule changes
- ADR edits or authorization implementation
- Dependency/version changes
- Running live GitHub writes
- Flue 2 migration details not yet implemented
- A full contributor guide

## Git workflow

- Preserve all dirty source and config changes.
- Stage `README.md` explicitly if asked to commit.
- If asked to commit, use `docs: clarify safety and development gates`.

## Steps

### Step 1: Write the exact current safety statement

Update README's safety section to state:

- renderer isolation and capability-gated loopback API remain;
- Patchdesk does not persist GitHub credentials or expose a renderer shell;
- normal GitHub writes happen only from a named maintainer action;
- Finding **Add to review** is itself that explicit one-write action and never
  runs automatically after Analysis;
- uncertain writes remain locked for explicit reconciliation and are not
  retried automatically;
- name the documented immutable per-Analysis publication exception narrowly as
  currently unreachable/deprecated pending Plan 005, rather than claiming the
  hard-rule exception has already been removed.

Do not describe obsolete local `ReviewBatch` as current. Do not promise that
Plan 005's future deletion has already landed.

**Verify**:

```bash
rg -n 'explicit|Finding|reconcil|retry|authorization' README.md
```

Expected: the safety section is consistent with ADR-0014, ADR-0015, and live
code; no broad “always” claim contradicts an implemented exception.

### Step 2: Document the supported command ladder

Expand Development with short groups:

- install and runtime prerequisites;
- fast checks: lint, typecheck, Vitest;
- desktop/renderer gate: build then Playwright;
- focused accessibility/performance commands;
- packaging and package smoke for release work;
- `pnpm dev` for local work.

Record pnpm 8.8.0 from `packageManager`. Record a Node version or floor only
after verifying it against the current Electron/package runtime and current
Flue beta dependency. If no tracked Node contract exists yet, say that Node 24
is the currently verified development line and that Plan 006 will establish the
Flue 2 floor; do not add `engines` in this docs-only plan.

Keep README concise. Link to `AGENTS.md` for the ordered full gate rather than
copying operational detail.

**Verify**:

```bash
node --version
pnpm --version
node -e 'const p=require("./package.json"); for (const n of ["lint","typecheck","test","build","test:e2e","test:a11y","test:performance","package:mac","test:package-smoke","dev"]) if (!p.scripts[n]) process.exit(1)'
```

Expected: commands exit 0 and every documented script exists.

### Step 3: Check documentation hygiene

```bash
pnpm lint
git diff --check -- README.md
git --no-pager diff --color=never -- README.md
```

Expected: lint exits 0, whitespace check is clean, and the diff contains only
current safety/runtime documentation.

## Test plan

No product test is needed. Verification is claim-based:

- Every named script exists in `package.json`.
- pnpm version matches the package-manager pin.
- Safety wording matches active ADR-0014 and ADR-0015 and does not hide the
  stale documented authorization exception before Plan 005 removes it.
- No future Plan 005 or Plan 006 state is written in the present tense.

## Done criteria

- [x] README no longer contains an inaccurate universal write-safety claim.
- [x] Explicit Finding commands and uncertain-write reconciliation are clear.
- [x] Current runtime and command ladder are documented without guessing future
      Flue 2 state.
- [x] All documented scripts exist.
- [x] `pnpm lint` passes.
- [x] `git diff --check -- README.md` has no output.
- [x] Only README and the plan status row changed for this plan.
- [x] `plans/README.md` marks Plan 003 DONE.

## STOP conditions

Stop and report if:

- Live code changes make the immutable Analysis publication path reachable
  again or contradict the adjudicated dormant state.
- Runtime inspection does not support a concrete Node statement.
- Correct documentation would require changing `AGENTS.md` or an ADR contract.
- A script named in this plan no longer exists.

## Maintenance notes

Update this section again when Plan 005 deletes superseded authority or Plan 006
changes the Node floor and packaged runtime. Documentation must describe shipped
behavior, not planned behavior.
