import { describe, expect, it, vi } from "vitest";

import {
  installDesktopRequestBridge,
  isAllowedDesktopRequest,
} from "../src/main/desktop-bridge";

describe("desktop request bridge", () => {
  it("allows the maintainer inbox reads required by the desktop renderer", () => {
    expect(isAllowedDesktopRequest({ path: "/v1/inbox" })).toBe(true);
    expect(
      isAllowedDesktopRequest({
        path: "/v1/reviews/diff-file",
        method: "POST",
      }),
    ).toBe(true);
    // The explicit, main-process-owned review flow needs both the current
    // runtime catalog and the validated run-start route. These are not
    // GitHub-write capabilities, but omitting either makes the dialog appear
    // unavailable in packaged Electron builds.
    expect(isAllowedDesktopRequest({ path: "/v1/reviews/models" })).toBe(true);
    expect(
      isAllowedDesktopRequest({ path: "/v1/reviews/run", method: "POST" }),
    ).toBe(true);
    expect(isAllowedDesktopRequest({ path: "/v1/dashboard/refresh", method: "POST" })).toBe(false);
    expect(isAllowedDesktopRequest({ path: "/v1/inbox/refresh", method: "POST" })).toBe(false);
    expect(isAllowedDesktopRequest({ path: "/v1/inbox/refresh/repository", method: "POST" })).toBe(false);
  });

  it("returns a native directory selection only to the owning renderer", async () => {
    let handler: ((event: { readonly sender: { readonly id: number } }, input: unknown) => Promise<unknown>) | undefined;
    const ipc = {
      removeHandler: vi.fn(),
      handle: vi.fn((_channel: string, next: typeof handler) => { handler = next; }),
    };
    const selectDirectory = vi.fn(async () => "/workspace/patchdesk");
    const setNavigationState = vi.fn();

    installDesktopRequestBridge(
      ipc as never,
      17,
      { url: new URL("http://127.0.0.1:4000/"), capability: "test-capability" } as never,
      "http://localhost:5173",
      { selectDirectory, setNavigationState },
    );

    if (handler === undefined) throw new Error("Expected the desktop request handler");
    await expect(handler({ sender: { id: 17 } }, { operation: "selectDirectory", defaultPath: "/workspace" })).resolves.toMatchObject({
      ok: true,
      status: 200,
      body: { path: "/workspace/patchdesk" },
    });
    expect(selectDirectory).toHaveBeenCalledWith({ defaultPath: "/workspace" });

    await expect(handler({ sender: { id: 99 } }, { operation: "selectDirectory" })).resolves.toMatchObject({ ok: false, status: 400 });
    expect(selectDirectory).toHaveBeenCalledTimes(1);

    await expect(handler({ sender: { id: 17 } }, { operation: "setNavigationState", state: "write_pending" })).resolves.toMatchObject({
      ok: true,
      status: 200,
    });
    expect(setNavigationState).toHaveBeenCalledWith("write_pending");

    await expect(handler({ sender: { id: 99 } }, { operation: "setNavigationState", state: "clear" })).resolves.toMatchObject({ ok: false, status: 400 });
    expect(setNavigationState).toHaveBeenCalledTimes(1);
  });
});
