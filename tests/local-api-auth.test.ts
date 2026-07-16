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

  it("rejects a request shaped as a cross-site fetch", async () => {
    localApi = await startTestLocalApi();

    const response = await fetch(new URL("health", localApi.url), {
      headers: {
        "Sec-Fetch-Site": "cross-site",
        "X-Patchdesk-Capability": capability,
        Origin: allowedOrigin,
      },
    });

    expect(response.status).toBe(403);
  });
});

async function startTestLocalApi(): Promise<LocalApiServer> {
  const startup = await startLocalApiServer({ capability, allowedOrigin });
  if (startup._tag !== "started") {
    throw new Error("Expected valid local API startup");
  }

  return startup.server;
}
