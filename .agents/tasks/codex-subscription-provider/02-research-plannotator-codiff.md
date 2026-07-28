---
created_at: 2026-07-26
repos:
  - patchdesk
  - plannotator
  - codiff
status: complete
scope: Plannotator and Codiff Codex authentication and ChatGPT subscription support
spec: .agents/tasks/codex-subscription-provider/01-research-flue-codex-subscription.md
---

# Plannotator and Codiff Codex subscription support

## Question

How do Plannotator and Codiff support Codex, and can their approach provide ChatGPT Plus/Pro subscription access without embedding Codex OAuth into the host application?

## Executive answer

Both projects use the **official local Codex CLI** as the Codex backend. Neither implements ChatGPT OAuth itself, reads Codex/Pi tokens, or calls the OpenAI API directly for its Codex review path. The installed Codex CLI owns authentication, so a user who runs `codex` and selects **Sign in with ChatGPT** can use the subscription-backed login when either project launches Codex.

This is different from Patchdesk's current Flue path:

- Plannotator and Codiff spawn `codex` as an external process and inherit the user's environment and Codex installation state.
- Patchdesk spawns the Flue CLI, whose runtime does not automatically inherit or consume Codex CLI authentication.
- Their approach is therefore a strong reference for a **separate main-process Codex adapter**, not evidence that Flue can consume ChatGPT OAuth directly.

## Common architecture

### Authentication ownership

The host application does not own authentication. It launches the user's installed `codex` executable. The executable resolves its own ChatGPT/API-key login, token refresh, workspace policy, and model entitlement.

OpenAI's official Codex README says to run `codex` and select **Sign in with ChatGPT** for Plus, Pro, Business, Edu, or Enterprise plan access; API-key authentication is an alternative. OpenAI's authentication documentation says the Codex CLI caches login details and refreshes ChatGPT sign-in tokens during use.

Sources:

- [OpenAI Codex README](https://github.com/openai/codex#using-codex-with-your-chatgpt-plan)
- [OpenAI Codex authentication](https://developers.openai.com/codex/auth)

### No Pi OAuth reuse

Neither project uses Pi's `openai-codex` provider for its Codex backend:

- Plannotator's Codex code builds `codex exec` commands.
- Codiff's Codex code builds `codex exec` commands and, when progress is requested, `codex app-server --stdio` commands.
- Codiff's Pi backend is a separate `pi` CLI selection with separate configuration and authentication.

Pi OAuth credentials therefore do not authenticate either project's Codex mode.

## Plannotator

### Code review and guided review

Plannotator's `packages/server/codex-review.ts` builds this command shape:

```text
codex
  [-m MODEL]
  [-c model_reasoning_effort=VALUE]
  [-c service_tier=fast]
  exec
  --output-schema SCHEMA_PATH
  -o OUTPUT_PATH
  --full-auto
  --ephemeral
  -C WORKING_DIRECTORY
  PROMPT
```

The implementation:

- materializes a strict JSON schema to Plannotator's data directory because the external Codex process cannot read Bun's virtual filesystem;
- invokes the native `codex exec` command;
- writes the structured result to a temporary output path;
- parses the result and transforms it into Plannotator findings;
- never sends credentials to the renderer or implements a second OpenAI client.

Plannotator's guided review uses the same command-building strategy in `packages/server/guide/guide-review.ts`: Codex receives `--output-schema` and a temporary output path, and the result is parsed/validated server-side.

Sources:

- `packages/server/codex-review.ts`, `buildCodexCommand`
- `packages/server/guide/guide-review.ts`, `buildGuideCodexCommand`
- [Plannotator Codex review source](https://github.com/backnotprop/plannotator/blob/main/packages/server/codex-review.ts)

### Environment inheritance

Plannotator's `packages/server/agent-jobs.ts` launches jobs with:

```ts
env: {
  ...process.env,
  PLANNOTATOR_AGENT_SOURCE: source,
  PLANNOTATOR_API_URL: getServerUrl(),
}
```

It does not read `~/.codex/auth.json`, pass a token on argv, or implement an OAuth callback. The child process receives the normal user environment, home directory, `CODEX_HOME` value if configured, and access to the Codex CLI's own credential store.

The project's code-review documentation says Plannotator does not manage provider API keys and requires each CLI to be authenticated independently. Its current wording specifically describes Codex as using `OPENAI_API_KEY`, but the implementation is CLI delegation rather than explicit API-key handling. Consequently, ChatGPT subscription support comes from the installed Codex CLI, not from Plannotator's own provider layer.

Sources:

- `packages/server/agent-jobs.ts`, `spawnJob`
- `apps/marketing/src/content/docs/commands/code-review.md`, “Supported providers”
- [Plannotator code-review docs](https://plannotator.ai/docs/commands/code-review)

### Codex plan review

Plannotator's Codex plan integration is a native Codex hook, not a model-provider integration:

- enable `[features] hooks = true`;
- configure a `Stop` command hook that runs `plannotator`;
- discover Codex sessions below `$CODEX_HOME`, defaulting to `~/.codex`;
- parse Codex rollout JSONL and return feedback through the hook protocol.

This flow runs inside/alongside a real Codex session, so it naturally uses the authentication already active in Codex. It has documented limitations: hooks are experimental, currently disabled on Windows in the official integration, and Codex Desktop may need an absolute Plannotator path because app-launched processes may not inherit shell `PATH`.

Source:

- `apps/codex/README.md`
- `apps/hook/server/codex-session.ts`
- [Plannotator Codex integration](https://github.com/backnotprop/plannotator/tree/main/apps/codex)

### Subscription conclusion for Plannotator

**Likely supported through Codex CLI, but not explicitly owned or tested by Plannotator.** If the local Codex CLI is signed in with ChatGPT, Plannotator's spawned `codex exec` process should use that login because it inherits the process environment and user home. Plannotator does not promise subscription entitlements, quotas, or model availability; those remain Codex/OpenAI concerns.

The project's own docs emphasize independent CLI authentication and mention `OPENAI_API_KEY`, so this should be described as “uses the authentication configured in Codex CLI,” not as a Plannotator-managed ChatGPT login.

## Codiff

### Backend selection

Codiff selects one local backend:

- `codex`: OpenAI Codex CLI;
- `claude`: Claude Code CLI;
- `opencode`: OpenCode CLI;
- `pi`: Pi CLI.

Its Codex and Pi paths are separate. Selecting the Pi backend does not make Codex OAuth available, and selecting Codex does not read Pi's OAuth store.

Sources:

- `electron/agent.cjs`, `createCodexAgent` and backend registry
- `electron/pi.cjs`
- `core/config/codiff-config.schema.json`
- [Codiff walkthrough configuration](https://github.com/nkzw-tech/codiff#walkthroughs)

### Codex command path

`electron/codex.cjs` resolves the Codex executable from:

- `CODIFF_CODEX_PATH`;
- `PATH` and common install locations;
- the Codex.app embedded CLI on macOS.

For one-shot execution it launches:

```text
codex exec
  -m MODEL
  -c model_reasoning_effort="low|medium|high"
  --cd REPOSITORY
  --sandbox read-only
  --ephemeral
  --ignore-rules
  --color never
  --json
  --output-schema SCHEMA_PATH
  --output-last-message OUTPUT_PATH
  -
```

The prompt is written to stdin. Codiff parses JSONL progress and usage privately, then reads the final structured response from `--output-last-message`. The schema is validated/normalized before the renderer receives the walkthrough.

When progress callbacks are enabled, Codiff first uses:

```text
codex app-server --stdio -c model_reasoning_effort="..."
```

It sends `initialize`, `thread/start`, and `turn/start` JSON-RPC messages with a read-only sandbox and inline output schema. If the app-server transport is unavailable, it falls back to `codex exec`.

Sources:

- `electron/codex.cjs`, `runCodex`
- `electron/codex.cjs`, `invokeCodexExec`
- `electron/codex.cjs`, `invokeCodexAppServer`
- [Codiff Codex source](https://github.com/nkzw-tech/codiff/blob/main/electron/codex.cjs)

### Environment inheritance

Codiff starts both Codex transports with `env: process.env`. It does not inspect or copy Codex tokens. The user can choose an explicit binary path with:

```bash
CODIFF_CODEX_PATH=/absolute/path/to/codex codiff -w
```

This is important for Electron-launched applications, where shell startup files and `PATH` may differ from the terminal. The Codiff launcher also forwards `CODEX_THREAD_ID` for Codex-session context, but that is conversation context, not authentication.

### Agent-authored walkthroughs

The Codiff Codex skill asks the current Codex agent to author the walkthrough JSON and then opens Codiff with `--walkthrough-file`. In that path, Codiff is not making the model call at all; the active Codex session is. The native Codiff walkthrough path does make the external Codex invocation described above.

Sources:

- `codex/skills/codiff/SKILL.md`
- `codex/skills/codiff/scripts/open-codiff.mjs`
- `electron/codex.cjs`

### Subscription conclusion for Codiff

**Supported indirectly through the official Codex CLI.** Codiff's architecture is closer to what Patchdesk needs for subscription support: a privileged process launches Codex, inherits the user's Codex authentication, keeps the prompt/output boundary local, and exposes only structured results to the UI.

It still does not provide a Codiff login screen or guarantee that every Codex model is available to every ChatGPT plan. Authentication failures are surfaced as CLI failures; model-availability failures may trigger configured fallback models.

## Comparison

### What both projects do

- Delegate Codex authentication to the official `codex` executable.
- Launch Codex locally rather than call undocumented ChatGPT endpoints.
- Inherit `process.env` and the user's home/configuration context.
- Use native structured-output mechanisms (`--output-schema`; Codiff also uses `--output-last-message` and JSONL progress).
- Keep the review process read-only/ephemeral.
- Validate results before publishing them to the UI.
- Keep Pi as a separate backend rather than treating Pi OAuth as Codex authentication.

### What neither project does

- No embedded ChatGPT OAuth browser flow.
- No direct read of `~/.codex/auth.json` or Pi's `~/.pi/agent/auth.json`.
- No conversion of ChatGPT subscription credentials into an OpenAI Platform API key.
- No entitlement/plan/usage management beyond whatever Codex CLI reports.

## Implications for Patchdesk

The closest proven architecture is a new privileged `CodexCliReviewInvoker`, alongside—not inside—the existing `FlueCliReviewInvoker`:

- resolve an explicit configured Codex path, then PATH/known app locations;
- spawn `codex exec` or `codex app-server` from the Electron main process;
- inherit the user environment so Codex's ChatGPT login/keyring works;
- use `--sandbox read-only`, `--ephemeral`, and strict structured output;
- retain Patchdesk's existing session/attempt ownership and safe renderer projection;
- treat Pi and Flue as a separate provider path.

This would support ChatGPT subscription access without storing or handling OAuth tokens in Patchdesk. It would, however, bypass the current Flue workflow for Codex runs. If keeping all providers inside Flue is mandatory, the earlier research remains applicable: Patchdesk must add a main-process OAuth/token handoff or extend Flue's credential integration.

## Decision summary

- **Best subscription compatibility:** launch official `codex` CLI, as Codiff and Plannotator do.
- **Best architectural uniformity:** extend Flue/Pi integration with an explicit credential boundary; larger and more security-sensitive.
- **Do not do:** use `OPENAI_API_KEY` and call it ChatGPT subscription support.

## Confidence and gaps

- **High confidence:** both projects spawn the official Codex CLI; exact command flags, environment inheritance, structured-output handling, and separate Pi paths are visible in source.
- **High confidence:** official Codex supports ChatGPT plan sign-in and API-key sign-in.
- **Medium confidence:** Plannotator's `codex exec` invocation works with every current ChatGPT subscription login state; the project documents CLI authentication but does not publish a dedicated subscription end-to-end test.
- **Not verified:** a live authenticated run using a ChatGPT account; no credentials were accessed or modified.

## Sources and prior research

- `.agents/tasks/codex-subscription-provider/01-research-flue-codex-subscription.md`
- `.agents/tasks/narrative-walkthrough/02-research-codiff.md`
- `.agents/tasks/narrative-walkthrough/03-research-plannotator.md`
- [OpenAI Codex README](https://github.com/openai/codex)
- [OpenAI Codex authentication](https://developers.openai.com/codex/auth)
- [Plannotator Codex README](https://github.com/backnotprop/plannotator/blob/main/apps/codex/README.md)
- [Plannotator Codex review source](https://github.com/backnotprop/plannotator/blob/main/packages/server/codex-review.ts)
- [Plannotator review docs](https://plannotator.ai/docs/commands/code-review)
- [Codiff Codex source](https://github.com/nkzw-tech/codiff/blob/main/electron/codex.cjs)
- [Codiff walkthrough README](https://github.com/nkzw-tech/codiff#walkthroughs)
