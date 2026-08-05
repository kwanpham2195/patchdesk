# Repository Guidelines

## Project Structure

Patchdesk is a local-first Electron workbench for pull-request review. `src/domain/` holds types and invariants, `src/services/` orchestration, and `src/adapters/` I/O. Electron code is in `src/main/`; React is in `src/renderer/src/`. Executable Flue workflow entries belong in `src/workflows/`.

Tests mirror those boundaries under `tests/`. Browser coverage is in `tests/browser/`; renderer tests are in `tests/renderer/`. Shared fixtures live in `fixtures/flue/` and `fixtures/github/`; assets are in `resources/`.

## Development and Verification

Use pnpm 8.8.0. Run development in a tmux pane with `pnpm dev`. Design app: `pnpm dev:design`.

- `pnpm lint`: ESLint with no warnings.
- `pnpm typecheck`: TypeScript checks.
- `pnpm test -- --run`: Vitest unit and integration suite.
- `pnpm build`: builds the main process, preload, and renderer.
- `pnpm exec playwright test`: browser tests.

For desktop or renderer changes, run those commands in that order. Package and smoke-test only when package-specific proof is requested.

## Code and Testing Conventions

Write strict TypeScript. Avoid `any`, `// @ts-` suppressions, and string casts for domain IDs; use the parsers in `src/domain/ids.ts`. Use Prettier double quotes and trailing commas. Name React components PascalCase and hooks `use-*.ts`.

The renderer uses shadcn/ui components on Base UI. Use `$shadcn` for UI component work. Reuse installed components and their variants before creating custom markup or styles.

Add regression tests for bugs when practical. Keep fixtures only when active production seams consume them. Do not loosen performance assertions for a slow local run.

## Architecture and Safety

- Keep the renderer sandboxed: do not weaken Electron’s Node isolation or web security.
- The loopback API requires its per-launch capability. GitHub writes require explicit UI confirmation, except the exact Review publication batch may use the immutable per-Analysis-run authorization defined by the approved product contract. Merge, Published feedback deletion or dismissal, and writes outside that authorized batch always require explicit confirmation.
- Do not persist credentials in profiles.
- Provider support uses built-in environment API-key or ambient machine-credential providers only; exclude OAuth-only providers and Cloudflare Workers bindings from selectable catalogs. Keep availability checks main-process-only and redacted; never probe providers, read a full environment, execute custom-provider configuration, or expose/persist credential values. Keep Flue beta.9 pinned; plan a Flue 2 migration separately.
- Cleanup may remove only non-running review sessions.

## Memory

- Read `brain/index.md` before Patchdesk work.
- For Pierre or Flue integration research, use `$librarian` for upstream sources.
- Do not use broad Git cleanup commands such as `git clean` or `git reset --hard`.
- Backward compatibility requires a user request.
- For every live app, browser, or packaged-Electron test, the primary agent must spawn a dedicated tester subagent and direct it to use `$patchdesk-electron-tester`; it owns interactive QA and evidence.
- Use `$patchdesk-review-lifecycle` for Review, refresh, Insight, draft, publication, recovery, retry, Walkthrough, or merge lifecycle changes.
