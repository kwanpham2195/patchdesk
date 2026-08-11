---
created_at: 2026-08-04
repos:
  - patchdesk
status: complete
spec: .agents/tasks/unified-review-workbench/research/04-research-non-oauth-provider-support.md
---

# Non-OAuth provider support plan

## Goal

Make every built-in Pi/Flue provider that authenticates by environment API key or ambient machine credentials available to Patchdesk Review and Insight runs. Never expose, copy, or persist a credential. OAuth-only providers are intentionally excluded.

## Contract

- Include built-in non-OAuth provider families: API-key providers plus Amazon Bedrock ambient AWS credentials and Google Vertex ADC.
- Exclude OpenAI Codex, Anthropic subscription OAuth, GitHub Copilot, and Cloudflare Workers AI binding.
- Provider availability is a local, redacted configuration check—not a network, paid, or authentication probe.
- Provider discovery, eligibility, and credential-source checks stay in the Electron main process. The renderer receives only canonical model IDs and bounded status/guidance.
- Built-in allowlist only. Do not execute, import, or trust arbitrary custom-provider definitions, headers, commands, or credentials.
- Keep Flue at `1.0.0-beta.9`. Flue 2 migration is a separate rewrite.
- Existing shell-free invokers, lifecycle cancellation, revision validation, safe failure persistence, and GitHub-write policy remain unchanged.

## Milestones

### 1. Define a safe provider catalog

- Add `src/adapters/pi/pi-provider-catalog.ts`.
- Model each allowlisted provider’s canonical ID, non-secret setup source label, environment-key requirements, and ambient checks.
- Check only exact named variables and narrow AWS/Vertex metadata/files. Do not enumerate the environment, invoke a CLI, send a request, or read credential values.
- Update `src/adapters/pi/pi-runtime-model-catalog.ts` to enumerate every model from the installed compatible pi-ai catalog for the fixed allowlist, preserve Pi settings only for ordering/default preference, canonicalize `provider/model` IDs, and omit ineligible/unconfigured/OAuth models.
- Add deterministic adapter matrix tests for every provider family, blank values, Bedrock, Vertex ADC, canonicalization, deduplication, OAuth exclusion, custom-provider exclusion, and secret redaction.

**Acceptance:** an eligible catalog entry has a canonical allowlisted provider/model ID and a redacted local configuration source; no test uses a real credential, CLI, network, or paid request.

### 2. Make the local API authoritative

- Inject one shared catalog instance through `src/main/electron-main.ts` into the local API, `ReviewExecutionService`, and `InsightRunCoordinator`.
- Extend `src/main/local-api.ts` model and environment projections with safe provider availability/setup guidance.
- Restrict `GET /v1/reviews/models` to eligible configured models. Server-side validation remains authoritative if renderer state becomes stale.
- Replace the existing four-key environment heuristic with the catalog summary.
- Update local API/browser tests to reject OAuth, custom, unavailable, and malformed models, and prove no secret or full environment data reaches the bridge.

**Acceptance:** a renderer cannot cause an OAuth-only, custom, unavailable, or malformed model to create a Review attempt or Insight run.

### 3. Update Settings and Insight model selection

- Extend strict renderer contracts with bounded provider identity and safe availability/guidance fields.
- Update `settings-flow.tsx` to show eligible models only and explain unavailable configuration without displaying a key, path, OAuth token, or raw provider error.
- Update `review-workbench-flow.tsx` and any reachable walkthrough-controller path to use the canonical catalog; disable run controls with clear “no eligible model configured” guidance.
- Preserve a saved preference when it later becomes unavailable, but never present it as executable.
- Add renderer tests for available choices, unavailable guidance, disabled runs, preference preservation, and redaction.

**Acceptance:** the renderer makes no authentication decision and no unavailable model is selectable.

### 4. Preserve execution and lifecycle invariants

- Confirm `review-execution-service.ts` and `insight-run-coordinator.ts` validate against the shared catalog immediately before allocating work.
- Retain fixed Flue CLI argv, `shell: false`, owned cancellation, timeouts, schema validation, revision checks, and safe redacted failure storage in both invokers.
- Add tests proving rejected models do not allocate attempts, replace a retained result, alter cancellation/recovery, or affect publication authorization.
- Keep provider failures as allowlisted safe categories only; never persist stderr, provider response bodies, credentials, or paths.

**Acceptance:** provider support cannot weaken Review, Insight, publication, or recovery safety.

### 5. Package and document the boundary

- Retain the beta.9 pins in `package.json` and reject unintended Flue 2 resolution in `pnpm-lock.yaml`.
- Verify `scripts/stage-flue-runtime.mjs` maintains the required beta.9 runtime closure.
- Extend package smoke and desktop-hardening tests for an isolated/no-credential profile: app starts, returns redacted model state, and performs no provider probe.
- Keep the repository rule in `AGENTS.md` current: non-OAuth built-ins only; main-process-only redacted discovery; no credential persistence, full environment reads, custom-provider execution, provider probes, or Flue 2 migration inside this work.

**Acceptance:** packaged Patchdesk starts safely without any configured provider and never treats missing credentials as a crash.

### 6. Verification

1. Focused adapter, API, renderer, execution, invoker, coordinator, staging, and smoke tests.
2. Full gates: `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run`, `pnpm build`.
3. Package proof: `pnpm package:mac` and package smoke.
4. Independent reviewer validates the provider/credential boundary.
5. Dedicated `$patchdesk-electron-tester` QA verifies configured API-key, unavailable/ambient guidance, OAuth exclusion, cancellation, no secrets in UI/devtools, and no provider/network probe at catalog load. No real model run or GitHub write during QA.

## Evidence

- Milestone 1: `src/adapters/pi/pi-provider-catalog.ts` and `src/adapters/pi/pi-runtime-model-catalog.ts` now use an explicit non-OAuth provider allowlist, exact environment checks, bounded ambient AWS/Vertex checks, and redacted status projections. The runtime catalog enumerates the complete static model set from the pinned pi-ai catalog, applies Pi settings only as preference ordering/default, and filters by configured providers. Deterministic matrix coverage is in `tests/adapters/pi-provider-catalog.test.ts` and `tests/adapters/pi-runtime-model-catalog.test.ts`.
- Milestone 2: Local API model responses include only eligible models plus bounded provider status; the Electron composition root passes one shared catalog to Review and Insight services.
- Milestone 3: Settings and Insight selection show unavailable configuration guidance and keep saved preferences without making unavailable models executable.
- Milestone 4: Review and Insight services revalidate canonical eligible models immediately before durable work allocation; existing lifecycle and invoker boundaries remain unchanged.
- Milestone 5: beta.9 package closure remains intact; `pnpm package:mac` and `pnpm test:package-smoke` passed without provider or network execution.
- Milestone 6: focused and full verification passed; independent review remains a required follow-up gate.

## Risks and controls

- **Electron environment inheritance:** Finder launches may not receive terminal exports. Availability reports the Electron process only and never claims that a configured value guarantees access.
- **Ambient-auth false positives:** AWS/ADC presence is configuration evidence, not an entitlement or connectivity probe.
- **Catalog drift:** use explicit bounded provider definitions and matrix tests rather than arbitrary Pi settings/config execution. The direct `@earendil-works/pi-ai@0.80.7` dependency remains pinned alongside Flue beta.9 so the typed built-in catalog stays compatible.
- **Credential leakage:** treat settings, diagnostics, API responses, test fixtures, support bundles, and renderer props as redaction boundaries.
- **Flue scope creep:** do not upgrade to Flue 2; its removed workflow/CLI APIs require separate design and migration work.
