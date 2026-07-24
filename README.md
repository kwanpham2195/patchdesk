# Patchdesk

Patchdesk is a local-first Electron workbench for preparing, inspecting, and explicitly running pull-request reviews.

## Development

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm dev
```

## Safety statement

The renderer has no Node.js access. The main process starts a Hono loopback API on `127.0.0.1` with a random port, then waits for its authenticated health check before opening the workbench. Every local API route requires the per-launch capability passed only through preload and a matching renderer origin; cross-site and navigation-shaped requests are rejected.

Patchdesk does not persist GitHub tokens or let the renderer execute shell commands. GitHub reviews, comments, merges, and other writes always require an explicit confirmation. Pull-request descriptions and check links are rendered as untrusted content; only a user click may open an HTTPS link on the configured GitHub host through the main process.
