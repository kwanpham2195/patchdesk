---
created_at: 2026-08-11
repos:
  - patchdesk
  - backnotprop/plannotator
status: research-complete
---

# Plannotator Codex app-server research

## Question

How does Plannotator use `codex app-server`, and can Patchdesk use that pattern to reuse a person's existing Codex/ChatGPT subscription login?

## Sources read

- `.agents/archive/plannotator-markdown-mermaid-research/01-research-plannotator-markdown-mermaid.md`
- `https://github.com/backnotprop/plannotator`, cached through `$librarian` at `/Users/kwanpham/.cache/checkouts/github.com/backnotprop/plannotator`
  - Snapshot: `ab8d2581eb49803d8210e6bfcef41b6d583de1a8` (2026-08-10)
  - `packages/ai/providers/codex-app-server.ts`
  - `packages/server/ai-runtime.ts`
  - `apps/pi-extension/server/ai-runtime.ts`
  - `packages/ui/hooks/useAIProviderActivation.ts`
  - `packages/ai/endpoints.ts`
  - `packages/ai/ai.test.ts`
  - `packages/server/ai-runtime.test.ts`
  - `packages/ai/types.ts`

## Findings

### Authentication: delegated to the local Codex CLI

Plannotator does not implement an OAuth flow, store an API key, read `CODEX_HOME`, or inspect any credential file. Its runtime adds Codex only when `Bun.which("codex")` finds the executable (`packages/server/ai-runtime.ts:44-62`; its Pi extension does the equivalent with `which`, `apps/pi-extension/server/ai-runtime.ts:54-75`).

The app subsequently launches that executable as `codex app-server`. Therefore Codex itself reads and refreshes the existing local account state. Plannotator's only user-facing authentication guidance is the startup error instructing the user to run `codex login` (`packages/ai/providers/codex-app-server.ts:712-720`). This is the key point for subscription reuse: it is an indirect reuse of the same CLI login, not an in-app subscription login.

### Transport and lifecycle

One provider session owns a long-lived `codex app-server` child process. It starts with piped stdin/stdout and ignored stderr, then performs the JSON-RPC `initialize` request and `initialized` notification (`packages/ai/providers/codex-app-server.ts:316-377`). JSON-RPC messages are newline-delimited; the implementation protects UTF-8 chunk boundaries, distinguishes responses, server requests, and notifications by shape, and limits ordinary RPC responses to 30 seconds (`:391-464`).

A new session uses `thread/start`, then `turn/start` for each prompt. The provider streams text and tool events to the UI from notifications. It supports resume through `thread/resume`, although a resume failure starts a new backend thread while retaining the client session ID (`:866-910`). It sends `turn/interrupt` on cancellation and kills idle child processes after 10 minutes while keeping a thread ID for later resume (`:920-984`).

### Safety and approvals

Plannotator starts threads with the selected model, working directory, and `sandbox: "read-only"`. It deliberately omits `approvalPolicy`, so Codex uses the user's and organization's configured policy (`packages/ai/providers/codex-app-server.ts:1-25, 866-873`). This replaced its former headless `codex exec` transport, which hard-coded `approval_policy = never` and could not surface interactive approvals.

Server-to-client command and file-change approval requests become existing Allow/Deny UI cards and are answered as JSON-RPC `accept` or `decline` (`:770-800, 913-918`). Permission-profile escalation for additional network or filesystem access is always rejected with an empty permission set (`:770-779`). Thus subscription reuse does not itself grant broader local access.

### Provider discovery and models

Plannotator avoids launching Codex during a passive provider/capability check. On an explicit user action or session creation, it starts a throwaway app-server and calls paginated `model/list`, retaining a static model fallback if that fails (`packages/ai/providers/codex-app-server.ts:541-594`; `packages/ui/hooks/useAIProviderActivation.ts:4-18`). The runtime test confirms that capability discovery does not execute Codex but activation/session creation does (`packages/server/ai-runtime.test.ts:18-125`).

The provider advertises streaming, tools, and resume but not session forking (`packages/ai/providers/codex-app-server.ts:518-525`). Models and supported reasoning effort levels come from `model/list`, rather than an application-maintained catalog.

### Test coverage

The repository tests JSON-RPC classification, stream event mapping, error propagation, and approval mapping (`packages/ai/ai.test.ts:1250-1416`). Its runtime tests cover lazy executable activation. It does not provide an end-to-end fake app-server test for the full initialize/thread/turn/approval lifecycle.

## Implications for Patchdesk

The suitable pattern is a trusted-main-process adapter that invokes a user-selected or discovered `codex` executable and communicates via stdio JSON-RPC. The sandboxed renderer must only receive a narrow local API: provider availability, model list, session and turn state, streamed redacted events, and approval decisions. It must never receive credentials, a raw Codex home path, or process handles.

The adapter should inherit the normal desktop user's environment so the Codex CLI can use the login it already owns. It should not copy, parse, persist, or offer an in-app alternative for Codex credentials. For compiled desktop installations, provide an explicit executable-path selection rather than relying on PATH alone; Plannotator's type exposes this same configuration seam (`packages/ai/types.ts:289-302`).

## Risks and open questions

- Electron's packaged-main-process environment may not preserve the PATH, home directory, or OS credential/keychain access that the user's working Codex CLI expects.
- PATH-only detection and swallowed model-discovery errors can present an installed but unauthenticated CLI as usable until a real query starts.
- Discarded stderr reduces useful diagnostics for CLI installation and login failures; Patchdesk should capture and redact bounded diagnostic output in the trusted process.
- Reusing an existing subscription login must be verified on the actual supported Codex CLI versions and operating systems; this source inspection did not run a login or inspect local credentials.
- If Patchdesk's intended surface is strictly read-only review assistance, retain a read-only Codex sandbox and default-deny permission-profile escalation. Any broader tool policy needs a separately approved product and security contract.

No implementation was performed.
