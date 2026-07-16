import { afterEach, describe, expect, it } from "vitest";

import {
  startLocalApiServer,
  type LocalApiServer,
} from "../src/main/local-api";

const capability = "test-only-capability";
const allowedOrigin = "http://patchdesk.local";
let localApi: LocalApiServer | undefined;

afterEach(async () => {
  if (localApi !== undefined) {
    await localApi.stop();
    localApi = undefined;
  }
});

describe("local API capability boundary", () => {
  it("returns a safe typed failure for invalid startup configuration", async () => {
    const startup = await startLocalApiServer({
      capability: "",
      allowedOrigin: "",
    });

    expect(startup).toEqual({ _tag: "invalid-configuration" });
  });

  it("returns health only to the allowed origin with the app capability", async () => {
    localApi = await startTestLocalApi();

    const response = await fetch(new URL("health", localApi.url), {
      headers: {
        "X-Patchdesk-Capability": capability,
        Origin: allowedOrigin,
      },
    });

    expect(localApi.url.hostname).toBe("127.0.0.1");
    expect(localApi.url.port).not.toBe("0");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("rejects a request with no app capability", async () => {
    localApi = await startTestLocalApi();

    const response = await fetch(new URL("health", localApi.url), {
      headers: { Origin: allowedOrigin },
    });

    expect(response.status).toBe(401);
  });

  it("rejects a request with the wrong app capability", async () => {
    localApi = await startTestLocalApi();

    const response = await fetch(new URL("health", localApi.url), {
      headers: {
        "X-Patchdesk-Capability": "wrong-capability",
        Origin: allowedOrigin,
      },
    });

    expect(response.status).toBe(403);
  });

  it("rejects a request from a different origin", async () => {
    localApi = await startTestLocalApi();

    const response = await fetch(new URL("health", localApi.url), {
      headers: {
        "X-Patchdesk-Capability": capability,
        Origin: "https://attacker.example",
      },
    });

    expect(response.status).toBe(403);
  });

  it("accepts the renderer's cross-origin loopback fetch when origin and capability match", async () => {
    localApi = await startTestLocalApi();

    const response = await fetch(new URL("health", localApi.url), {
      headers: {
        "Sec-Fetch-Site": "cross-site",
        "X-Patchdesk-Capability": capability,
        Origin: allowedOrigin,
      },
    });

    expect(response.status).toBe(200);
  });

  it("allows the renderer's capability preflight with only the required headers", async () => {
    localApi = await startTestLocalApi();
    const response = await fetch(new URL("v1/dashboard", localApi.url), {
      method: "OPTIONS",
      headers: {
        Origin: allowedOrigin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type,x-patchdesk-capability",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      allowedOrigin,
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "X-Patchdesk-Capability",
    );
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "PUT",
    );
  });

  it("returns a typed 400 for malformed JSON instead of leaking a parser exception", async () => {
    localApi = await startTestLocalApi();
    const response = await fetch(
      new URL("v1/direct-entry/preview", localApi.url),
      {
        method: "POST",
        headers: {
          "X-Patchdesk-Capability": capability,
          Origin: allowedOrigin,
          "Content-Type": "application/json",
        },
        body: "{bad-json",
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_input" });
  });

  it("protects safe review-run routes with the same capability and returns a disconnected projection", async () => {
    localApi = await startTestLocalApi();
    const headers = { "X-Patchdesk-Capability": capability, Origin: allowedOrigin, "Content-Type": "application/json" };
    const started = await fetch(new URL("v1/runs/review-pr", localApi.url), { method: "POST", headers, body: JSON.stringify({ sessionId: "session", attemptId: "001" }) });
    expect(started.status).toBe(200);
    const startedBody = await started.json() as { readonly runId: string };
    const disconnected = await fetch(new URL(`v1/runs/${encodeURIComponent(startedBody.runId)}?sessionId=session&attemptId=001`, localApi.url), { headers: { "X-Patchdesk-Capability": capability, Origin: allowedOrigin } });
    await expect(disconnected.json()).resolves.toEqual({ status: "disconnected", elapsedMs: 0, step: "inspecting" });
    const foreign = await fetch(new URL(`v1/runs/${encodeURIComponent(startedBody.runId)}?sessionId=other&attemptId=001`, localApi.url), { headers: { "X-Patchdesk-Capability": capability, Origin: allowedOrigin } });
    expect(foreign.status).toBe(403);
  });
});

async function startTestLocalApi(): Promise<LocalApiServer> {
  const startup = await startLocalApiServer({ capability, allowedOrigin });
  if (startup._tag !== "started") {
    throw new Error("Expected valid local API startup");
  }

  return startup.server;
}
