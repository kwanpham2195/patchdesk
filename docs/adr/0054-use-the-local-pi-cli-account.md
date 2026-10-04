# Use the local pi CLI account

> **Status: Accepted** (2026-09-30, maintainer on #551). Extends ADR 0016 to a
> third Insight provider. ADR 0043's activity trace stays Codex-only. Terms in
> bold are defined in [the product glossary](../product-description/glossary.md).

Many reviewers pay for a model subscription and have no API key. The **Codex
CLI account provider** covers a ChatGPT subscription only. The `pi` coding
agent signs in to several subscription providers, such as Claude and ChatGPT,
and keeps those logins fresh. The **pi CLI account provider** runs Brief,
Walkthrough, and Analysis through that login.

## The decision

- **Same lifecycle as Codex.** `pi` is found on the inherited `PATH` only and
  starts only after an explicit user action: Load pi models, Refresh models,
  or a run. Every listing and every run is a fresh
  `pi --mode rpc --no-session` process with the allowlisted environment
  `PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`, `PI_CODING_AGENT_DIR`, and
  `PI_PACKAGE_DIR`. A run starts in the Review's represented worktree.
- **pi owns the login.** Patchdesk never reads `~/.pi/agent/auth.json`,
  refreshes a token, stores a credential, or starts a login. Provider API-key
  variables are not passed, so a model that needs an exported key is not
  listed.
- **Read-only built-in tools.** A run passes `--tools read,grep,find,ls`, which
  also allowlists extension and custom tools by name, so `bash`, `edit`, and
  `write` are off. Patchdesk sends no custom tools. If a tool outside the
  allowlist still starts, Patchdesk aborts the run and fails it.
- **No extensions, no project trust.** `--no-extensions` keeps extensions off,
  because an extension is code with full access and `pi` has no sandbox.
  `--no-approve` ignores trust-gated project-local configuration in the
  reviewed worktree, so no trust prompt can block a run. Skills and context
  files load as they do for Codex.
- **No person answers dialogs.** An `extension_ui_request` dialog (`select`,
  `confirm`, `input`, `editor`) is answered at once with `cancelled: true`.
- **Model and thinking level on the command line.** A run passes `--model
provider/id` and `--thinking <level>`, then checks `get_state` and refuses
  the run as `runtime_unavailable` when `pi` resolved another model or level.
  The prompt goes through the RPC `prompt` command. The run ends at
  `agent_settled`, and the last assistant message is parsed with
  `parseTurnJson` and validated against the same result contracts as Codex.
  `pi` has no output-schema channel, so the prompt's result contract is the
  only shape guidance.
- **Listing.** `POST /v1/insight-providers/pi-cli/models` runs
  `get_available_models` in a child with `--no-tools`. The list keeps models
  with reasoning support, maps pi's thinking levels to Patchdesk's `minimal`
  through `xhigh`, and names each model `provider/id`. An empty list means no
  login and is `authentication_required`.
- **Minimum version 0.80.4.** `get_available_models` exists since 0.16.0, but
  `--no-approve` arrived in 0.79.0 and `agent_settled` in 0.80.4. Before each
  listing or run, Patchdesk reads `pi --version`; an older `pi` is
  `runtime_unavailable`, and the listing route adds `requiredVersion` so the
  dialog names the version to install.
- **Errors.** `pi` missing from `PATH` or unable to start is
  `runtime_unavailable`. A missing or expired login, pi's "Authentication
  failed" and "No API key" refusals, and a provider 401 are
  `authentication_required`; the dialog says "Check the pi login."
- `run_insight` over MCP is unchanged; the maintainer picks the provider when
  approving the request.

## Consequences

- `InsightProvider` gains `pi-cli-account`, recorded in provenance like the
  other two. The Codex and pi account providers share
  `AccountInsightInvoker`, which owns worktree and artifact validation and the
  prompts.
- `pi`'s `read`, `grep`, `find`, and `ls` tools accept absolute paths, so the
  model can read files outside the worktree that the maintainer's account can
  read. This matches Codex's read-only sandbox, which also allows reads
  anywhere. Neither provider can write. The readable files include pi's own
  `~/.pi/agent/auth.json`, which holds the login's tokens: Patchdesk never
  reads it, but the model's `read` tool can. A prompt injection in the
  reviewed patch could have the model copy a token into a Finding, a Brief,
  or a Walkthrough, where the maintainer might publish it. Patchdesk does not
  scan results for secrets.
- A pi CLI account run projects no activity trace; the running panel shows the
  spinner and start time as an API key run does.
- A pi login lists hundreds of models, so the renderer's per-provider model
  cache holds up to 2,048 entries.
