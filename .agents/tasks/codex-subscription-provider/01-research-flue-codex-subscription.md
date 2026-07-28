---
created_at: 2026-07-26
repos:
  - patchdesk
status: complete
scope: Flue provider architecture and Codex ChatGPT subscription feasibility
---

# Flue and Codex subscription support

## Question

Can Patchdesk support Codex through a user's ChatGPT Plus/Pro subscription while continuing to run the review as a Flue workflow, rather than requiring `OPENAI_API_KEY`?

## Executive answer

**Yes at the Pi transport level, but not as a turnkey Flue configuration today.** The installed Pi AI package already contains an `openai-codex` provider with the ChatGPT OAuth flow and the `openai-codex-responses` transport. Flue resolves that provider's model catalog, but its current runtime path does not expose an OAuth login/credential-store integration to Patchdesk and its documented provider setup is API-key/environment based.

The practical boundary is:

- `openai/gpt-*` + `OPENAI_API_KEY` = OpenAI Platform usage, not ChatGPT subscription entitlement.
- `openai-codex/gpt-*` + ChatGPT OAuth access token = Codex backend/subscription path.
- Patchdesk currently only advertises model IDs from `~/.pi/agent/settings.json` and starts a separate Flue CLI process. It does not read Pi's `auth.json`, perform OAuth, or pass a subscription token into that child process.

## Evidence from the current Patchdesk repo

- `package.json` pins `@flue/runtime`, `@flue/cli`, `@flue/sdk`, and `@flue/react` to `1.0.0-beta.9`; Flue runtime requires the Pi packages transitively.
- `flue.config.ts` only sets `target: "node"`.
- `src/app.ts` only mounts `flue()` into Hono; Patchdesk does not call `registerProvider` or `registerApiProvider`.
- `src/workflows/review-pr.ts` declares a Flue agent and calls `harness.session().prompt(...)`. The selected model is passed to that prompt from workflow input.
- `src/services/flue-cli-review-invoker.ts` invokes a separate process:
  `node node_modules/@flue/cli/bin/flue.mjs run workflow:review-pr --input <json>`.
  It passes only `ELECTRON_RUN_AS_NODE=1`; no provider credential or OAuth handoff is added.
- `src/adapters/pi/pi-runtime-model-catalog.ts` reads only the allowlisted `enabledModels` and `defaultModel` fields from `~/.pi/agent/settings.json`. It deliberately does not read credentials.
- `src/main/local-api.ts:modelConfigurationState()` recognizes only API-key environment variables (`OPENAI_API_KEY`, `OPENCODE_API_KEY`, `OPENROUTER_API_KEY`, and `ANTHROPIC_API_KEY`). It has no subscription-auth state.

Relevant prior Patchdesk artifacts read before this investigation:

- `brain/codebase/index.md`
- `.agents/tasks/narrative-walkthrough/00-sources.md`
- `.agents/tasks/narrative-walkthrough/02-research-codiff.md`
- `.agents/tasks/narrative-walkthrough/03-research-plannotator.md`
- `AGENTS.md`

## Evidence from installed Flue and Pi packages

The installed package is more informative than Flue's public configuration docs:

1. `node_modules/@flue/runtime/dist/internal.mjs` resolves model strings through Pi's catalog (`getModel`) unless a Flue `registerProvider` override exists.
2. `node_modules/@flue/runtime/dist/conversation-stream-store-*.mjs` obtains credentials only through Flue's registered provider API key (`getRegisteredApiKey(providerId)`) and passes that into the Pi compatibility stream.
3. `node_modules/@flue/runtime/dist/providers-*.mjs` implements `registerProvider` as an in-memory registration with optional `apiKey`, `baseUrl`, headers, and model metadata. It does not expose OAuth login or persistent credentials.
4. `node_modules/.pnpm/@earendil-works+pi-ai@0.80.7_.../node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js` defines:
   - provider ID: `openai-codex`
   - base URL: `https://chatgpt.com/backend-api`
   - auth label: `OpenAI (ChatGPT Plus/Pro)`
   - OAuth loader: `loadOpenAICodexOAuth`
5. The same Pi package exports `loginOpenAICodex`, `loginOpenAICodexDeviceCode`, `refreshOpenAICodexToken`, and `getOAuthApiKey` from its public `@earendil-works/pi-ai/oauth` entrypoint. OAuth credentials contain `access`, `refresh`, and `expires` values.
6. The installed Pi catalog includes the `openai-codex` provider and models using `api: "openai-codex-responses"`.
7. `openai-codex-responses.js` rejects a request when `options.apiKey` is absent, then uses that value as the Codex access token and derives the account ID from the JWT. Therefore, a refreshed OAuth access token can technically be supplied to the transport as the provider `apiKey`, even though it is not an OpenAI Platform API key.
8. The compatibility path used by Flue creates `builtinModels()` with the default in-memory credential store. It does not load Pi's `~/.pi/agent/auth.json`. A local probe against the installed package resolved `openai-codex/gpt-5.4` but reported `authConfigured: false` without an injected credential.

This means the lower-level capability exists, but the current Flue invocation will not automatically inherit a user's interactive Pi login.

## Official source findings

### Flue

Flue's current Models & Providers guide says built-in hosted providers use their normal environment variables, listing `OPENAI_API_KEY` for `openai`, and says Flue uses Pi provider integrations. Its Provider API documents `registerProvider(providerId, { api, baseUrl, apiKey, headers, ... })`. Neither document describes ChatGPT OAuth login, importing Pi's auth file, or a subscription credential store.

Sources:

- [Flue Models & Providers](https://flueframework.com/docs/guide/models/)
- [Flue Provider API](https://flueframework.com/docs/api/provider-api/)
- [Flue CLI `run`](https://flueframework.com/docs/cli/run/)
- Installed source: `node_modules/@flue/runtime/dist/providers-CsCcTxMU.mjs`
- Installed source: `node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs`

### Pi

Pi's provider documentation explicitly lists **ChatGPT Plus/Pro (Codex)** as a subscription provider. It authenticates with `/login`, stores OAuth tokens in `~/.pi/agent/auth.json`, and refreshes them automatically. The same documentation separately lists `OPENAI_API_KEY` for OpenAI Platform access.

Sources:

- [Pi providers and authentication](https://pi.dev/docs/latest/providers)
- Installed declarations: `node_modules/.pnpm/@earendil-works+pi-ai@0.80.7_.../node_modules/@earendil-works/pi-ai/dist/utils/oauth/openai-codex.d.ts`
- Installed provider: `.../pi-ai/dist/providers/openai-codex.js`
- Installed transport: `.../pi-ai/dist/api/openai-codex-responses.js`

### OpenAI

OpenAI documents two distinct Codex sign-in modes:

- Sign in with ChatGPT for subscription access.
- Sign in with an API key for usage-based access.

OpenAI says API-key authentication uses standard API pricing and does not consume included ChatGPT plan credits. ChatGPT sign-in follows ChatGPT workspace permissions and policies. OpenAI also warns that cached Codex credentials are access tokens and must be treated like passwords.

Source:

- [OpenAI Codex authentication](https://developers.openai.com/codex/auth)

## Feasibility matrix

### 1. Add `openai-codex` to the model catalog only

**Not sufficient.** Model resolution already works in the installed Pi catalog, but the Flue child has no OAuth credential. The first request would fail with no API key/token.

### 2. Reuse Pi OAuth in Patchdesk's main process and inject a token into Flue

**Technically feasible and the smallest Flue change.** A main-process-owned auth service could run the Pi OAuth flow, persist/refresh credentials in an app-owned protected store, and inject only the short-lived access token into the Flue runtime before the workflow starts. The runtime would need a registration such as `registerProvider("openai-codex", { apiKey: accessToken })` in the same Node process that executes the workflow, or an equivalent controlled token handoff to the child process.

This requires design work for browser/device-code login, refresh, logout, secure storage, expiry, child-process isolation, status reporting, and avoiding token exposure in argv, logs, renderer state, or diagnostics. Reading `~/.pi/agent/auth.json` directly would couple Patchdesk to another application's secret storage and should not be the default contract.

### 3. Spawn the official Codex CLI instead of using Flue for Codex runs

**Technically feasible but changes the boundary.** The Codex CLI already owns ChatGPT login, token refresh, and subscription behavior. Patchdesk could invoke it as a separate adapter and parse its structured output. This avoids implementing OAuth but would duplicate or bypass the current Flue workflow/session/tool boundary and would need a Codex-specific execution contract.

### 4. Extend Flue upstream with OAuth-aware provider credentials

**Architecturally cleanest, largest scope.** Flue could expose a credential-store seam, login/refresh lifecycle, and provider auth injection for Node CLI runs. Patchdesk could then use the framework's normal provider abstraction. This depends on upstream API direction and should not be assumed available in beta.9.

## Recommendation

Treat this as **supported in principle, not supported by the current Patchdesk/Flue path**. The preferred next investigation is a small proof of concept in an isolated main-process adapter:

1. Authenticate with Pi's `openai-codex` OAuth implementation without exposing tokens to the renderer.
2. Start one Flue workflow child with a controlled, non-argv token handoff.
3. Register `openai-codex` in that child and make one schema-backed prompt.
4. Verify token refresh, failure, logout, and packaged Electron behavior.

Do not label an `OPENAI_API_KEY` field as “Codex subscription”; it is a different billing and entitlement path.

## Open questions before implementation

- Should Patchdesk own a separate Codex OAuth credential, or explicitly integrate with Pi's existing `auth.json`?
- Should subscription credentials be stored under Patchdesk's app-owned config/data paths, in the OS keychain, or delegated to Pi/Codex?
- Does the product need ChatGPT workspace/enterprise identity and policy visibility, or only local Codex model access?
- Is a Codex-specific adapter acceptable if Flue cannot safely expose OAuth in the child process?
- Which exact `openai-codex` models should Patchdesk advertise, and how should unsupported reasoning levels be projected?

## Confidence and gaps

- **High confidence:** Pi package support, model/transport IDs, the absence of Patchdesk OAuth wiring, Flue's documented API-key configuration, and OpenAI's subscription/API-key distinction.
- **Medium confidence:** The long-term Flue API shape, because Patchdesk pins beta.9 while the online docs may reflect a newer source revision.
- **Not verified:** A live OAuth login or network request; no token was accessed, and no credentials were modified.
