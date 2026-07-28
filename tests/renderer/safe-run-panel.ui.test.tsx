// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SafeRunPanel } from "../../src/renderer/src/components/safe-run-panel";
afterEach(cleanup);

describe("safe live run panel", () => { it("renders only a disconnected projection and never raw event fields", async () => { Object.defineProperty(window, "patchdesk", { configurable: true, value: { request: vi.fn().mockResolvedValue({ ok: true, status: 200, correlationId: "test", body: { status: "disconnected", elapsedMs: 0, step: "inspecting", prompt: "hidden" } }) } }); render(<SafeRunPanel profileId="cfw" sessionId="session" attemptId="001" runId="run" />); expect(await screen.findByText("Reconnect to review")).toBeTruthy(); expect(screen.queryByText("hidden")).toBeNull(); }); });

describe("recovery copy", () => {
  it("uses reconnect copy when the persisted session is still running", async () => {
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request: vi.fn() } });
    render(
      <SafeRunPanel
        profileId="cfw"
        sessionId="session"
        attemptId="001"
        onStart={async () => {}}
        recoveryMessage="Reconnect to follow this review in this window."
        recoveryActionLabel="Reconnect"
      />,
    );
    expect(await screen.findByText("Reconnect to follow this review in this window.")).toBeTruthy();    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });
});

describe("review completion", () => {
  it("reloads the persisted workbench after the owned run reaches completion", async () => {
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request: vi.fn().mockResolvedValue({ ok: true, status: 200, correlationId: "test", body: { status: "completed", elapsedMs: 12, step: "complete" } }) } });
    const completed = vi.fn();
    render(<SafeRunPanel profileId="cfw" sessionId="session" attemptId="001" runId="run" onSettled={completed} />);
    expect(await screen.findByText("Review ready")).toBeTruthy();
    expect(completed).toHaveBeenCalledTimes(1);
  });
});

describe("review run metadata", () => {
  it("does not render provider or lifecycle details", async () => {
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request: vi.fn().mockResolvedValue({ ok: true, status: 200, correlationId: "test", body: { status: "running", elapsedMs: 12, step: "inspecting", metadata: { agent: "Patchdesk review agent", model: "opencode-go/deepseek-v4-flash", reasoning: "medium", mode: "Full review", access: "Read-only repository inspection" } } }) } });
    render(<SafeRunPanel profileId="cfw" sessionId="session" attemptId="001" runId="run" />);
    expect(await screen.findByText("Review in progress")).toBeTruthy();
    expect(screen.queryByText("Patchdesk review agent")).toBeNull();
    expect(screen.queryByText("Read-only repository inspection")).toBeNull();
  });

  it("falls back to the disconnected state when metadata is malformed", async () => {
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request: vi.fn().mockResolvedValue({ ok: true, status: 200, correlationId: "test", body: { status: "running", elapsedMs: 12, step: "inspecting", metadata: { agent: "provider event", model: "model", reasoning: "medium", mode: "Full review", access: "Read-only repository inspection" } } }) } });
    render(<SafeRunPanel profileId="cfw" sessionId="session" attemptId="001" runId="run" />);
    expect(await screen.findByText("Reconnect to review")).toBeTruthy();
    expect(screen.queryByText("provider event")).toBeNull();
  });
});

describe("settling the finished run", () => {
  it("shows a finalizing state while the workbench reloads", async () => {
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request: vi.fn().mockResolvedValue({ ok: true, status: 200, correlationId: "test", body: { status: "completed", elapsedMs: 12, step: "complete" } }) } });
    const completed = vi.fn(() => new Promise<void>(() => {}));
    render(<SafeRunPanel profileId="cfw" sessionId="session" attemptId="001" runId="run" onSettled={completed} />);

    expect(await screen.findByText("Finalizing review…")).toBeTruthy();
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("offers a retry when the workbench reload fails", async () => {
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request: vi.fn().mockResolvedValue({ ok: true, status: 200, correlationId: "test", body: { status: "completed", elapsedMs: 12, step: "complete" } }) } });
    const completed = vi.fn()
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValueOnce(undefined);
    render(<SafeRunPanel profileId="cfw" sessionId="session" attemptId="001" runId="run" onSettled={completed} />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(completed).toHaveBeenCalledTimes(2));
  });
});

it("settles the workbench when the run fails", async () => {
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request: vi.fn().mockResolvedValue({ ok: true, status: 200, correlationId: "test", body: { status: "failed", elapsedMs: 30, step: "failed", message: "Review run failed" } }) } });
    const settled = vi.fn();
    render(<SafeRunPanel profileId="cfw" sessionId="session" attemptId="001" runId="run" onSettled={settled} />);

    await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
  });

  describe("disconnected polling", () => {
  it("retries immediately when the user asks for a check", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue({ ok: true, status: 200, correlationId: "test", body: { status: "running", elapsedMs: 5, step: "inspecting" } });
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request } });
    render(<SafeRunPanel profileId="cfw" sessionId="session" attemptId="001" runId="run" />);

    fireEvent.click(await screen.findByRole("button", { name: "Check again now" }));

    await waitFor(() => expect(request.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText("Review in progress")).toBeTruthy();
  });
});
