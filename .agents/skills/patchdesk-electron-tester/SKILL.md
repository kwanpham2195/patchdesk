---
name: patchdesk-electron-tester
description: "Use when verifying Patchdesk's live app through real-data CDP QA."
---

# Patchdesk Electron Tester

Use as the dedicated tester for every live Patchdesk app, browser, or packaged-Electron check. The primary agent may run static checks and test suites, but must not perform live UI interaction. Do not edit project files, make remote writes, or confirm GitHub write actions.

Use the development path by default. Package only on an explicit user request, including a request for packaging-specific work or packaged acceptance proof.

## Data and profile policy

- Verify against the real available development app and its normal local data by default. Do not silently substitute a fixture route, mocked bridge data, or synthetic Review state.
- Reuse an already-running Patchdesk development app when possible. If launching one, omit `--user-data-dir` so the app uses the user's normal development profile:

  ```bash
  pnpm dev -- --remote-debugging-port=9233
  ```

  The switch must be kebab-case with `=`; `--remoteDebuggingPort` is silently ignored. The flag is read at launch, so an already-running app must be restarted to attach CDP.

- If the real app requires login, unavailable credentials, or a missing backend, stop and report the blocker instead of switching to a fixture.
- Keep live verification read-only unless the user explicitly authorizes a local draft or remote write. Never save a comment, publish feedback, merge, or dismiss/delete feedback just to prove a UI path.
- Redact real repository names, paths, review text, tokens, and screenshots in reports unless the user explicitly asks for those details.

### Development app

Use this for fast feedback on current source, HMR, preload behavior, and live Electron wiring.

- Load `agent-browser skills get core` and `agent-browser skills get electron` before using `agent-browser`.
- Connect with a fresh command for every interaction:

  ```bash
  agent-browser --session patchdesk-dev --cdp 9233 snapshot -i
  ```

### Packaged app

Use this only for requested distribution/runtime proof: `asar` contents, unpacked Flue assets, preload loading, packaged startup, and production behavior.

1. Run a fresh `pnpm package:mac`.
2. Inspect `release/mac-arm64/Patchdesk.app/Contents/Resources/app.asar` for a task-specific renderer or runtime marker. A successful package command can otherwise leave an older bundle in place.
3. Run `pnpm test:package-smoke`. Do not launch a second app against its CDP port while smoke testing.
4. Launch the packaged app with a unique user-data directory and unused CDP port:

   ```bash
   ./release/mac-arm64/Patchdesk.app/Contents/MacOS/Patchdesk \
     --user-data-dir=/tmp/patchdesk-qa-packaged \
     --remote-debugging-port=9233
   ```

5. Connect per command with `agent-browser --session patchdesk-packaged --cdp 9233`; never reuse a stale CDP connection.

## Exercise and report

- Confirm no other dev, package-smoke, or packaged QA run uses the selected CDP port.
- Capture `snapshot -i` before each interaction and after each click. After every route or workflow, inspect page errors and console output.
- Exercise the supplied scenario through the visible UI. Use Computer Use only when native macOS interaction is essential; prefer `agent-browser` over CDP otherwise.
- Capture at least one screenshot proving the final visible result.
- Report the selected path, whether an existing app or normal development profile was reused, the exact launch command if one was needed, CDP port, scenario/result, screenshots, relevant snapshots, console/page-error result, and blockers with their user-visible effect.
- Do not package or run packaged-app QA unless the user explicitly requests it, including through a packaging-specific task or packaged acceptance requirement.
- Do not claim live verification from a build, unit test, or static inspection alone. Do not expose capability values, credentials, raw prompts, review paths, or model prose.

`pnpm exec playwright test` and `pnpm test:e2e` are browser regression suites against built renderer output. They complement, but do not replace, live development-app or packaged-app QA.
