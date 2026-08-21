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

  it("classifies a forbidden write as its own 'forbidden' kind, not the generic 'auth' bucket a bare 403 status would otherwise produce", async () => {
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: {
        request: async () => ({
          ok: false,
          status: 403,
          body: { error: "forbidden" },
          correlationId: "corr-forbidden",
        }),
        openExternalHttps: async () => false,
        onNavigate: () => () => undefined,
        qaScrollDiagnosticsEnabled: false,
      },
    });

    let thrown: unknown;
    try {
      await requestJson("/v1/pending-review");
    } catch (cause: unknown) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(PatchdeskApiError);
    if (!(thrown instanceof PatchdeskApiError)) return;
    expect(thrown.kind).toBe("forbidden");
    expect(thrown.status).toBe(403);
    // Honest, reason-classified copy — never GitHub's raw message text, and
    // never a retry-implying claim for a condition retrying cannot fix.
    expect(thrown.message).toContain("Retrying will not help");
    expect(thrown.message).not.toMatch(/try again|retry the/i);
  });

  it("classifies a rejected assignee write as its own 'assignee_cap_exceeded' kind, stating the limit is ten", async () => {
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: {
        request: async () => ({
          ok: false,
          status: 400,
          body: { error: "assignee_cap_exceeded" },
          correlationId: "corr-assignee-cap",
        }),
        openExternalHttps: async () => false,
        onNavigate: () => () => undefined,
        qaScrollDiagnosticsEnabled: false,
      },
    });

    let thrown: unknown;
    try {
      await requestJson("/v1/reviews/assignees/command", { method: "POST" });
    } catch (cause: unknown) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(PatchdeskApiError);
    if (!(thrown instanceof PatchdeskApiError)) return;
    expect(thrown.kind).toBe("assignee_cap_exceeded");
    expect(thrown.message).toContain("ten");
  });
});
