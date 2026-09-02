import { onTestFinished, vi, type Mock } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import type {
  DesktopMenuAction,
  DesktopRequest,
  DesktopResponse,
  LocalApiDesktopRequest,
  PatchdeskDesktopApi,
} from "../../src/main/ipc-contract";

/**
 * Shared response builders for renderer tests that fake the desktop bridge
 * (`window.patchdesk.request`; see `PatchdeskDesktopApi` in
 * `src/main/ipc-contract.ts`). The return type is left to inference and
 * checked with `satisfies` rather than annotated, so callers keep the
 * literal `ok`/`status` values they narrow on instead of the widened
 * `DesktopResponse` shape.
 */

/** Builds a successful `DesktopResponse` carrying the given body. */
export function success(body: RawJsonValue) {
  return {
    ok: true,
    status: 200,
    body,
    correlationId: "test",
  } satisfies DesktopResponse;
}

/** Builds a failed `DesktopResponse` carrying the given body. */
export function failure(body: RawJsonValue, status = 503) {
  return {
    ok: false,
    status,
    body,
    correlationId: "test",
  } satisfies DesktopResponse;
}

/** Privileged bridge operations, as opposed to loopback API paths. */
type DesktopOperationRequest = Exclude<DesktopRequest, LocalApiDesktopRequest>;

/** Answers one loopback API path. Receives the request the renderer sent. */
export type DesktopRoute = (
  input: LocalApiDesktopRequest,
) => DesktopResponse | Promise<DesktopResponse>;

/** Answers one privileged operation (`selectDirectory`, `setNavigationState`, …). */
export type DesktopOperationRoute = (
  input: DesktopOperationRequest,
) => DesktopResponse | Promise<DesktopResponse>;

/**
 * The bridge members a test may override, minus the three the double owns:
 * `request`, which the route table answers, and `onMenuAction` and
 * `onWindowFullScreen`, whose listeners `sendMenuAction` and
 * `sendWindowFullScreen` fire.
 */
export type DesktopDoubleExtras = Partial<
  Omit<PatchdeskDesktopApi, "request" | "onMenuAction" | "onWindowFullScreen">
> & {
  /** Routes for privileged operations, keyed by `operation`. */
  readonly operations?: Readonly<
    Partial<Record<DesktopOperationRequest["operation"], DesktopOperationRoute>>
  >;
};

export type DesktopDouble = {
  /** The bridge's `request`, so a test can assert the calls it received. */
  readonly request: Mock<(input: DesktopRequest) => Promise<DesktopResponse>>;
  /**
   * Fires the listener the renderer registered through `onMenuAction`, the
   * same way the native View menu does over IPC. A no-op when nothing has
   * subscribed.
   */
  readonly sendMenuAction: (action: DesktopMenuAction) => void;
  /**
   * Fires the listener the renderer registered through `onWindowFullScreen`,
   * the same way the main process does when the window enters or leaves
   * native full screen. A no-op when nothing has subscribed.
   */
  readonly sendWindowFullScreen: (fullScreen: boolean) => void;
  /**
   * Whether a full-screen listener is currently registered, so a test can
   * assert that a hook released its subscription instead of only asserting
   * that no further state arrived — React drops updates to an unmounted
   * component either way, which would let a missing cleanup pass.
   */
  readonly hasWindowFullScreenListener: () => boolean;
  /**
   * Drains the log of calls the double refused — see
   * `assertNoUnroutedDesktopCalls`. Taking a call accepts it: it no longer
   * fails the test. Use this only where leaving a path unrouted is the point
   * of the test, and assert on what comes back.
   */
  readonly takeUnroutedCalls: () => readonly string[];
  /** Removes the double from `window`. Call this in `afterEach`. */
  readonly restore: () => void;
};

/**
 * Installs `window.patchdesk` for one renderer test, answering each loopback
 * path from `routes` and each privileged operation from `extras.operations`.
 *
 * A path is matched exactly first, then by its pathname — the part before
 * `?` — so a table can answer either one specific query string
 * (`/v1/inbox?state=open&pageSize=25`) or every query on a path
 * (`/v1/inbox`). Anything the table does not name **throws**, naming the
 * path or operation: a route a test never declared is a route that test does
 * not actually cover, and a double that quietly answered it would let the
 * test pass on traffic nobody scripted. The one exception is the renderer's
 * own log flush, `POST /v1/logs`, answered with `success(null)` unless the
 * table routes `/v1/logs` itself — see `answerPath`.
 *
 * `openExternalHttps` throws for the same reason unless `extras` supplies it,
 * so a test that opens an external link it did not expect fails loudly.
 *
 * The throw alone is not enough, because every caller of the bridge wraps it
 * in its own `try`/`catch`: a test asserting an error state would otherwise
 * pass on the double's throw instead of the failure it scripted. So each
 * refusal is also logged out of band and checked by
 * `assertNoUnroutedDesktopCalls`, which product code cannot catch — see
 * that function.
 */
export function installDesktopDouble(
  routes: Readonly<Record<string, DesktopRoute>>,
  extras: DesktopDoubleExtras = {},
): DesktopDouble {
  let menuActionListener: ((action: DesktopMenuAction) => void) | undefined;
  let windowFullScreenListener: ((fullScreen: boolean) => void) | undefined;
  const unrouted: string[] = [];
  const refuse = (description: string, remedy: string): never => {
    unrouted.push(description);
    throw new Error(`Unrouted desktop call: ${description}. ${remedy}`);
  };
  assertNoUnroutedDesktopCalls(unrouted);
  const request = vi.fn(
    async (input: DesktopRequest): Promise<DesktopResponse> => {
      if ("operation" in input)
        return await answerOperation(extras, input, refuse);
      return await answerPath(routes, input, refuse);
    },
  );
  const api: PatchdeskDesktopApi = {
    request,
    openExternalHttps:
      extras.openExternalHttps ??
      ((url: string): Promise<boolean> =>
        refuse(
          `openExternalHttps ${url}`,
          "Pass openExternalHttps in the double's extras to allow it.",
        )),
    onMenuAction: (listener: (action: DesktopMenuAction) => void) => {
      menuActionListener = listener;
      return () => {
        menuActionListener = undefined;
      };
    },
    onWindowFullScreen: (listener: (fullScreen: boolean) => void) => {
      windowFullScreenListener = listener;
      return () => {
        windowFullScreenListener = undefined;
      };
    },
    windowFullScreenAtLoad: extras.windowFullScreenAtLoad ?? false,
    qaScrollDiagnosticsEnabled: extras.qaScrollDiagnosticsEnabled ?? false,
  };
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: api,
  });
  return {
    request,
    sendMenuAction: (action) => menuActionListener?.(action),
    sendWindowFullScreen: (fullScreen) =>
      windowFullScreenListener?.(fullScreen),
    hasWindowFullScreenListener: () => windowFullScreenListener !== undefined,
    takeUnroutedCalls: () => unrouted.splice(0),
    restore: () => {
      Reflect.deleteProperty(window, "patchdesk");
    },
  };
}

/**
 * Fails the running test if the double refused any call it was not scripted
 * to answer.
 *
 * The refusal itself is a thrown `Error`, which every bridge caller in the
 * renderer already catches: `runCleanup`, `saveProfile`,
 * `loadGlobalPreferences` and `useApiProbe` all turn a rejected request into
 * the product's ordinary error state. A test asserting that error state would
 * therefore go green on the double's own throw rather than on the failure it
 * scripted — the negative-path test would keep passing after the behaviour it
 * guards is broken. The log below runs outside every one of those `catch`
 * blocks, in a `onTestFinished` callback vitest invokes after the test and its
 * `afterEach` hooks, so no product code can absorb it.
 *
 * A test that means to leave a path unrouted accepts it explicitly with
 * `takeUnroutedCalls()`.
 */
function assertNoUnroutedDesktopCalls(unrouted: readonly string[]): void {
  onTestFinished(() => {
    if (unrouted.length === 0) return;
    throw new Error(
      `The desktop double refused ${unrouted.length} call(s) this test did not route: ${unrouted.join("; ")}. ` +
        "The test passed anyway, so product code caught the refusal and treated it as its own error. " +
        "Route the call, or accept it with takeUnroutedCalls() if the miss is the point of the test.",
    );
  });
}

/** The path `lib/logger.ts` flushes the renderer log queue to. */
const LOG_FLUSH_PATH = "/v1/logs";

async function answerPath(
  routes: Readonly<Record<string, DesktopRoute>>,
  input: LocalApiDesktopRequest,
  refuse: (description: string, remedy: string) => never,
): Promise<DesktopResponse> {
  const route =
    routes[input.path] ?? routes[input.path.split("?")[0] ?? input.path];
  if (route !== undefined) return await route(input);
  // The renderer's 300 ms log flush lands inside a test by timing, not by
  // script, so refusing it only made slow runs red.
  if (input.method === "POST" && input.path === LOG_FLUSH_PATH)
    return success(null);
  return refuse(
    `${input.method ?? "GET"} ${input.path}`,
    "Add it to the test's route table.",
  );
}

async function answerOperation(
  extras: DesktopDoubleExtras,
  input: DesktopOperationRequest,
  refuse: (description: string, remedy: string) => never,
): Promise<DesktopResponse> {
  const route = extras.operations?.[input.operation];
  if (route === undefined) {
    return refuse(
      `operation ${input.operation}`,
      "Add it to the double's extras.operations.",
    );
  }
  return await route(input);
}
