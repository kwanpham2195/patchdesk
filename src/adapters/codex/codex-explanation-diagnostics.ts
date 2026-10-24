import type { LogEntryInput, LogMetaInput } from "#src/domain/log-entry";
import type { ExplanationProducerOutcome } from "#src/services/explanation-producer";
import { definedProps } from "#src/domain/defined-props";

type Codes = {
  finish_accepted: "finish_signal";
  provider_completed_without_finish: "bound_completion";
  host_refusal:
    | "admission_halted"
    | "turn_notification_invalid"
    | "turn_notification_overflow"
    | "turn_notification_mismatch"
    | "thread_identity_invalid"
    | "turn_identity_invalid"
    | "turn_artifact_invalid"
    | "queued_turn_mismatch"
    | "rpc_id_invalid"
    | "rpc_method_missing"
    | "rpc_id_stale"
    | "rpc_replay_conflict"
    | "rpc_replay_evicted"
    | "request_limit"
    | "params_invalid"
    | "thread_unbound"
    | "thread_mismatch"
    | "turn_mismatch"
    | "tool_not_allowed"
    | "arguments_limit"
    | "queue_full"
    | "frame_limit"
    | "call_limit"
    | "guide_frame_invalid"
    | "walkthrough_frame_invalid"
    | "reply_limit";
  transport_lost:
    | "stdin_error"
    | "process_error"
    | "process_exit"
    | "stream_limit"
    | "dynamic_request_limit"
    | "envelope_invalid"
    | "decode_or_route_threw";
  abort_observed: "signal_aborted";
  deadline_observed: "deadline_elapsed";
  start_unresolved:
    | "start_rpc_failed"
    | "start_response_invalid"
    | "start_binding_mismatch"
    | "start_commit_unknown";
  observation_unknown: "lifecycle_observe_failed";
  execution_unknown:
    | "execution_threw"
    | "tool_callback_threw"
    | "tool_effect_unknown"
    | "tool_outcome_invalid";
  preflight_refused:
    | "prompt_limit"
    | "home_prepare"
    | "discovery"
    | "connection_start"
    | "version"
    | "policy"
    | "models"
    | "thread_start"
    | "thread_binding"
    | "home_changed"
    | "admission_halted"
    | "start_commit_refused";
  unclassified: "no_trigger";
  cleanup:
    | "interrupt_attempted"
    | "observation_failed"
    | "tool_effect_unknown"
    | "process_stop_failed"
    | "home_cleanup_failed"
    | "process_exit"
    | "stdin_error"
    | "process_error";
  rpc_detail:
    | "pipes_missing"
    | "spawn_or_initialize_threw"
    | "request_unavailable"
    | "request_aborted"
    | "request_timeout"
    | "request_stopped"
    | "remote_rpc_error"
    | "rpc_result_invalid";
};
/** Closed callback vocabulary; raw provider data never enters the recorder. */
export type CodexDiagnostic = {
  [K in keyof Codes]: readonly [K, Codes[K]];
}[keyof Codes];
/** Only already-classified enums and measured counters may accompany observations. */
export type CodexDiagnosticFields = {
  readonly rpcIdKind?:
    | "valid_number"
    | "string"
    | "invalid_number"
    | "missing"
    | "other";
  readonly namespaceKind?: "null" | "missing" | "string" | "other";
  readonly binding?:
    | "unbound"
    | "thread_mismatch"
    | "turn_mismatch"
    | "matched"
    | "unparsed";
  readonly bytes?: number;
  readonly queued?: number;
  readonly active?: number;
  readonly seen?: number;
  readonly cached?: number;
  readonly exit?: "zero" | "nonzero" | "none" | "unknown";
  readonly signal?:
    | "none"
    | "sigint"
    | "sigterm"
    | "sigkill"
    | "other"
    | "unknown";
};
/** Synchronous, best-effort delivery to the existing local logger. */
export type CodexDiagnosticSink = (entry: LogEntryInput) => void;
/** Observers receive no RPC identities, payloads, or error objects. */
export type CodexDiagnosticObserver = (
  event: CodexDiagnostic,
  fields?: CodexDiagnosticFields,
) => void;
type Phase = "preflight" | "running" | "cleanup";
type FinalFields = {
  readonly triggerOrder: number | undefined;
  readonly result: "finished" | "failed";
  readonly effect: "known" | "unknown";
  readonly cessation: "confirmed" | "unknown";
  readonly homeCleanup: "not_attempted" | "succeeded" | "failed";
};
const bounded = (value: number | undefined, max: number) =>
  value === undefined
    ? undefined
    : Math.min(max, Math.max(0, Math.trunc(value) || 0));

/** Records host callback order, never provider chronology or root cause. */
export class CodexExplanationDiagnostics {
  private order = 0;
  private saturated = false;
  private overflow = false;
  private final = false;
  private trigger:
    | { readonly event: CodexDiagnostic; readonly order: number }
    | undefined;
  private secondary: CodexDiagnostic | undefined;
  private cleanupRecorded = false;
  /** Session phase changes do not change a latched trigger. */
  phase: Phase = "preflight";
  constructor(
    private readonly kind: "guide" | "walkthrough",
    private readonly connection: string,
    private readonly sink?: CodexDiagnosticSink,
  ) {}

  /** Latches synchronously before callers resolve, close, interrupt, or stop. */
  observe(
    event: CodexDiagnostic,
    fields: CodexDiagnosticFields = {},
    phase = this.phase,
    secondaryOnly = false,
  ): void {
    if (this.final) return;
    if (this.order === 65535) this.saturated = true;
    else this.order++;
    if (event[0] === "cleanup" && !secondaryOnly) {
      if (this.cleanupRecorded) {
        this.overflow = true;
        return;
      }
      this.cleanupRecorded = true;
      this.emit("cleanup", event, fields, phase);
    } else if (phase === "cleanup") {
      this.overflow = true;
    } else if (
      event[0] !== "rpc_detail" &&
      !secondaryOnly &&
      this.trigger === undefined
    ) {
      this.trigger = { event, order: this.order };
      this.emit("trigger", event, fields, phase);
    } else if (
      this.trigger?.event[0] === event[0] &&
      this.trigger.event[1] === event[1]
    ) {
      this.overflow = true;
    } else if (this.secondary === undefined) {
      this.secondary = event;
      this.emit("secondary", event, fields, phase);
    } else this.overflow = true;
  }

  /** Final outcome follows cleanup; subsequent callbacks cannot emit. */
  finish(
    result: ExplanationProducerOutcome,
    cessation: boolean,
    homeCleanup: "not_attempted" | "succeeded" | "failed",
  ): void {
    if (this.final) return;
    if (this.order === 65535) this.saturated = true;
    else this.order++;
    this.final = true;
    this.emit(
      "final",
      this.trigger?.event ?? ["unclassified", "no_trigger"],
      {},
      this.phase,
      {
        triggerOrder: this.trigger?.order,
        result: result._tag,
        effect:
          result._tag === "finished" || result.effectKnown
            ? "known"
            : "unknown",
        cessation: cessation ? "confirmed" : "unknown",
        homeCleanup,
      },
    );
  }

  private emit(
    event: "trigger" | "secondary" | "cleanup" | "final",
    pair: CodexDiagnostic,
    fields: CodexDiagnosticFields,
    phase: Phase,
    finalFields?: FinalFields,
  ): void {
    const required = {
      event,
      order: this.order,
      phase,
      kind: this.kind,
      category: pair[0],
      code: pair[1],
    };
    let meta: LogMetaInput = {
      ...required,
      orderSaturated: this.saturated || undefined,
      overflow: this.overflow || undefined,
      rpcIdKind: fields.rpcIdKind,
      namespaceKind: fields.namespaceKind,
      binding: fields.binding,
      bytes: bounded(fields.bytes, 8388609),
      queued: bounded(fields.queued, 16),
      active: bounded(fields.active, 1),
      seen: bounded(fields.seen, 256),
      cached: bounded(fields.cached, 16),
      exit: fields.exit,
      signal: fields.signal,
      triggerOrder: finalFields?.triggerOrder,
      result: finalFields?.result,
      effect: finalFields?.effect,
      cessation: finalFields?.cessation,
      homeCleanup: finalFields?.homeCleanup,
    };
    let correlationId = /^[A-Za-z0-9_-]{8,64}$/.test(this.connection)
      ? this.connection
      : undefined;
    const project = (): LogEntryInput => ({
      process: "main",
      level: "info",
      topic: "native-explanation-diagnostic",
      message: "Native explanation diagnostic",
      ...definedProps({ correlationId }),
      meta,
    });
    let entry = project();
    if (Buffer.byteLength(JSON.stringify(entry)) + 1 > 1536) {
      this.overflow = true;
      meta = {
        ...required,
        overflow: true,
        triggerOrder: finalFields?.triggerOrder,
      };
      entry = project();
      if (Buffer.byteLength(JSON.stringify(entry)) + 1 > 1536) {
        correlationId = undefined;
        entry = project();
      }
    }
    if (Buffer.byteLength(JSON.stringify(entry)) + 1 > 1536) {
      this.overflow = true;
      return;
    }
    try {
      this.sink?.(entry);
    } catch {
      this.overflow = true;
    }
  }
}
