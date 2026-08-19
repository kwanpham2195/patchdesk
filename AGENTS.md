# Repository Guidelines

## Project Structure

Patchdesk is a local-first Electron workbench for pull-request review. `src/domain/` holds types and invariants, `src/services/` orchestration, `src/adapters/` I/O. Electron code is in `src/main/`; React is in `src/renderer/src/`. Pi Insights run in the isolated `runtime/flue/` Flue 2 one-shot child; Patchdesk remains the lifecycle, validation, and GitHub authority. Tests mirror those boundaries under `tests/`; browser coverage is in `tests/browser/`, renderer tests in `tests/renderer/`. See `CONTRIBUTING.md` (codebase map) and `docs/architecture.md` (layers) for the full picture.

## Development and Verification

Before starting any task, make sure the dev log tails are live in herdr:

- Log tail tab: raw `patchdesk.jsonl` (tail of `~/.local/share/patchdesk/logs/patchdesk.jsonl`).
- Dev tab: the `pnpm dev` console (renderer/api log lines and HMR output).
- If either pane is gone or idle, start/restart it before doing the work.
- Main-process code changes (e.g. `src/main/`, `src/services/`, adapters) need a full dev-app restart: renderer hot-reloads but the main process keeps the old code. A stale main process shows as repeated `400 invalid_input` on `/v1/reviews/detect-updates` (old route schema vs new typed journal). Restart via the herdr dev tab (Ctrl-C, then `pnpm dev -- --remote-debugging-port=9233`).

Verification commands live in `CONTRIBUTING.md`. For desktop or renderer changes run the full gate in order (typecheck, tests, build, browser checks); package and smoke-test only when package-specific proof is requested.

The pre-commit hook (`pnpm precommit`) runs a blocking React Doctor scan on staged files, then `pnpm lint:staged` (oxlint --fix over staged files). If it blocks, fix the reported finding; do not disable or retune rules to make the commit pass. Anti-slop rules are not auto-fixable: fix the file's findings, then re-stage. `doctor.config.json` ignores the vendored plugin and installed skills from the React Doctor scan.

For live verification of the running app, use the `patchdesk-electron-tester` skill (agent-browser over CDP 9233) — never substitute a build, unit test, or static inspection for live app checks, and keep live checks read-only.

## Anti-slop migration

Vendored at `tools/oxlint/anti-slop/` (15 rules; `@oxlint/plugins` devDep), enabled at "error" in `.oxlintrc.json`. Migration plan and rule-by-rule progress: `.agents/PLANS/2026-08-16-anti-slop-migration.md`. Reinstall/update from the bundled skill at `.agents/skills/install-anti-slop/` (upstream dmmulroy/anti-slop).

Policy: fix findings honestly; never launder types to pass lint (no `as unknown` tricks, no faked SAFETY comments, no severity weakening). Genuine I/O boundaries keep `unknown` via targeted per-file overrides in `.oxlintrc.json` with a comment stating the boundary contract. Prefer `satisfies`, inference, and boundary parsing when resolving findings.

## Code and Testing Conventions

Write strict TypeScript. Avoid `any`, `// @ts-` suppressions, and string casts for domain IDs; use the parsers in `src/domain/ids.ts`. Use Oxfmt with double quotes and trailing commas. Name React components PascalCase and hooks `use-*.ts`.

The renderer uses shadcn/ui components on Base UI. Use `$shadcn` for UI component work. Reuse installed components and their variants before creating custom markup or styles.

Add regression tests for bugs when practical. Keep fixtures only when active production seams consume them. Do not loosen performance assertions for a slow local run.

## Implementation Principles

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## Architecture and Safety

The safety statement in `README.md` describes the sandbox and write-authority model. Agent rules on top of it:

- The loopback API requires its per-launch capability. GitHub writes require an explicit current UI action. Merge and Published feedback deletion or dismissal require explicit confirmation.
- Provider support uses built-in environment API-key or ambient machine-credential providers, plus the Codex CLI account provider defined by the ADR "Use the local Codex CLI account"; exclude all other OAuth-only providers and Cloudflare Workers bindings from selectable catalogs. Codex may use verified sandboxed read-only inspection tools only in Patchdesk's immutable represented-review worktree; deny writes, file changes, network/permission escalation, and unverified requests. Keep availability checks main-process-only and redacted; never probe providers, read a full environment, execute custom-provider configuration, or expose/persist credential values. Flue 2 runs only as a Patchdesk-owned one-shot child with no sandbox, MCP, subagents, filesystem tools, or GitHub authority.
- Cleanup may remove only non-running review sessions.

## Memory

- Read `brain/index.md` before Patchdesk work.
- Put stand-alone research notes in `.agents/research/`. Use `.agents/tasks/`
  for task packages whose specification and design come first, and
  `.agents/PLANS/` only for long-running execution plans.
- A completed task package is closed reference material. Do not add research,
  plans, or implementation artifacts to it; route follow-up work using the
  locations above.
- For Pierre or Flue integration research, use `$librarian` for upstream sources.
- Do not use broad Git cleanup commands such as `git clean` or `git reset --hard`.
- Backward compatibility requires a user request.
- Use `$patchdesk-review-lifecycle` for Review, refresh, Insight, draft, publication, recovery, retry, Walkthrough, or merge lifecycle changes.
