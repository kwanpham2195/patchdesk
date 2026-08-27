import { useEffect, useState } from "react";

import { requestJson } from "../api-client";
import {
  parseEnvironmentCheckResponse,
  type EnvironmentCheckResponse,
} from "../renderer-contracts";

/**
 * One read-only status request, as every setup probe in the renderer models
 * it: in flight, resolved with a parsed value, or failed.
 *
 * A transport failure and a response the parser rejects are the same `error`.
 * None of the probes this serves distinguishes them, and none surfaces the
 * failure's detail — the thrown `PatchdeskApiError` and its `safeMessage`
 * copy are deliberately dropped, because each probe words its own failure
 * line for the screen it sits on.
 */
export type ApiProbeState<Value> =
  | { readonly kind: "checking" }
  | { readonly kind: "loaded"; readonly value: Value }
  | { readonly kind: "error" };

type ApiProbe = {
  readonly path: string;
  /** Defaults to a GET. */
  readonly method?: "POST";
  /**
   * Re-runs the probe whenever this changes: a retry counter behind a
   * Re-check button, or a key derived from the data being described.
   */
  readonly restartKey: string | number;
};

/**
 * Runs one API probe on mount and again on every `restartKey` change, and
 * keeps its state.
 *
 * A restarted probe cannot be overwritten by the request it replaced: the
 * superseded effect's cleanup drops its own result. The request itself is not
 * aborted, so an abandoned probe still completes server-side.
 *
 * `parse` must be stable across renders — a module-level parser, or a
 * `useCallback` — because it is one of the effect's dependencies.
 */
export function useApiProbe<Value>(
  probe: ApiProbe,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- `parse` IS the boundary parser for this probe's response; it is handed the raw JSON body, which is unknown until it runs.
  parse: (value: unknown) => Value | undefined,
): ApiProbeState<Value> {
  const { path, method, restartKey } = probe;
  const [state, setState] = useState<ApiProbeState<Value>>({
    kind: "checking",
  });

  useEffect(() => {
    let active = true;
    setState({ kind: "checking" });
    void (async () => {
      try {
        const value = await requestJson(
          path,
          method === undefined ? {} : { method },
        );
        if (!active) return;
        const parsed = parse(value);
        setState(
          parsed === undefined
            ? { kind: "error" }
            : { kind: "loaded", value: parsed },
        );
      } catch {
        if (active) setState({ kind: "error" });
      }
    })();
    return () => {
      active = false;
    };
  }, [path, method, restartKey, parse]);

  return state;
}

/**
 * The `GET /v1/environment` probe, shared by the inbox setup checklist and
 * the Reviewing-as panel in Settings.
 *
 * The two run independently — separate components, separate Re-check buttons,
 * never mounted together — and each words its own copy from a different slice
 * of the response, so this shares the request and the state machine, not a
 * cache or a result.
 */
export function useEnvironmentCheck(
  restartKey: number,
): ApiProbeState<EnvironmentCheckResponse> {
  return useApiProbe(
    { path: "/v1/environment", restartKey },
    parseEnvironmentCheckResponse,
  );
}
