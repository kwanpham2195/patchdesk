# Patchdesk

Patchdesk is a local-first Electron workbench for preparing, inspecting, and
explicitly running pull-request reviews.

## Development

**Runtime.** Use pnpm 8.8.0 and Node >=22.19.0. Electron 43.1.1 embeds a
compatible Node release. The isolated Flue 2 runtime has an exact lock and is
validated during package smoke.

**Install and fast checks.**

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test -- --run
```

**Desktop and renderer.** Build before the full browser suite.

```bash
pnpm build
pnpm test:e2e
```

**Focused browser checks.**

```bash
pnpm test:a11y
pnpm test:performance
```

**Release package.** Build a macOS directory package, then smoke-test it.

```bash
pnpm package:mac
pnpm test:package-smoke
```

`pnpm stage:flue-runtime` builds and stages the exact isolated Flue runtime.
Package smoke runs fixed faux Analysis and Walkthrough fixtures before UI checks.

**Local work.**

```bash
pnpm dev
```

See [AGENTS.md](AGENTS.md) for the ordered full gate and live-app checks.

## Safety statement

The renderer is sandboxed and has no Node.js access. Preload exposes its IPC
bridge. The main process starts a Hono loopback API on `127.0.0.1` with a random
port, then waits for its authenticated health check before opening the
workbench. The main process holds and sends the per-launch capability for each
local API request. Every route also requires the matching renderer origin;
cross-site and navigation-shaped requests are rejected.

Patchdesk does not persist GitHub credentials or expose a renderer shell.
Normal GitHub writes happen only from a named maintainer action. Finding **Add
to review** is one explicit action for one GitHub write; it never runs when
Analysis completes. If Patchdesk cannot confirm a write outcome, it locks the
write for explicit GitHub reconciliation and never retries it automatically.

Pull-request descriptions and check links are rendered as untrusted content;
only a user click may open an HTTPS link on the configured GitHub host through
the main process.
