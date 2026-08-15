// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  PatchdeskApiError,
  requestJson,
} from "../../src/renderer/src/api-client";

afterEach(() => {
  Reflect.deleteProperty(window, "patchdesk");
});

describe("renderer API boundary", () => {
  it("rejects a failed bridge response with its status and structured body", async () => {
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: {
        request: async () => ({
          ok: false,
          status: 409,
          body: { error: "refresh_failed", retryable: true },
          correlationId: "corr-refresh",
        }),
        openExternalHttps: async () => false,
        onNavigate: () => () => undefined,
        qaScrollDiagnosticsEnabled: false,
      },
    });

    let thrown: unknown;
    try {
      await requestJson("/v1/inbox");
    } catch (cause: unknown) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(PatchdeskApiError);
    if (!(thrown instanceof PatchdeskApiError)) return;
    expect(thrown.status).toBe(409);
    expect(thrown.responseBody).toEqual({
      error: "refresh_failed",
      retryable: true,
    });
  });
});
