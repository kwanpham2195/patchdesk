// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LogsPanel } from "../../src/renderer/src/components/logs-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function entry(seq: number, message: string): Record<string, unknown> {
  return { schemaVersion: 1, seq, at: "2026-08-01T00:00:00.000Z", process: "main", level: "info", topic: "test", message };
}

describe("LogsPanel", () => {
  it("tails the stream and resumes exactly once with the nextAfter cursor", async () => {
    const request = vi.fn(async (input: { readonly path: string }) => {
      if (input.path === "/v1/logs?limit=300")
        return { ok: true, body: { entries: [entry(0, "first"), entry(1, "second")], nextAfter: 1 }, correlationId: "logs" };
      if (input.path === "/v1/logs?after=1&limit=500")
        return { ok: true, body: { entries: [entry(2, "third")], nextAfter: 2 }, correlationId: "logs" };
      throw new Error(`unexpected ${input.path}`);
    });
    vi.stubGlobal("window", window);
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request } });
    vi.useFakeTimers();
    try {
      render(<LogsPanel />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText("first")).toBeTruthy();
      expect(screen.getByText("second")).toBeTruthy();
      // One entry arrives between polls; the cursor is the last delivered
      // sequence (1), so the poll resumes after it and delivers entry 2 once.
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(screen.getByText("third")).toBeTruthy();
      const polls = request.mock.calls.filter((call) => ((call[0] as { readonly path?: string }).path ?? "").includes("/v1/logs"));
      expect(polls.length).toBeGreaterThanOrEqual(2);
      const resumed = polls.find((call) => ((call[0] as { readonly path?: string }).path ?? "").startsWith("/v1/logs?after="));
      expect((resumed?.[0] as { readonly path?: string }).path).toBe("/v1/logs?after=1&limit=500");
      expect(screen.getAllByText("third")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps its prior cursor when a poll returns no entries", async () => {
    const request = vi.fn(async (input: { readonly path: string }) => {
      if (input.path === "/v1/logs?limit=300")
        return { ok: true, body: { entries: [entry(0, "only")], nextAfter: 0 }, correlationId: "logs" };
      if (input.path.startsWith("/v1/logs?after="))
        return { ok: true, body: { entries: [] }, correlationId: "logs" };
      throw new Error(`unexpected ${input.path}`);
    });
    vi.stubGlobal("window", window);
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request } });
    vi.useFakeTimers();
    try {
      render(<LogsPanel />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText("only")).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      // No entries: the client retains the previous cursor and does not append
      // duplicates or reset the stream.
      expect(screen.getAllByText("only")).toHaveLength(1);
      const polls = request.mock.calls.filter((call) => ((call[0] as { readonly path?: string }).path ?? "").includes("/v1/logs"));
      expect(polls).toHaveLength(2);
      expect((polls[1]?.[0] as { readonly path?: string }).path).toBe("/v1/logs?after=0&limit=500");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getAllByText("only")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
