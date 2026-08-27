// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopResponse } from "../../src/main/ipc-contract";
import {
  useApiProbe,
  type ApiProbeState,
} from "../../src/renderer/src/hooks/use-api-probe";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

const PROBE_PATH = "/v1/probe";

type Deferred = {
  readonly promise: Promise<DesktopResponse>;
  readonly resolve: (value: DesktopResponse) => void;
};

function deferred(): Deferred {
  let resolve!: (value: DesktopResponse) => void;
  const promise = new Promise<DesktopResponse>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

/**
 * Installs a bridge whose responses this test drives one at a time. Returns
 * the spy so a test can assert how many requests actually went out.
 *
 * `/v1/logs` is answered without consuming a scripted response. The renderer
 * logs every `requestJson` call and `lib/logger.ts` flushes that queue
 * through this same bridge on a 300 ms timer, so a fixture that treated
 * every call alike would hand a probe's scripted response to a log flush,
 * and count log traffic as probe traffic.
 */
function installBridge(
  respond: (call: number) => Promise<DesktopResponse> | DesktopResponse,
): DesktopDouble {
  let call = 0;
  desktop = installDesktopDouble({
    "/v1/logs": () => success(null),
    [PROBE_PATH]: () => {
      call += 1;
      return respond(call);
    },
  });
  return desktop;
}

/** How many of the bridge's calls were this probe's own request. */
function probeCalls(double: DesktopDouble): number {
  return double.request.mock.calls.filter(
    ([input]) => "path" in input && input.path === PROBE_PATH,
  ).length;
}

let desktop: DesktopDouble | undefined;

// A parser that accepts `{ ok: true }` and rejects everything else, so a
// rejected body and a transport failure are distinguishable in the fixture
// even though the hook collapses them into the same state.
const probeSchema = v.object({ ok: v.literal(true) });

function parseProbe(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this stands in for a real response parser, which is handed the raw JSON body.
  value: unknown,
): "accepted" | undefined {
  return v.safeParse(probeSchema, value).success ? "accepted" : undefined;
}

const probe = { path: PROBE_PATH, restartKey: 0 } as const;

afterEach(() => {
  vi.restoreAllMocks();
  desktop?.restore();
  desktop = undefined;
});

describe("useApiProbe", () => {
  it("starts checking and resolves to the parsed value", async () => {
    installBridge(() => success({ ok: true }));
    const { result } = renderHook(() => useApiProbe(probe, parseProbe));

    expect(result.current).toEqual({ kind: "checking" });
    await waitFor(() =>
      expect(result.current).toEqual({ kind: "loaded", value: "accepted" }),
    );
  });

  it("fails the same way for a rejected body and a transport failure", async () => {
    installBridge(() => success({ unexpected: true }));
    const rejected = renderHook(() => useApiProbe(probe, parseProbe));
    await waitFor(() => expect(rejected.result.current.kind).toBe("error"));

    installBridge(() => failure({ error: "unavailable" }));
    const failed = renderHook(() => useApiProbe(probe, parseProbe));
    await waitFor(() => expect(failed.result.current.kind).toBe("error"));
  });

  it("sends the method the probe asks for, and a GET by default", async () => {
    const probeBridge = installBridge(() => success({ ok: true }));
    const { result } = renderHook(() =>
      useApiProbe(
        { path: "/v1/probe", method: "POST", restartKey: 0 },
        parseProbe,
      ),
    );
    await waitFor(() => expect(result.current.kind).toBe("loaded"));
    expect(probeBridge.request).toHaveBeenCalledWith({
      path: "/v1/probe",
      method: "POST",
    });

    const getProbe = installBridge(() => success({ ok: true }));
    const plain = renderHook(() => useApiProbe(probe, parseProbe));
    await waitFor(() => expect(plain.result.current.kind).toBe("loaded"));
    expect(getProbe.request).toHaveBeenCalledWith({ path: "/v1/probe" });
  });

  it("re-runs on a new restart key and returns to checking while it does", async () => {
    const first = deferred();
    const second = deferred();
    const probeBridge = installBridge((call) =>
      call === 1 ? first.promise : second.promise,
    );
    const { result, rerender } = renderHook(
      ({ restartKey }) =>
        useApiProbe({ path: "/v1/probe", restartKey }, parseProbe),
      { initialProps: { restartKey: 0 } },
    );

    await act(async () => {
      first.resolve(success({ ok: true }));
      await first.promise;
    });
    expect(result.current).toEqual({ kind: "loaded", value: "accepted" });

    rerender({ restartKey: 1 });
    expect(result.current).toEqual({ kind: "checking" });
    await act(async () => {
      second.resolve(success({ unexpected: true }));
      await second.promise;
    });
    expect(result.current).toEqual({ kind: "error" });
    expect(probeCalls(probeBridge)).toBe(2);
  });

  // `parse` is one of the effect's dependencies, which is why the hook's doc
  // comment requires callers to pass a stable one. Pinning the consequence
  // is what makes that requirement real: a new parser identity re-runs the
  // probe, so an inline parser would re-request on every render.
  it("re-runs when the parser identity changes", async () => {
    const probeBridge = installBridge(() => success({ ok: true }));
    const { result, rerender } = renderHook<
      ApiProbeState<"accepted">,
      { parse: typeof parseProbe }
    >(
      ({ parse }) => useApiProbe(probe, parse),
      // `vi.fn` wraps the same parser in a fresh identity each time, so
      // identity is the only variable across the renders below.
      { initialProps: { parse: vi.fn(parseProbe) } },
    );

    await waitFor(() => expect(result.current.kind).toBe("loaded"));
    expect(probeCalls(probeBridge)).toBe(1);

    // Same behaviour, new identity — the only thing that changed.
    rerender({ parse: vi.fn(parseProbe) });
    await waitFor(() => expect(probeCalls(probeBridge)).toBe(2));
    await waitFor(() =>
      expect(result.current).toEqual({ kind: "loaded", value: "accepted" }),
    );

    // Control: re-rendering with the same identity does not re-request.
    const stable = vi.fn(parseProbe);
    rerender({ parse: stable });
    await waitFor(() => expect(probeCalls(probeBridge)).toBe(3));
    rerender({ parse: stable });
    await waitFor(() => expect(result.current.kind).toBe("loaded"));
    expect(probeCalls(probeBridge)).toBe(3);
  });

  it("does not let a superseded response overwrite the newer one", async () => {
    const first = deferred();
    const second = deferred();
    installBridge((call) => (call === 1 ? first.promise : second.promise));
    const { result, rerender } = renderHook(
      ({ restartKey }) =>
        useApiProbe({ path: "/v1/probe", restartKey }, parseProbe),
      { initialProps: { restartKey: 0 } },
    );

    // Restart before the first request answers, then let the second land.
    rerender({ restartKey: 1 });
    await act(async () => {
      second.resolve(success({ ok: true }));
      await second.promise;
    });
    expect(result.current).toEqual({ kind: "loaded", value: "accepted" });

    // The abandoned first request answers late, and with a failure. It must
    // not pull the probe back out of its newer loaded state.
    await act(async () => {
      first.resolve(failure({ error: "unavailable" }));
      await first.promise;
    });
    expect(result.current).toEqual({ kind: "loaded", value: "accepted" });
  });

  // React silently discards a `setState` on an unmounted component, so the
  // rendered state cannot show whether the response was handled. The parser
  // can: the cleanup must stop the response short of it.
  it("does not touch a response that lands after unmount", async () => {
    const pending = deferred();
    installBridge(() => pending.promise);
    const parse = vi.fn(parseProbe);
    const { result, unmount } = renderHook(() => useApiProbe(probe, parse));

    unmount();
    await act(async () => {
      pending.resolve(success({ ok: true }));
      await pending.promise;
    });

    expect(parse).not.toHaveBeenCalled();
    expect(result.current).toEqual({ kind: "checking" });
  });

  // Control for the two tests above: with no restart and no unmount, the very
  // same fixture does run the parser and write the response through. Without
  // this, "the parser was not called" would pass for a hook that never
  // requested anything.
  it("parses and writes the response through when nothing supersedes it", async () => {
    const pending = deferred();
    installBridge(() => pending.promise);
    const parse = vi.fn(parseProbe);
    const { result } = renderHook(() => useApiProbe(probe, parse));

    expect(result.current).toEqual({ kind: "checking" });
    await act(async () => {
      pending.resolve(success({ ok: true }));
      await pending.promise;
    });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ kind: "loaded", value: "accepted" });
  });
});
