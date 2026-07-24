// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SafeRunPanel } from "../../src/renderer/src/components/safe-run-panel";
describe("safe live run panel", () => { it("renders only a disconnected projection and never raw event fields", async () => { Object.defineProperty(window, "patchdesk", { configurable: true, value: { request: vi.fn().mockResolvedValue({ ok: true, status: 200, correlationId: "test", body: { status: "disconnected", elapsedMs: 0, step: "inspecting", prompt: "hidden" } }) } }); render(<SafeRunPanel profileId="cfw" sessionId="session" attemptId="001" runId="run" />); expect(await screen.findByText("Run status: disconnected")).toBeTruthy(); expect(screen.queryByText("hidden")).toBeNull(); }); });

describe("review completion", () => {
  it("reloads the persisted workbench after the owned run reaches completion", async () => {
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request: vi.fn().mockResolvedValue({ ok: true, status: 200, correlationId: "test", body: { status: "completed", elapsedMs: 12, step: "complete" } }) } });
    const completed = vi.fn();
    render(<SafeRunPanel profileId="cfw" sessionId="session" attemptId="001" runId="run" onCompleted={completed} />);
    expect(await screen.findByText("Run status: completed")).toBeTruthy();
    expect(completed).toHaveBeenCalledTimes(1);
  });
});

describe("review run metadata", () => {
  it("renders the safe attempt provenance without provider details", async () => {
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request: vi.fn().mockResolvedValue({ ok: true, status: 200, correlationId: "test", body: { status: "running", elapsedMs: 12, step: "inspecting", metadata: { agent: "Patchdesk review agent", model: "opencode-go/deepseek-v4-flash", reasoning: "medium", mode: "Full review", access: "Read-only repository inspection" } } }) } });
    render(<SafeRunPanel profileId="cfw" sessionId="session" attemptId="001" runId="run" />);
    expect(await screen.findByText("Patchdesk review agent")).toBeTruthy();
    expect(screen.getByText("Read-only repository inspection")).toBeTruthy();
  });

  it("falls back to the disconnected state when metadata is malformed", async () => {
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request: vi.fn().mockResolvedValue({ ok: true, status: 200, correlationId: "test", body: { status: "running", elapsedMs: 12, step: "inspecting", metadata: { agent: "provider event", model: "model", reasoning: "medium", mode: "Full review", access: "Read-only repository inspection" } } }) } });
    render(<SafeRunPanel profileId="cfw" sessionId="session" attemptId="001" runId="run" />);
    expect(await screen.findByText("Run status: disconnected")).toBeTruthy();
    expect(screen.queryByText("provider event")).toBeNull();
  });
});
