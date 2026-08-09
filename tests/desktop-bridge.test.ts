import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

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
    expect(isAllowedDesktopRequest({ path: "/v1/reviews/detect-updates", method: "POST" })).toBe(true);
    expect(isAllowedDesktopRequest({ path: "/v1/reviews/commit-diff", method: "POST" })).toBe(true);
    // The explicit, main-process-owned review flow needs both the current
    // runtime catalog and the validated run-start route. These are not
    // GitHub-write capabilities, but omitting either makes the dialog appear
    // unavailable in packaged Electron builds.
    expect(isAllowedDesktopRequest({ path: "/v1/reviews/models" })).toBe(true);
    expect(isAllowedDesktopRequest({ path: "/v1/settings" })).toBe(true);
    expect(
      isAllowedDesktopRequest({ path: "/v1/settings", method: "PATCH" }),
    ).toBe(true);
    expect(
      isAllowedDesktopRequest({ path: "/v1/reviews/run", method: "POST" }),
    ).toBe(true);
    expect(isAllowedDesktopRequest({ path: "/v1/dashboard/refresh", method: "POST" })).toBe(false);
    expect(isAllowedDesktopRequest({ path: "/v1/inbox/refresh", method: "POST" })).toBe(false);
    expect(isAllowedDesktopRequest({ path: "/v1/inbox/refresh/repository", method: "POST" })).toBe(false);
  });

  it("allows only the global Settings cleanup routes", () => {
    expect(isAllowedDesktopRequest({ path: "/v1/storage/cache/clear", method: "POST" })).toBe(true);
    expect(isAllowedDesktopRequest({ path: "/v1/storage/clear-local-data", method: "POST" })).toBe(true);
    expect(isAllowedDesktopRequest({ path: "/v1/diagnostics?profileId=cfw" })).toBe(true);
    expect(isAllowedDesktopRequest({ path: "/v1/diagnostics/support-bundle", method: "POST" })).toBe(true);
    expect(isAllowedDesktopRequest({ path: "/v1/logs" })).toBe(true);
    expect(isAllowedDesktopRequest({ path: "/v1/logs?after=3&limit=50" })).toBe(true);
    expect(isAllowedDesktopRequest({ path: "/v1/logs", method: "POST" })).toBe(true);
    expect(isAllowedDesktopRequest({ path: "/v1/storage", method: "GET" })).toBe(false);
    expect(isAllowedDesktopRequest({ path: "/v1/storage/discard", method: "POST" })).toBe(false);
    expect(isAllowedDesktopRequest({ path: "/v1/storage/quarantine/delete", method: "POST" })).toBe(false);
  });

  it("allows only Review-owned Insight lifecycle routes", () => {
    expect(isAllowedDesktopRequest({ path: "/v1/reviews/insights/analysis/run", method: "POST" })).toBe(true);
    expect(isAllowedDesktopRequest({ path: "/v1/reviews/insights/walkthrough/run", method: "POST" })).toBe(true);
    expect(isAllowedDesktopRequest({ path: "/v1/reviews/insights/walkthrough/cancel", method: "POST" })).toBe(true);
    expect(isAllowedDesktopRequest({ path: "/v1/reviews/insights/runs/run-1", method: "GET" })).toBe(true);
    expect(isAllowedDesktopRequest({ path: "/v1/reviews/walkthrough/generate", method: "POST" })).toBe(false);
    expect(isAllowedDesktopRequest({ path: "/v1/reviews/insights/walkthrough/run", method: "GET" })).toBe(false);
  });

  it.each([
    "/v1/reviews/publication/preview",
    "/v1/reviews/publication/confirm",
    "/v1/reviews/publication/recover",
    "/v1/reviews/published-comments/edit",
    "/v1/reviews/published-comments/delete",
    "/v1/reviews/published-reviews/dismiss",
    "/v1/reviews/insights/analysis/findings/finding-1/add",
    "/v1/reviews/insights/analysis/findings/finding-1/dismiss",
    "/v1/reviews/insights/walkthrough/progress",
    "/v1/reviews/draft/seed-analysis",
    "/v1/reviews/draft/merge-preview",
    "/v1/reviews/draft/replace-preview",
    "/v1/reviews/draft/merge",
    "/v1/reviews/draft/replace",
    "/v1/reviews/draft/findings/finding-1/add",
    "/v1/reviews/pending-review/command",
    "/v1/reviews/pending-review/recover",
  ])("allows the canonical protected Review route %s", (path) => {
    expect(isAllowedDesktopRequest({ path, method: "POST" })).toBe(true);
  });

  it.each([
    { method: "GET", path: "/v1/reviews/publication/preview" },
    { method: "GET", path: "/v1/reviews/publication/recover" },
    { method: "POST", path: "/v1/reviews/publication/preview/extra" },
    { method: "POST", path: "/v1/reviews/insights/analysis/findings/finding-1/add/extra" },
    { method: "POST", path: "/v1/reviews/draft/findings/finding-1/add/extra" },
  ] as const)("rejects a non-canonical Review route %s $path", ({ method, path }) => {
    expect(isAllowedDesktopRequest({ method, path })).toBe(false);
  });

  it.each([
    { method: "GET", path: "/v1/reviews/pending-review/command" },
    { method: "GET", path: "/v1/reviews/pending-review/recover" },
    { method: "POST", path: "/v1/reviews/pending-review/command/extra" },
    { method: "POST", path: "/v1/reviews/pending-review/force" },
    { method: "POST", path: "/v1/reviews/pending-review/command/" },
  ] as const)("rejects a non-canonical pending-review route %s $path", ({ method, path }) => {
    expect(isAllowedDesktopRequest({ method, path })).toBe(false);
  });

  it("forwards every canonical Review request through the protected bridge", async () => {
    const received: Array<{ readonly method: string | undefined; readonly url: string | undefined; readonly origin: string | undefined; readonly capability: string | undefined }> = [];
    const server = createServer((request, response) => {
      received.push({
        method: request.method,
        url: request.url,
        origin: typeof request.headers.origin === "string" ? request.headers.origin : undefined,
        capability: typeof request.headers["x-patchdesk-capability"] === "string" ? request.headers["x-patchdesk-capability"] : undefined,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP test server");

    let handler: ((event: { readonly sender: { readonly id: number } }, input: unknown) => Promise<unknown>) | undefined;
    const ipc = {
      removeHandler: () => undefined,
      handle: (_channel: string, next: typeof handler) => { handler = next; },
    };
    installDesktopRequestBridge(
      ipc as never,
      17,
      { url: new URL(`http://127.0.0.1:${(address as AddressInfo).port}/`), capability: "test-capability" } as never,
      "http://localhost:5173",
      {
        async selectDirectory() { return undefined; },
        setNavigationState() {},
        async openExternalHttps() { return false; },
      },
    );
    if (handler === undefined) throw new Error("Expected the desktop request handler");

    const requests = [
      { method: "GET", path: "/v1/reviews/models" },
      { method: "POST", path: "/v1/reviews/open" },
      { method: "POST", path: "/v1/reviews/load" },
      { method: "POST", path: "/v1/reviews/detect-updates" },
      { method: "POST", path: "/v1/reviews/refresh" },
      { method: "POST", path: "/v1/reviews/commit-diff" },
      { method: "POST", path: "/v1/reviews/diff-file" },
      { method: "POST", path: "/v1/reviews/batch" },
      { method: "POST", path: "/v1/reviews/insights/analysis/run" },
      { method: "POST", path: "/v1/reviews/insights/walkthrough/run" },
      { method: "POST", path: "/v1/reviews/insights/analysis/cancel" },
      { method: "POST", path: "/v1/reviews/insights/walkthrough/cancel" },
      { method: "GET", path: "/v1/reviews/insights/runs/run-1" },
      { method: "POST", path: "/v1/reviews/insights/analysis/findings/finding-1/add" },
      { method: "POST", path: "/v1/reviews/insights/analysis/findings/finding-1/dismiss" },
      { method: "POST", path: "/v1/reviews/insights/walkthrough/progress" },
      { method: "POST", path: "/v1/reviews/draft/seed-analysis" },
      { method: "POST", path: "/v1/reviews/draft/merge-preview" },
      { method: "POST", path: "/v1/reviews/draft/replace-preview" },
      { method: "POST", path: "/v1/reviews/draft/merge" },
      { method: "POST", path: "/v1/reviews/draft/replace" },
      { method: "POST", path: "/v1/reviews/draft/findings/finding-1/add" },
      { method: "POST", path: "/v1/reviews/publication/preview" },
      { method: "POST", path: "/v1/reviews/publication/confirm" },
      { method: "POST", path: "/v1/reviews/publication/recover" },
      { method: "POST", path: "/v1/reviews/published-comments/edit" },
      { method: "POST", path: "/v1/reviews/published-comments/delete" },
      { method: "POST", path: "/v1/reviews/published-reviews/dismiss" },
      { method: "POST", path: "/v1/reviews/apply-batch" },
      { method: "POST", path: "/v1/reviews/submit-batch" },
      { method: "POST", path: "/v1/reviews/merge" },
    ] as const;

    try {
      for (const request of requests) {
        await expect(handler({ sender: { id: 17 } }, request)).resolves.toMatchObject({ ok: true, status: 200 });
      }
    } finally {
      server.close();
      await once(server, "close");
    }

    expect(received).toHaveLength(requests.length);
    expect(received).toEqual(requests.map((request) => ({
      method: request.method,
      url: request.path,
      origin: "http://localhost:5173",
      capability: "test-capability",
    })));
  });

  it("returns a native directory selection only to the owning renderer", async () => {
    let handler: ((event: { readonly sender: { readonly id: number } }, input: unknown) => Promise<unknown>) | undefined;
    const ipc = {
      removeHandler: vi.fn(),
      handle: vi.fn((_channel: string, next: typeof handler) => { handler = next; }),
    };
    const selectDirectory = vi.fn(async () => "/workspace/patchdesk");
    const setNavigationState = vi.fn();
    const openExternalHttps = vi.fn(async () => true);

    installDesktopRequestBridge(
      ipc as never,
      17,
      { url: new URL("http://127.0.0.1:4000/"), capability: "test-capability" } as never,
      "http://localhost:5173",
      { selectDirectory, setNavigationState, openExternalHttps },
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

    await expect(handler({ sender: { id: 17 } }, { operation: "openExternalHttps", url: "https://github.com/centraldigital/patchdesk/pull/42" })).resolves.toMatchObject({
      ok: true,
      status: 200,
      body: { opened: true },
    });
    expect(openExternalHttps).toHaveBeenCalledWith("https://github.com/centraldigital/patchdesk/pull/42");

    await expect(
      handler(
        { sender: { id: 17 } },
        { operation: "openExternalHttps", url: "https://github.com/".padEnd(2_049, "x") },
      ),
    ).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(
      handler(
        { sender: { id: 99 } },
        { operation: "openExternalHttps", url: "https://github.com/centraldigital/patchdesk/pull/42" },
      ),
    ).resolves.toMatchObject({ ok: false, status: 400 });
    expect(openExternalHttps).toHaveBeenCalledTimes(1);
  });
});
