---
created_at: 2026-08-08
repos: [patchdesk]
status: completed
---

# Unified log / trace stream (tail backend + frontend)

User need: tail every action across main process and renderer. Today there is no
logger at all; only the bounded, redacted `ReviewDiagnosticService` (shared-evidence
channel). This adds a separate local debug log stream.

## Design decisions (user confirmed via recommendation defaults; interview UI failed, assumptions stated)

- Surfaces: JSONL file under `<dataDir>/logs/patchdesk.jsonl` (tail -f) + in-app
  Settings -> Logs panel (polling tail) + dev stdout mirror when unpackaged or
  `--patchdesk-tail-logs`.
- Detail: every bridge/API request as method + path + status + durationMs +
  correlationId (no bodies); workflow lifecycle milestones + failure reason;
  renderer console.error/warn + window error/unhandledrejection + React boundary
  errors. No request/response bodies.
- Flue subprocess raw output stays inside `CommandRunner` (existing boundary
  decision); log only reasons + durations.
- Crash gaps fixed: main `uncaughtException`/`unhandledRejection` recorded before
  exit; `render-process-gone`/`unresponsive` recorded.
- Redaction: local debug log is machine-local, so inline-mask secrets (tokens,
  Authorization values, sensitive meta keys dropped) but KEEP paths/errors/stacks
  (unlike diagnostics' whole-line rejection).

## Architecture

- `src/domain/log-entry.ts`: schema (schemaVersion 1, seq, at, process
  main|renderer, level debug|info|warn|error, topic <=48, message <=512,
  optional meta/profileId/sessionId/attemptId/correlationId), normalize
  (truncate + inline redact + drop sensitive meta keys), parse on read.
- `src/services/app-log-service.ts`: in-memory ring buffer (2000), seq counter,
  append JSONL with size rotation (5 MB, keep 3), optional stdout mirror,
  `tail(after?, limit?)`, best-effort writes (never throw into app flows).
- `src/main/local-api.ts`: construct/accept LogService; HTTP middleware logging
  every response (skip /health, /v1/logs); routes `GET /v1/logs?after&limit`,
  `POST /v1/logs` (renderer entries, validated + seq assigned in main).
- `src/main/desktop-bridge.ts`: allowlist both routes.
- `src/main/electron-main.ts`: construct LogService (stdout mirror in dev);
  crash handlers; render-process-gone/unresponsive logging; workflow invoker
  milestones; diagnostics mirror hook.
- `src/services/review-diagnostic-service.ts`: optional `mirror` constructor
  option (diagnostics events also appear in the log stream).
- Renderer: `src/renderer/src/lib/logger.ts` (batched forwarding, console
  capture, window error hooks); instrument `api-client.ts` requestJson +
  selectDirectory (skip /v1/logs to avoid loops); Settings `logs` section +
  `LogsPanel` component (poll after=seq, filters, auto-scroll, pause).

## Tests

- domain log-entry: redaction (mask, not reject), sensitive key drop, truncation.
- app-log-service: seq, ring cap, rotation, tail semantics, write failure tolerated.
- local-api: GET/POST /v1/logs auth + validation; bridge allowlist entries.
- Existing suites must stay green (diagnostics mirror is optional param).

## Verification

pnpm lint / typecheck / test -- --run; manual `pnpm dev` tail of stdout mirror;
playwright smoke only if panel touches browser tests.

## Out of scope

- Raw Flue subprocess streaming (CommandRunner boundary; revisit separately).
- Remote/aggregated telemetry (local-first).
