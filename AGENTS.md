# Patchdesk rules

- Keep the Electron renderer isolated: `nodeIntegration: false`, `contextIsolation: true`, and expose privileged data only from preload.
- Never store GitHub tokens or other credentials in Patchdesk files, local storage, logs, or telemetry.
- The renderer must never execute raw shell commands; privileged work belongs behind explicit main-process boundaries.
- Do not use broad git cleanup commands (`git clean`, `git reset --hard`, bulk restores) from Patchdesk.
- Do not automatically create GitHub reviews, comments, merges, pushes, or other remote writes; require an explicit user confirmation flow.
- Parse all local API and IPC boundary inputs, return typed expected failures from product modules, and keep capability values out of output and diagnostics.
- Desktop maintainer-surface geometry is a product contract at `min-width: 1280px`: 48px title bar, 232px application rail (48px collapsed), 208px queue rail, and 336px inspector. Compact through local surface classes and shadcn size variants; do not change shadcn primitive defaults or Pierre code font, colors, or line spacing globally.
- For renderer layout changes, prove the real packaged Electron surface through `agent-browser` over CDP as well as browser tests. Check the saved customer-management PR #118, rail restoration, command palette, console/page errors, and page-level horizontal overflow; do not enter a GitHub write confirmation during QA.
- UI verification commands: run `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run`, `pnpm build`, and `pnpm exec playwright test`; then run `pnpm package:mac` and `pnpm test:package-smoke`. Launch the packaged app with `open -n release/mac-arm64/Patchdesk.app --args --remote-debugging-port=9233`, connect with `agent-browser --session patchdesk-qa --cdp 9233 snapshot -i`, and capture `agent-browser --session patchdesk-qa --cdp 9233 screenshot /tmp/patchdesk-qa.png`. Use a distinct CDP port if 9233 is already occupied.
- Common `agent-browser` QA loop: first load `agent-browser skills get core` and `agent-browser skills get electron`; then use `snapshot -i` before every interaction, `errors` and `console` after each route or workflow, `eval` to assert `document.documentElement.scrollWidth - document.documentElement.clientWidth === 0`, and `screenshot` for evidence. Re-snapshot after every click because accessibility refs become stale.
- Keep `tests/browser/performance.spec.ts`'s 1,000-file selection ceiling at `<200ms` unless profiling demonstrates a deliberate, reviewed replacement; do not loosen it to accommodate a slow local run.
