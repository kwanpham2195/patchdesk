# Patchdesk

Patchdesk is a local-first Electron workbench for preparing, inspecting, and
explicitly running pull-request reviews.

## Development

**Runtime.** Use pnpm 8.8.0. Node 24.18.0 is the currently verified development
line; Electron 43.1.1 also embeds Node 24.18.0. This is not an `engines`
contract. A later Flue 2 migration will set its runtime floor.

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

Legacy code still contains an inactive immutable, per-Analysis-run publication
authorization that can describe a publication batch. Current local-API and
renderer paths do not expose that action. It remains a documented exception
until it is removed, so it does not support a universal claim that every GitHub
write needs a separate confirmation.

Pull-request descriptions and check links are rendered as untrusted content;
only a user click may open an HTTPS link on the configured GitHub host through
the main process.
