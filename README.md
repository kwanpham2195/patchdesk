# Patchdesk

Patchdesk is a local-first Electron workbench for preparing, inspecting, and
explicitly running pull-request reviews.

## Development

**Prerequisites.** macOS on Apple Silicon (arm64) only — there is no
Windows, Linux, Intel, or universal build; the packaged app will not run on
an Intel Mac. Install the GitHub CLI (`gh`) and `git`; Patchdesk shells out
to both, and never stores GitHub credentials itself — the entire GitHub
read/write path runs `gh auth token --hostname <host> --user <account>` (see
`src/adapters/github/github-credentials.ts`). Authenticate before running
the app:

```bash
gh auth login
```

Use pnpm 8.8.0 and Node >=22.19.0. Electron 43.1.1 embeds a compatible Node
release. The isolated Flue 2 runtime has an exact lock and is validated
during package smoke.

**Install and fast checks.**

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test -- --run
```

`pnpm install` also installs `runtime/flue`'s dependencies through the root
`prepare` script. If you ran `pnpm install --ignore-scripts`, `prepare` did
not run and packaging will fail; recover with `pnpm --dir runtime/flue install`.

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

`pnpm package:mac` produces `release/mac-arm64/Patchdesk.app` (the unpacked
app `pnpm test:package-smoke` reads) and `release/Patchdesk-0.1.0-arm64-mac.zip`
(~196 MiB) — note the zip sits directly in `release/`, not in
`release/mac-arm64/`. That zip is what you hand to another developer; a
`.blockmap` sidecar is written next to it and is not part of the handoff.

The build is ad-hoc signed, not Apple-signed or notarized. Before first
launch, a recipient must clear the quarantine attribute:

```bash
xattr -cr /path/to/Patchdesk.app
```

or right-click the unzipped `Patchdesk.app` → Open → "Open Anyway".

**Local work.**

```bash
pnpm dev
```

See [AGENTS.md](AGENTS.md) for the ordered full gate and live-app checks.

## Documentation

- [Architecture](docs/architecture.md) describes the high-level architecture.
- [Test cases](docs/test-cases.md) lists the canonical automated and manual checks per flow.
- [CONTEXT.md](CONTEXT.md) is the glossary of domain terms.
- [docs/adr/](docs/adr/) holds the architecture decision records.

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
