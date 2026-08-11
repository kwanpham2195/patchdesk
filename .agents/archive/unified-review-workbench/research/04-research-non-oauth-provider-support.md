---
created_at: 2026-08-04
repos:
  - patchdesk
status: research
spec: .agents/tasks/unified-review-workbench/spec.md
---

# Non-OAuth provider support research

## Decision

Patchdesk will support Pi/Flue providers authenticated by environment API keys or ambient machine credentials. It will exclude OAuth-only paths, including OpenAI Codex, Anthropic subscription OAuth, and GitHub Copilot. Anthropic API-key authentication remains supported.

## Current failure explained

`openai-codex/gpt-5.6-luna` resolves as a valid pi-ai model and the Flue workflow builds. The installed Flue beta.9 execution path calls pi-ai's compatibility API, which resolves only environment API keys. OpenAI Codex uses OAuth and receives no API key, so the provider exits before a model call with `No API key for provider: openai-codex`. Patchdesk safely classifies that process exit as `execution_failed`.

Evidence:

- `src/services/flue-cli-walkthrough-invoker.ts`
- `src/adapters/github/command-runner.ts`
- `src/workflows/generate-walkthrough.ts`
- installed `@earendil-works/pi-ai` `dist/compat.js`, `dist/env-api-keys.js`, and `dist/providers/openai-codex.js`

## Eligible provider families

Current pi-ai supports environment-key or ambient authentication for: Amazon Bedrock; Ant Ling; Anthropic API key; Azure OpenAI Responses; Cerebras; Cloudflare AI Gateway; DeepSeek; Fireworks; Google; Google Vertex; Groq; Hugging Face; Kimi Coding API key; MiniMax; Mistral; Moonshot; NVIDIA; OpenAI; OpenCode; OpenCode Go; OpenRouter; Qwen token plans; Together; Vercel AI Gateway; xAI API key; Xiaomi token plans; and ZAI coding plans.

Ambient machine authentication includes AWS credentials/profiles for Bedrock and Google Application Default Credentials plus project/location for Vertex. Cloudflare Workers AI binding is excluded because Patchdesk runs on Node/Electron, not a Workers binding.

Provider availability means credentials are locally configured, not that Patchdesk makes a paid or network probe.

## Patchdesk gaps

`src/adapters/pi/pi-runtime-model-catalog.ts` currently reads only `~/.pi/agent/settings.json.enabledModels`. It does not resolve provider authentication, discover Pi custom provider definitions, model-store catalog entries, or ambient credentials.

`src/main/local-api.ts` recognizes only four API-key variables. It cannot accurately project the configured status of other eligible providers.

## Recommended architecture

1. Add a main-process-only provider catalog/auth adapter.
   - Read only allowlisted non-secret Pi settings and model metadata.
   - Determine provider availability from provider-specific environment/ambient-auth checks.
   - Return canonical `provider/model` identifiers plus a redacted availability state and source label such as `OPENAI_API_KEY`, `AWS profile`, or `gcloud ADC`.
   - Never return credential values, OAuth tokens, arbitrary custom-provider headers, or complete environment data.
2. Filter `/v1/reviews/models` to eligible, configured, non-OAuth models. The renderer must never decide provider authentication.
3. Surface unavailable providers as settings guidance, not selectable Insight models. Do not make network or paid probes.
4. Preserve the current Flue CLI boundary, shell-free execution, owned cancellation, revision-bound result validation, and safe failure persistence.
5. Cover provider/auth matrix behavior, local API responses, canonical IDs, cancellation/recovery, and packaged runtime closure.

## Flue version decision

Patchdesk pins `@flue/cli` and `@flue/runtime` at `1.0.0-beta.9` (`package.json`, `pnpm-lock.yaml`). Upstream Flue is `2.0.1`, but it removes the workflow/CLI surfaces Patchdesk uses (`defineWorkflow`, workflow discovery, and beta workflow CLI invocation). Do not combine provider support with that migration. Plan Flue 2 as a separate rewrite.

## Risks

- GUI-launched Electron may not inherit shell exports; environment-key availability must describe the launched process, not a terminal assumption.
- Pi catalogs and custom model definitions can change independently of Flue.
- Custom model metadata may contain arbitrary sensitive configuration; enumeration must remain metadata-only.
- Configured credentials are not proof a provider will accept a paid request.

## Likely implementation seams

- `src/adapters/pi/pi-runtime-model-catalog.ts`
- new provider/auth catalog adapter under `src/adapters/pi/`
- `src/main/local-api.ts`
- `src/main/electron-main.ts`
- renderer contracts and Settings flow
- `src/services/flue-cli-review-invoker.ts`
- `src/services/flue-cli-walkthrough-invoker.ts`
- associated catalog, API, invoker, lifecycle, and packaging tests
