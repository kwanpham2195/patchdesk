# Patchdesk

Patchdesk is a local-first Electron workbench for reviewing pull requests. This milestone provides only the empty desktop shell and its privilege boundary.

## Development

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm dev
```

## v1 safety statement

The renderer has no Node.js access. The main process starts a Hono loopback API on `127.0.0.1` with a random port, then waits for its authenticated health check before opening the workbench. Every current local API route requires the per-launch capability passed only through preload and a matching renderer origin; cross-site and navigation-shaped requests are rejected. Patchdesk does not persist GitHub tokens, execute raw shell commands from the renderer, or make GitHub writes in this scaffold.

Flue is installed using its current `src/` source-discovery convention. The scaffold intentionally declares no workflow, route, or run stream, so no Flue surface is exposed until a later milestone can apply capability plus session/run ownership checks.
