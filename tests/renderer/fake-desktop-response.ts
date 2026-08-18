import type { DesktopResponse } from "../../src/main/ipc-contract";

/**
 * Shared response builders for renderer tests that fake the desktop bridge
 * (`window.patchdesk.request`; see `PatchdeskDesktopApi` in
 * `src/main/ipc-contract.ts`). The return type is left to inference and
 * checked with `satisfies` rather than annotated, so callers keep the
 * literal `ok`/`status` values they narrow on instead of the widened
 * `DesktopResponse` shape.
 */

/** Builds a successful `DesktopResponse` carrying the given body. */
export function success<Body>(body: Body) {
  return {
    ok: true,
    status: 200,
    body,
    correlationId: "test",
  } satisfies DesktopResponse;
}

/** Builds a failed `DesktopResponse` carrying the given body. */
export function failure<Body>(body: Body, status = 503) {
  return {
    ok: false,
    status,
    body,
    correlationId: "test",
  } satisfies DesktopResponse;
}
