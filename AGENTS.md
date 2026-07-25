# Patchdesk rules

## Hard rules

- Do not use broad git cleanup commands (`git clean`, `git reset --hard`, bulk restores) from Patchdesk.
- Do not create GitHub reviews, comments, merges, pushes, or any other remote writes automatically; require explicit user confirmation.
- For every live app, browser, or packaged-Electron verification, the primary agent must spawn a dedicated tester subagent. The tester owns interactive QA and returns screenshots plus concrete evidence; use `agent-browser` over CDP by default, and Computer Use only when native macOS interaction is required. The primary agent may run static checks and test suites, but must not perform live UI steps itself.
- Keep `tests/browser/performance.spec.ts`'s 1,000-file selection ceiling at `<200ms` unless profiling demonstrates a deliberate, reviewed replacement; do not loosen it to accommodate a slow local run.

## Architecture (don't break these)

- Electron app: privileged `main` + sandboxed `preload` (CJS) + isolated `renderer`. Renderer has no Node.js access. `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true` — do not relax.
- The main process starts a Hono loopback API on `127.0.0.1` with a random port and waits for an authenticated health check before opening the workbench. Every route requires a per-launch capability passed only through preload, with a matching renderer origin; cross-site / navigation-shaped requests are rejected. See `src/main/local-api.ts`, `src/main/app-capability.ts`, `src/main/electron-main.ts`.
- GitHub writes (review, comment, merge) always require explicit user confirmation in the UI. PR descriptions and check links are untrusted; only a user click may open an HTTPS link on the configured GitHub host via the main process. See `src/main/external-navigation.ts`.
- Layered code: `src/domain/` (pure types + invariants) → `src/services/` (orchestration) → `src/adapters/{github,pi,storage}/` (I/O). Local API composition lives in `src/app.ts`; never publish a Patchdesk review route from there.
- External runtime assets (workflows, skills, `@flue/*`) are unpacked from `asar` at runtime. Keep them under `src/workflows/`, `src/skills/`, and `node_modules/@flue/**` when adding new ones — see the `build.asarUnpack` list in `package.json`.
- No CI workflows exist under `.github/`. All verification is local; treat the commands below as the source of truth.

## Commands (pnpm@8.8.0)

| Goal                            | Command                                  |
| ------------------------------- | ---------------------------------------- |
| Dev (HMR, three processes)      | `pnpm dev`                               |
| Lint                            | `pnpm lint` (ESLint, `--max-warnings=0`) |
| Typecheck                       | `pnpm typecheck` (`tsc --noEmit`)        |
| Unit / integration tests        | `pnpm test -- --run`                     |
| Renderer dashboard suite only   | `pnpm test:ui`                           |
| Build main + preload + renderer | `pnpm build`                             |
| Browser e2e (Playwright)        | `pnpm exec playwright test`              |
| Build + run browser e2e         | `pnpm test:e2e`                          |
| Accessibility Playwright run    | `pnpm test:a11y`                         |
| Performance Playwright run      | `pnpm test:performance`                  |
| Package unsigned Mac app (dir)  | `pnpm package:mac`                       |
| Packaged smoke test             | `pnpm test:package-smoke`                |

Verification order for any change touching the desktop or renderer: `pnpm lint && pnpm typecheck && pnpm test -- --run && pnpm build && pnpm exec playwright test && pnpm package:mac && pnpm test:package-smoke`.

## Packaged-app QA (CDP)

Primary agent does not run these. Spawn a `electron-tester` subagent and hand it the recipe.

- Launch isolated packaged app with a distinct user-data dir and CDP port:
  `./release/mac-arm64/Patchdesk.app/Contents/MacOS/Patchdesk --user-data-dir=/tmp/patchdesk-qa --remote-debugging-port=9233`
  Pick a different port if 9233 is occupied.
- Connect per command (avoids stale persistent CDP connections):
  `agent-browser --session patchdesk-qa --cdp 9233 snapshot -i`
  `agent-browser --session patchdesk-qa --cdp 9233 screenshot /tmp/patchdesk-qa.png`
- `pnpm test:package-smoke` already launches its own isolated instance; do not run a second one in parallel against the same port.

## Test layout

- Vitest (Node env): `tests/**/*.test.{ts,tsx}` — covers domain, services, adapters, renderer units, desktop bridge, local API auth, main lifecycle. Alias `@/` → `src/renderer/src/`.
- Playwright (Chromium, headless): `tests/browser/*.spec.ts` — milestones, accessibility, performance, plus milestone-9 snapshot dir.
- Renderer component tests are colocated under `src/renderer/src/` and run with `pnpm test:ui` (filter `dashboard.ui`).
- Fixtures live under `fixtures/{flue,github,scenarios,screen-states}/` and are loaded by `tests/setup.ts`.

## Conventions

- TypeScript is strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`. Code that compiles locally is expected to typecheck clean without `// @ts-` or `as any`; ESLint also forbids them.
- Path aliases in `tsconfig.json`: `@/*` → `src/renderer/src/*`; `@flue/runtime` and `@flue/runtime/routing` are stubbed to local types in `src/flue-*.ts`.
- `react-refresh/only-export-components` is off only for `src/renderer/src/components/ui/**` (shadcn registry). Anywhere else, components-only files are enforced.
- Prettier: double quotes, trailing commas.
- Domain types in `src/domain/ids.ts` parse via dedicated parsers (e.g. `parseWorkspaceProfileId`); use them rather than casting strings.
- Service constructors accept the `PatchdeskPaths` storage root and a clock; inject them in tests rather than reaching for module globals.

## Agent skills

- **Issue tracker.** Issues and specs live as local markdown under `.agents/tasks/<feature>/`. See `docs/agents/issue-tracker.md`.
- **Triage labels.** Canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.
- **Domain docs.** Single-context: `CONTEXT.md` + `docs/adr/` at the repo root, created lazily. See `docs/agents/domain.md`. Currently neither file exists — proceed silently; do not flag the gap.
