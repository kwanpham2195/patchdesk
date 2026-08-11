# Repository Guidelines

## Project Structure

Patchdesk is a local-first Electron workbench for pull-request review. `src/domain/` holds types and invariants, `src/services/` orchestration, and `src/adapters/` I/O. Electron code is in `src/main/`; React is in `src/renderer/src/`. Executable Flue workflow entries belong in `src/workflows/`.

Tests mirror those boundaries under `tests/`. Browser coverage is in `tests/browser/`; renderer tests are in `tests/renderer/`. Shared fixtures live in `fixtures/flue/` and `fixtures/github/`; assets are in `resources/`.

## Development and Verification

Use pnpm 8.8.0. Run development in a Herdr tab with `pnpm dev`.

Before starting any task, make sure the dev log tails are live in herdr:

- Log tail tab: raw `patchdesk.jsonl` (tail of `~/.local/share/patchdesk/logs/patchdesk.jsonl`).
- Dev tab: the `pnpm dev` console (renderer/api log lines and HMR output).
- If either pane is gone or idle, start/restart it before doing the work.
- Main-process code changes (e.g. `src/main/`, `src/services/`, adapters) need a full dev-app restart: renderer hot-reloads but the main process keeps the old code. A stale main process shows as repeated `400 invalid_input` on `/v1/reviews/detect-updates` (old route schema vs new typed journal). Restart via the herdr dev tab (Ctrl-C, then `pnpm dev -- --remote-debugging-port=9233`).

Verification commands:

- `pnpm lint`: ESLint with no warnings.
- `pnpm typecheck`: TypeScript checks.
- `pnpm test -- --run`: Vitest unit and integration suite.
- `pnpm build`: builds the main process, preload, and renderer.
- `pnpm exec playwright test`: browser tests.

For desktop or renderer changes, run those commands in that order. Package and smoke-test only when package-specific proof is requested.

For live verification of the running app, use the `patchdesk-electron-tester` skill (agent-browser over CDP 9233) — never substitute a build, unit test, or static inspection for live app checks, and keep live checks read-only.

## Code and Testing Conventions

Write strict TypeScript. Avoid `any`, `// @ts-` suppressions, and string casts for domain IDs; use the parsers in `src/domain/ids.ts`. Use Prettier double quotes and trailing commas. Name React components PascalCase and hooks `use-*.ts`.

The renderer uses shadcn/ui components on Base UI. Use `$shadcn` for UI component work. Reuse installed components and their variants before creating custom markup or styles.

Add regression tests for bugs when practical. Keep fixtures only when active production seams consume them. Do not loosen performance assertions for a slow local run.

## Architecture and Safety

- Keep the renderer sandboxed: do not weaken Electron’s Node isolation or web security.
- The loopback API requires its per-launch capability. GitHub writes require explicit UI confirmation, except the exact Review publication batch may use the immutable per-Analysis-run authorization defined by the approved product contract. Merge, Published feedback deletion or dismissal, and writes outside that authorized batch always require explicit confirmation.
- Do not persist credentials in profiles.
- Provider support uses built-in environment API-key or ambient machine-credential providers, plus the Codex CLI account provider defined by ADR-0016; exclude all other OAuth-only providers and Cloudflare Workers bindings from selectable catalogs. Keep availability checks main-process-only and redacted; never probe providers, read a full environment, execute custom-provider configuration, or expose/persist credential values. Keep Flue beta.9 pinned; plan a Flue 2 migration separately.
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
