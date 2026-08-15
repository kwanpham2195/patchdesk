// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LogsPanel } from "../../src/renderer/src/components/logs-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function entry(seq: number, message: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    seq,
    at: "2026-08-01T00:00:00.000Z",
    process: "main",
    level: "info",
    topic: "test",
    message,
  };
}

function deferredResponse(): {
  readonly promise: Promise<{
    readonly ok: true;
    readonly body: unknown;
    readonly correlationId: string;
  }>;
  readonly resolve: (value: {
    readonly ok: true;
    readonly body: unknown;
    readonly correlationId: string;
  }) => void;
} {
  let resolve!: (value: {
    readonly ok: true;
    readonly body: unknown;
    readonly correlationId: string;
  }) => void;
  const promise = new Promise<{
    readonly ok: true;
    readonly body: unknown;
    readonly correlationId: string;
  }>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("LogsPanel", () => {
  it("tails the stream and resumes exactly once with the nextAfter cursor", async () => {
    const request = vi.fn(async (input: { readonly path: string }) => {
      if (input.path === "/v1/logs?limit=300")
        return {
          ok: true,
          body: {
            entries: [entry(0, "first"), entry(1, "second")],
            nextAfter: 1,
          },
          correlationId: "logs",
        };
      if (input.path === "/v1/logs?after=1&limit=500")
        return {
          ok: true,
          body: { entries: [entry(2, "third")], nextAfter: 2 },
          correlationId: "logs",
        };
      throw new Error(`unexpected ${input.path}`);
    });
    vi.stubGlobal("window", window);
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    vi.useFakeTimers();
    try {
      render(<LogsPanel />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("first")).toBeTruthy();
      expect(screen.getByText("second")).toBeTruthy();
      // One entry arrives between polls; the cursor is the last delivered
      // sequence (1), so the poll resumes after it and delivers entry 2 once.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(screen.getByText("third")).toBeTruthy();
      const polls = request.mock.calls.filter((call) =>
        ((call[0] as { readonly path?: string }).path ?? "").includes(
          "/v1/logs",
        ),
      );
      expect(polls.length).toBeGreaterThanOrEqual(2);
      const resumed = polls.find((call) =>
        ((call[0] as { readonly path?: string }).path ?? "").startsWith(
          "/v1/logs?after=",
        ),
      );
      const resumedPath =
        resumed === undefined
          ? undefined
          : (resumed[0] as { readonly path?: string }).path;
      expect(resumedPath).toBe("/v1/logs?after=1&limit=500");
      expect(screen.getAllByText("third")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pausing before the next interval prevents a new poll", async () => {
    const request = vi.fn(async (input: { readonly path: string }) => {
      if (input.path === "/v1/logs?limit=300")
        return {
          ok: true,
          body: { entries: [entry(0, "initial")], nextAfter: 0 },
          correlationId: "logs",
        };
      throw new Error(`unexpected ${input.path}`);
    });
    vi.stubGlobal("window", window);
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    vi.useFakeTimers();
    try {
      render(<LogsPanel />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole("button", { name: "Pause log tail" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(request.mock.calls).toHaveLength(1);
      expect(screen.getByText("initial")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits an in-flight response while paused and resumes from its cursor once", async () => {
    const inFlight = deferredResponse();
    const request = vi.fn(async (input: { readonly path: string }) => {
      if (input.path === "/v1/logs?limit=300")
        return {
          ok: true,
          body: { entries: [entry(0, "initial")], nextAfter: 0 },
          correlationId: "logs",
        };
      if (input.path === "/v1/logs?after=0&limit=500") return inFlight.promise;
      throw new Error(`unexpected ${input.path}`);
    });
    vi.stubGlobal("window", window);
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    vi.useFakeTimers();
    try {
      render(<LogsPanel />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      fireEvent.click(screen.getByRole("button", { name: "Pause log tail" }));
      await act(async () => {
        inFlight.resolve({
          ok: true,
          body: { entries: [entry(1, "in-flight")], nextAfter: 1 },
          correlationId: "logs",
        });
        await inFlight.promise;
      });
      expect(screen.getByText("in-flight")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(
        request.mock.calls.filter(([input]) =>
          (input as { readonly path: string }).path.includes("/v1/logs"),
        ),
      ).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "Resume log tail" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      const polls = request.mock.calls.filter(([input]) =>
        (input as { readonly path: string }).path.includes("/v1/logs"),
      );
      expect(polls).toHaveLength(3);
      const resumed = polls[2];
      if (resumed === undefined) throw new Error("missing resumed poll");
      expect((resumed[0] as { readonly path: string }).path).toBe(
        "/v1/logs?after=1&limit=500",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses an initial response after unmount", async () => {
    const initial = deferredResponse();
    const request = vi.fn(async () => initial.promise);
    vi.stubGlobal("window", window);
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    vi.useFakeTimers();
    try {
      const view = render(<LogsPanel />);
      view.unmount();
      await act(async () => {
        initial.resolve({
          ok: true,
          body: { entries: [entry(1, "late")], nextAfter: 1 },
          correlationId: "logs",
        });
        await initial.promise;
      });
      expect(screen.queryByText("late")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps its prior cursor when a poll returns no entries", async () => {
    const request = vi.fn(async (input: { readonly path: string }) => {
      if (input.path === "/v1/logs?limit=300")
        return {
          ok: true,
          body: { entries: [entry(0, "only")], nextAfter: 0 },
          correlationId: "logs",
        };
      if (input.path.startsWith("/v1/logs?after="))
        return { ok: true, body: { entries: [] }, correlationId: "logs" };
      throw new Error(`unexpected ${input.path}`);
    });
    vi.stubGlobal("window", window);
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    vi.useFakeTimers();
    try {
      render(<LogsPanel />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("only")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      // No entries: the client retains the previous cursor and does not append
      // duplicates or reset the stream.
      expect(screen.getAllByText("only")).toHaveLength(1);
      const polls = request.mock.calls.filter((call) =>
        ((call[0] as { readonly path?: string }).path ?? "").includes(
          "/v1/logs",
        ),
      );
      expect(polls).toHaveLength(2);
      const secondPoll = polls[1];
      const secondPollPath =
        secondPoll === undefined
          ? undefined
          : (secondPoll[0] as { readonly path?: string }).path;
      expect(secondPollPath).toBe("/v1/logs?after=0&limit=500");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getAllByText("only")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
