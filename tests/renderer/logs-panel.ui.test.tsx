// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopResponse } from "../../src/main/ipc-contract";
import {
  LogsPanel,
  levelClass,
} from "../../src/renderer/src/components/logs-panel";
import type { LogLevel } from "../../src/domain/log-entry";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

type TestLogEntry = {
  readonly schemaVersion: 1;
  readonly seq: number;
  readonly at: string;
  readonly process: "main" | "renderer";
  readonly level: "error" | "warn" | "info" | "debug";
  readonly topic: string;
  readonly message: string;
};
type DeferredResponse = {
  readonly promise: Promise<DesktopResponse>;
  readonly resolve: (value: DesktopResponse) => void;
};

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  desktop?.restore();
  desktop = undefined;
});

/** Every log path the panel polled, in call order. */
function polledPaths(double: DesktopDouble): readonly string[] {
  return double.request.mock.calls.flatMap(([input]) =>
    "path" in input ? [input.path] : [],
  );
}

function entry(seq: number, message: string) {
  return {
    schemaVersion: 1,
    seq,
    at: "2026-08-01T00:00:00.000Z",
    process: "main",
    level: "info",
    topic: "test",
    message,
  } satisfies TestLogEntry;
}

function deferredResponse(): DeferredResponse {
  let resolve!: DeferredResponse["resolve"];
  const promise = new Promise<DesktopResponse>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("LogsPanel", () => {
  // Which token each level gets is the rule `log-level-class.test.ts` owns,
  // for all four levels. The one thing that test cannot see is whether a
  // rendered row still asks the rule, so this compares the rendered level
  // against the rule's own answer rather than against a written-out token.
  it("tones each rendered log row through the shared level rule", async () => {
    vi.stubGlobal("window", window);
    desktop = installDesktopDouble({
      "/v1/logs?limit=300": () =>
        success({
          entries: [
            { ...entry(0, "message-error"), level: "error" },
            { ...entry(1, "message-debug"), level: "debug" },
          ],
          nextAfter: 1,
        }),
    });
    vi.useFakeTimers();
    try {
      render(<LogsPanel />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      for (const level of ["error", "debug"] satisfies LogLevel[]) {
        expect(screen.getByText(level, { exact: true }).className).toContain(
          levelClass(level),
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("tails the stream and resumes exactly once with the nextAfter cursor", async () => {
    vi.stubGlobal("window", window);
    desktop = installDesktopDouble({
      "/v1/logs?limit=300": () =>
        success({
          entries: [entry(0, "first"), entry(1, "second")],
          nextAfter: 1,
        }),
      "/v1/logs?after=1&limit=500": () =>
        success({ entries: [entry(2, "third")], nextAfter: 2 }),
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
      const polls = polledPaths(desktop).filter((path) =>
        path.includes("/v1/logs"),
      );
      expect(polls.length).toBeGreaterThanOrEqual(2);
      expect(polls.find((path) => path.startsWith("/v1/logs?after="))).toBe(
        "/v1/logs?after=1&limit=500",
      );
      expect(screen.getAllByText("third")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pausing before the next interval prevents a new poll", async () => {
    vi.stubGlobal("window", window);
    desktop = installDesktopDouble({
      "/v1/logs?limit=300": () =>
        success({ entries: [entry(0, "initial")], nextAfter: 0 }),
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
      expect(polledPaths(desktop)).toHaveLength(1);
      expect(screen.getByText("initial")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits an in-flight response while paused and resumes from its cursor once", async () => {
    const inFlight = deferredResponse();
    vi.stubGlobal("window", window);
    // Only the first two polls are scripted. The third — the one this test is
    // about — is left unrouted on purpose: the double refuses it, exactly as
    // the hand-rolled stub did, and the assertion is on the path the panel
    // asked for, not on what came back. The refusal is accepted below with
    // takeUnroutedCalls(), which is itself the assertion that the third poll
    // is the only call this test leaves unanswered.
    desktop = installDesktopDouble({
      "/v1/logs?limit=300": () =>
        success({ entries: [entry(0, "initial")], nextAfter: 0 }),
      "/v1/logs?after=0&limit=500": () => inFlight.promise,
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
        inFlight.resolve(
          success({ entries: [entry(1, "in-flight")], nextAfter: 1 }),
        );
        await inFlight.promise;
      });
      expect(screen.getByText("in-flight")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(
        polledPaths(desktop).filter((path) => path.includes("/v1/logs")),
      ).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "Resume log tail" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      const polls = polledPaths(desktop).filter((path) =>
        path.includes("/v1/logs"),
      );
      expect(polls).toHaveLength(3);
      expect(polls[2]).toBe("/v1/logs?after=1&limit=500");
      expect(desktop.takeUnroutedCalls()).toEqual([
        "GET /v1/logs?after=1&limit=500",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses an initial response after unmount", async () => {
    const initial = deferredResponse();
    vi.stubGlobal("window", window);
    desktop = installDesktopDouble({
      "/v1/logs?limit=300": () => initial.promise,
    });
    vi.useFakeTimers();
    try {
      const view = render(<LogsPanel />);
      view.unmount();
      await act(async () => {
        initial.resolve(success({ entries: [entry(1, "late")], nextAfter: 1 }));
        await initial.promise;
      });
      expect(screen.queryByText("late")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps its prior cursor when a poll returns no entries", async () => {
    vi.stubGlobal("window", window);
    desktop = installDesktopDouble({
      "/v1/logs?limit=300": () =>
        success({ entries: [entry(0, "only")], nextAfter: 0 }),
      "/v1/logs?after=0&limit=500": () => success({ entries: [] }),
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
      const polls = polledPaths(desktop).filter((path) =>
        path.includes("/v1/logs"),
      );
      expect(polls).toHaveLength(2);
      expect(polls[1]).toBe("/v1/logs?after=0&limit=500");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getAllByText("only")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
