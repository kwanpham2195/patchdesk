# Run Flue 2 Insights in Patchdesk-owned one-shot children

> **Status: Superseded in part by ADR 0041 for the runtime choice.** The child
> no longer runs on Flue; it drives a Pi agent loop directly. Everything else
> below — the one-shot child, the bounded stdin and stdout protocol, the
> non-authoritative result, and the child's narrow environment — still holds.

Patchdesk runs each Pi Analysis or Walkthrough in one dedicated child process built on Flue 2's programmatic Node API. The child starts one in-memory Flue runtime, creates one invocation-scoped agent, dispatches one finite request, reads one strict result, stops the runtime, and exits. Patchdesk does not use the Flue CLI, workflow discovery, a long-lived in-process runtime, or Flue persistence as Review authority.

The parent sends one bounded, strictly parsed invocation through stdin. The child returns one bounded JSON result through stdout. Model prose is never authoritative. The agent must submit its result through one Valibot-backed `submit_patchdesk_result` tool and an unconditional `useDataWriter`; the child requires exactly one matching `AgentReply.data` value and parses it again before returning it. Duplicate submissions, missing data, malformed data, and extra fields fail closed.

Analysis mounts only the trusted packaged Patchdesk review skill, four bounded immutable `ReviewInspector` tools, and the result-submission tool. One invocation-scoped inspector retains the aggregate eight-call budget across renders and concurrent calls. Walkthrough mounts only the result-submission tool. Neither agent mounts a sandbox, MCP connection, declared subagent, generic filesystem or shell capability, or GitHub writer. The production child receives only the selected built-in provider's allowlisted credential and configuration variables, a fixed system PATH and locale, and HOME only for approved AWS or Google ambient machine credentials. It never inherits the complete Electron environment.

Cancellation is owned at both boundaries. The child handles termination by calling the active Flue handle's `abort()`, then performs a bounded runtime stop. The parent retains owned process-group termination as the hard backstop. Cancelling only the local `read()` wait is insufficient. `InsightRunCoordinator` remains the sole durable owner of lifecycle, recovery, revision checks, validation, supersession, and retained results.

The shipped child runtime is a separate exact package with a committed lock. It pins Flue 2.0.3 and one compatible exact Pi AI version, requires Node 22.19.0 or newer, installs frozen and offline for packaging, and contains no fallback to a previous package. Package smoke uses a separate fixed faux-provider entry with an explicit environment allowlist; production cannot select faux mode.

Moving to a long-lived or in-process Flue runtime, adding sandbox, MCP, subagents, instrumentation, or new model-visible capabilities changes the isolation and authority boundary and requires a new decision and threat review.
