# Patchdesk

Patchdesk is a local-first Electron workbench for preparing, inspecting, and
explicitly running pull-request reviews. It is a desktop app that runs on
your machine, reads pull requests from your watched repositories on GitHub,
and lets you review and act on them without a hosted service in between.

## Requirements

- macOS on Apple Silicon (arm64) only — there is no Windows, Linux, Intel, or
  universal build; the packaged app will not run on an Intel Mac.
- The GitHub CLI (`gh`), installed and authenticated:
  ```bash
  gh auth login
  ```
- `git`.

Patchdesk never stores GitHub credentials itself. The entire GitHub
read/write path shells out to `gh auth token --hostname <host> --user
<account>` (see `src/adapters/github/github-credentials.ts`); Patchdesk holds
no token of its own.

## Install

Patchdesk is distributed as a `.zip`. Unzip it, then clear the quarantine
attribute before first launch — the build is ad-hoc signed, not
Apple-signed or notarized:

```bash
xattr -cr /path/to/Patchdesk.app
```

or right-click `Patchdesk.app` → Open → "Open Anyway".

## First run

Launch the app. If you have not already authenticated `gh`, run `gh auth
login` first. Patchdesk resolves the rest of its setup from the machine —
your GitHub account and a starting workspace root — then asks which
repositories under that root to watch.

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

## Documentation

- [Architecture](docs/architecture.md) describes the high-level architecture.
- [Test cases](docs/test-cases.md) lists the canonical automated and manual checks per flow.
- [CONTEXT.md](CONTEXT.md) is the glossary of domain terms.
- [docs/adr/](docs/adr/) holds the architecture decision records.

## Building from source

To build Patchdesk yourself or contribute changes, see
[CONTRIBUTING.md](CONTRIBUTING.md).
