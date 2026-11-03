---
name: needs-maintainer
include:
  - "src/**"
  - "package.json"
---

Flag changes that need the maintainer's decision before landing. Judge only the changed lines.

Questions:

1. Product defaults: does a changed constant, setting, feature flag, model, effort level, provider, timeout, limit or persisted-config default alter what users get without choosing? Examples live in `src/domain/insight-run-defaults.ts` and `src/domain/insight-provider-capabilities.ts`.
2. Suppressions: does the diff add `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `oxlint-disable`, `as any`, a non-null `!` to silence a type error, or a lint config relaxation?
3. Removed code: does the diff delete a function, route, fixture route, setting or branch that looks intentional (not dead from this change)? Fixture routes are kept on purpose.
4. Prompt changes: any edit to `src/domain/insight-output-guidance.ts`, `src/services/walkthrough-session-prompt.ts`, `src/services/native-explanation-prompt.ts`, `src/domain/local-draft-agent-prompt.ts`, `src/main/mcp/mcp-review-tools.ts`, `src/adapters/codex/codex-analysis-prompt.ts`, `src/adapters/codex/codex-brief-prompt.ts`, or `src/mcp/review-loop-instructions.ts`. AGENTS.md: prompt and schema changes are reviewed in chat first.
5. Schema changes: any edit to `src/services/codex-output-schema.ts`, `src/adapters/codex/codex-rpc-result-schema.ts`, `src/adapters/github/github-wire-schemas.ts`, `src/adapters/storage/review-remote-schemas.ts`, `src/adapters/storage/check-summary-schema.ts`, `src/mcp/tool-manifest.ts`, or any `*-contract.ts` / persisted record shape in `src/domain/` and `src/adapters/storage/`.
6. New dependencies in `package.json`.

Reply `All clear` if nothing applies. Otherwise one line per finding: `file:line — problem — minimal fix` (the fix is usually "get maintainer approval" or "revert").
