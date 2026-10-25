# Updating native Pi support

Patchdesk uses the installed Pi CLI for model discovery and Insight generation.
It no longer bundles `pi-ai`, `pi-agent-core`, or a generated API model catalog.
See [ADR 0056](adr/0056-run-insights-through-native-cli-accounts.md) for the
execution and history contracts.

## Refreshing models

Update and authenticate Pi through its own supported workflow. In Patchdesk,
choose Pi CLI account in an Insight run dialog, then choose Refresh models.
Patchdesk discovers the executable through the inherited login-shell PATH.
It does not install Pi, start a login, or change Pi credentials.

A model list is discovery evidence. A successful native run is required to
verify generation against a changed CLI version. Keep the chosen model and
reasoning level explicit, and follow the repository's provider-spend rules.

## Changing the supported CLI contract

Inspect the installed version and protocol before changing the adapter. The
owners are `src/adapters/pi-cli/pi-rpc-client.ts` and its channel, explanation
session, bridge, helper, and wire modules. Keep model discovery nonpersistent.
Generating processes use fresh session directories, never an old conversation.

Verify Brief, Analysis, Guide and Walkthrough through their actual consumers.
Check publication, reopened readers, exact attempt bindings, observed model
and reasoning, history capture, abort acknowledgment and owned-process cleanup
separately. A retained history file has unknown completeness. Pi's Bash bridge
does not prove that detached descendants have stopped.

## Build and distribution

There is no API-runtime package, lockfile, catalog regeneration or staging step.
The native explanation helper is built from the root application and packaged
as a resource. If the helper or packaging changes, run the existing package
smoke check for app, MCP launcher, signature and bundle-size verification.
Separately verify that the packaged helper loads using the bundled Electron
executable in Node mode. The smoke check does not exercise the Pi helper
protocol or start a native provider.

At final verification, run the affected root-package checks and the full check
through the commit hook as documented in [CONTRIBUTING](../CONTRIBUTING.md).
Record user-visible changes in the Unreleased changelog section. CLI upgrades
and model availability do not authorize automatic provider runs.
