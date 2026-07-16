import { describe, expect, it } from "vitest";

import { createDesktopLifecycle } from "../src/main/app-lifecycle";

describe("desktop lifecycle", () => {
  it("health-checks the local API before showing the workbench and stops it on quit", async () => {
    const events: Array<string> = [];
    const lifecycle = createDesktopLifecycle({
      localApi: {
        async start() {
          events.push("server:start");
          return {
            capability: "test-capability",
            url: new URL("http://127.0.0.1:43123/"),
          };
        },
        async healthCheck() {
          events.push("server:health");
          return true;
        },
        async stop() {
          events.push("server:stop");
        },
      },
      async showWorkbench() {
        events.push("workbench:show");
      },
    });

    const start = await lifecycle.start();
    await lifecycle.stop();

    expect(start).toEqual({ _tag: "started" });
    expect(events).toEqual([
      "server:start",
      "server:health",
      "workbench:show",
      "server:stop",
    ]);
  });

  it("does not show the workbench when the local API health check fails", async () => {
    const events: Array<string> = [];
    const lifecycle = createDesktopLifecycle({
      localApi: {
        async start() {
          events.push("server:start");
          return {
            capability: "test-capability",
            url: new URL("http://127.0.0.1:43123/"),
          };
        },
        async healthCheck() {
          events.push("server:health");
          return false;
        },
        async stop() {
          events.push("server:stop");
        },
      },
      async showWorkbench() {
        events.push("workbench:show");
      },
    });

    const start = await lifecycle.start();

    expect(start).toEqual({ _tag: "local-api-unavailable" });
    expect(events).toEqual(["server:start", "server:health", "server:stop"]);
  });

  it("stops the local API when opening the workbench fails", async () => {
    const events: Array<string> = [];
    const lifecycle = createDesktopLifecycle({
      localApi: {
        async start() {
          events.push("server:start");
          return {
            capability: "test-capability",
            url: new URL("http://127.0.0.1:43123/"),
          };
        },
        async healthCheck() {
          events.push("server:health");
          return true;
        },
        async stop() {
          events.push("server:stop");
        },
      },
      async showWorkbench() {
        events.push("workbench:show");
        throw new Error("Renderer failed to load");
      },
    });

    await expect(lifecycle.start()).rejects.toThrow("Renderer failed to load");

    expect(events).toEqual([
      "server:start",
      "server:health",
      "workbench:show",
      "server:stop",
    ]);
  });
});
