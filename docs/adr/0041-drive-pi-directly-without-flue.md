# Drive Pi directly without Flue

> **Status: Accepted.** Supersedes ADR 0018 for the runtime choice. The rest
> of 0018 stands: one throwaway child per run, bounded stdin and stdout, a
> result that is never authoritative, and a child that inherits only the keys
> it needs.

ADR 0018 built each Insight child on Flue 2's programmatic Node API. The child
started an in-memory Flue runtime, created one invocation-scoped agent,
dispatched one request, read one result off a data channel, stopped the
runtime, and exited. Every other capability Flue offered — the CLI, workflow
discovery, persistence, a sandbox, MCP, subagents — 0018 forbade in the same
breath.

What was left was Flue's agent loop, and that loop wraps
`@earendil-works/pi-agent-core`, which the runtime already installed. Patchdesk
was carrying a framework to reach a library it had, from a project with one
maintainer, and Flue 2.0.3 declared older versions of Pi and Valibot than
Patchdesk pins — so the runtime package needed a `pnpm.overrides` block to
force the pinned versions through every install.

## The decision

The insight child builds one `pi-agent-core` `Agent` per invocation and drives
it itself. The three factories in
`runtime/flue/src/patchdesk-insight-agent.ts` return a plain spec — system
prompt, model specifier, thinking level, and the tools the model may see — and
`runtime/flue/src/patchdesk-insight-runner.ts` resolves the model against a
fresh `pi-ai` `Models` registry, runs the loop once, and reads the one
submitted result off the submit tool's own state.

`@flue/runtime` is gone from `runtime/flue/package.json`, and twenty packages
leave the runtime's lock with it: the Model Context Protocol client and core, a
Hono server, and `zod` — a third schema library beside Valibot and the JSON
Schema the agent loop validates against — among them. The `pnpm.overrides`
block goes too.

The directory and the identifiers keep their `flue` names: `runtime/flue/`,
`pnpm stage:flue-runtime`, `flue-insight-child-invoker.ts`. Renaming them is a
separate decision and is not made here.

### What the model sees

Flue's loop mounted two framework tools of its own, `task` and
`activate_skill`. Neither was usable here — 0018 declares no subagent, and the
one trusted skill is fixed and known before a run starts — but both appeared in
the tool list the model reads. They are gone. An Analysis agent now sees the
four inspector tools and `submit_patchdesk_result`; a Walkthrough or Brief
agent sees `submit_patchdesk_result` alone.

The `patchdesk-code-review` skill is no longer offered for activation. Its
instructions are concatenated into the Analysis system prompt, so they are in
front of the model from the first turn instead of one tool call away.

### Validation and bounds

Pi validates tool arguments against JSON Schema, so each Valibot result schema
is projected with `@valibot/to-json-schema`. The projection drops exactly one
constraint, the top-level section-count check in
`src/services/walkthrough-operation.ts`, which JSON Schema cannot carry.
Valibot remains the authority: `v.safeParse` inside the submit tool re-parses
the arguments before anything is recorded, and the parent parses the result
again after the child exits.

The loop stops after 24 turns. Only a tool call continues it and the inspector
budget stops at eight calls, so a well-behaved insight settles far below the
cap; it is there to bound a model that keeps calling tools and never submits.

A transient provider error is retried three times. `pi-ai`'s
`retryProviderRequest` is gated by `maxRetries`, which defaults to zero and
which the agent loop never sets, so the child sets it rather than let one 429
end a run.

### Isolation is now structural

0018 listed what the child must not mount: no sandbox, no MCP connection, no
declared subagent, no generic filesystem or shell capability, no GitHub writer.
That was a rule about how the agents were configured. It is now a fact about
what is installed. The runtime has no MCP client and no sandbox, and the agent
loop mounts no tool of its own, so no code path in the shipped runtime can
create one. The child still receives only the selected provider's allowlisted
credentials, a fixed PATH and locale, and HOME only for ambient AWS or Google
machine credentials.

## Consequences

- The model's tool list loses `task` and `activate_skill`. Analysis keeps the
  four inspectors plus submission; Walkthrough and Brief keep submission alone.
- Flue's context compaction is given up, not replaced. One insight is a single
  bounded prompt under a 24-turn ceiling, so no run reaches the context window
  compaction existed to save.
- Flue's own three-attempt transient retry is replaced by Pi's
  `retryProviderRequest`, set to the same three attempts.
- The staged runtime is twenty packages smaller and ships no MCP client, no
  HTTP server, and no `zod`.
- The runtime manifest drops `flueVersion`. It carries `piVersion`,
  `catalogDigest`, `nodeFloor`, and `lockDigest`, and the main process reads it
  with a strict schema, so a staging written by an older packaging is rejected
  rather than read as current.
- The sandbox, MCP, subagent, and inspector-tool invariants of ADR 0018 and ADR
  0036 hold by construction rather than by configuration. Bringing any of them
  back means adding a dependency, which is a new decision and a new threat
  review.
- The names still say Flue. A rename would touch the directory, the staging
  script, the packaged resource folder, and the invoker, and it is left for its
  own decision.
