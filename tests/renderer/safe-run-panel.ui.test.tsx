// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SafeRunPanel } from "../../src/renderer/src/components/safe-run-panel";
describe("safe live run panel", () => { it("renders only a disconnected projection and never raw event fields", async () => { Object.defineProperty(window, "patchdesk", { configurable: true, value: { localApi: { baseUrl: "http://local/", capability: "cap" } } }); vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ runId: "run" }))).mockResolvedValueOnce(new Response(JSON.stringify({ status: "disconnected", elapsedMs: 0, step: "inspecting", prompt: "hidden" })))); render(<SafeRunPanel profileId="cfw" sessionId="session" attemptId="001" />); expect(await screen.findByText("Run status: disconnected")).toBeTruthy(); expect(screen.queryByText("hidden")).toBeNull(); }); });

describe("review completion", () => {
  it("reloads the persisted workbench after the owned run reaches completion", async () => {
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { localApi: { baseUrl: "http://local/", capability: "cap" } } });
    const completed = vi.fn();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ runId: "run" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "completed", elapsedMs: 12, step: "complete" }))));
    render(<SafeRunPanel profileId="cfw" sessionId="session" attemptId="001" onCompleted={completed} />);
    expect(await screen.findByText("Run status: completed")).toBeTruthy();
    expect(completed).toHaveBeenCalledTimes(1);
  });
});
