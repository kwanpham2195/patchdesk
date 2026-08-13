import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PatchdeskPaths } from "../src/adapters/storage/patchdesk-paths";
import {
  startLocalApiServer,
  type LocalApiServer,
} from "../src/main/local-api";
import { ok } from "../src/domain/result";
import { StorageManagementService } from "../src/services/storage-management-service";

const capability = "test-capability";
const origin = "http://patchdesk.test";
let server: LocalApiServer | undefined;
let root: string | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (root !== undefined)
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  root = undefined;
  vi.restoreAllMocks();
});

async function start(): Promise<LocalApiServer> {
  root = await mkdtemp(join(tmpdir(), "patchdesk-api-auth-"));
  const value = await startLocalApiServer({
    capability,
    allowedOrigin: origin,
    paths: PatchdeskPaths.forTest(root),
  });
  if (value._tag !== "started") throw new Error("local API did not start");
  server = value.server;
  return server;
}
function headers(overrides: Record<string, string> = {}) {
  return {
    Origin: origin,
    "X-Patchdesk-Capability": capability,
    "Content-Type": "application/json",
    ...overrides,
  };
}
async function post(
  api: LocalApiServer,
  path: string,
  body: unknown,
  requestHeaders: Record<string, string> = headers(),
) {
  return fetch(new URL(path, api.url), {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

describe("local API current Review capability boundary", () => {
  it("requires both per-launch capability and allowed origin on a real loopback server", async () => {
    const api = await start();
    await expect(fetch(new URL("v1/profiles", api.url))).resolves.toMatchObject(
      { status: 401 },
    );
    await expect(
      fetch(new URL("v1/profiles", api.url), {
        headers: headers({ Origin: "http://evil.invalid" }),
      }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      fetch(new URL("v1/profiles", api.url), { headers: headers() }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("protects every current Review route and validates the merge recovery input", async () => {
    const api = await start();
    const routes = [
      "v1/reviews/open",
      "v1/reviews/load",
      "v1/reviews/detect-updates",
      "v1/reviews/refresh",
      "v1/reviews/commit-diff",
      "v1/reviews/inline-conversations/command",
      "v1/reviews/pending-review/command",
      "v1/reviews/pending-review/recover",
      "v1/reviews/direct-summary/submit",
      "v1/reviews/direct-summary/recover",
      "v1/reviews/merge",
      "v1/reviews/merge/recover",
    ];
    for (const route of routes) {
      expect(
        (
          await post(
            api,
            route,
            {},
            { Origin: origin, "Content-Type": "application/json" },
          )
        ).status,
        route,
      ).toBe(401);
      expect(
        (await post(api, route, {}, headers({ Origin: "http://evil.invalid" })))
          .status,
        route,
      ).toBe(403);
    }
    expect((await post(api, "v1/reviews/merge/recover", {})).status).toBe(400);
    expect(
      (
        await post(api, "v1/reviews/merge/recover", {
          profileId: "profile",
          reviewId: "not-a-review-id",
        })
      ).status,
    ).toBe(400);
  });

  it("keeps current entry and reconciliation requests Review-id based", async () => {
    const api = await start();
    expect(
      (
        await post(api, "v1/reviews/open", {
          profileId: "profile",
          host: "github.com",
          owner: "centraldigital",
          repo: "patchdesk",
          number: 42,
        })
      ).status,
    ).not.toBe(400);
    for (const route of [
      "v1/reviews/load",
      "v1/reviews/detect-updates",
      "v1/reviews/refresh",
    ]) {
      expect(
        (
          await post(api, route, {
            profileId: "profile",
            sessionId: "session-a",
          })
        ).status,
        route,
      ).toBe(400);
      expect(
        (
          await post(api, route, {
            profileId: "profile",
            reviewId:
              "github.com__centraldigital__patchdesk__pr-42__review-abcdef123456",
          })
        ).status,
        route,
      ).not.toBe(400);
    }
  });

  it("delegates cache and full local-data cleanup to distinct operations", async () => {
    const clearCache = vi
      .spyOn(StorageManagementService.prototype, "clearCache")
      .mockResolvedValue(ok(undefined));
    const clearLocalData = vi
      .spyOn(StorageManagementService.prototype, "clearLocalData")
      .mockResolvedValue(ok(undefined));
    const api = await start();

    expect(
      (await post(api, "v1/storage/cache/clear", { profileId: "profile" }))
        .status,
    ).toBe(200);
    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(clearLocalData).not.toHaveBeenCalled();

    expect(
      (
        await post(api, "v1/storage/clear-local-data", {
          profileId: "profile",
        })
      ).status,
    ).toBe(200);
    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(clearLocalData).toHaveBeenCalledTimes(1);
  });

  it("does not expose deleted dashboard, list, model, write, or cleanup routes", async () => {
    const api = await start();
    const removed = [
      ["GET", "v1/dashboard"],
      ["GET", "v1/reviews?profileId=profile"],
      ["GET", "v1/reviews/models"],
      ["POST", `v1/reviews/${"ba" + "tch"}`],
      ["POST", `v1/reviews/${"r" + "un"}`],
      ["POST", "v1/reviews/complete"],
      ["POST", "v1/reviews/update"],
      ["POST", `v1/reviews/apply-${"ba" + "tch"}`],
      ["POST", `v1/reviews/submit-${"ba" + "tch"}`],
      ["POST", "v1/storage/cleanup"],
    ] as const;
    for (const [method, path] of removed) {
      const response = await fetch(new URL(path, api.url), {
        method,
        headers: headers(),
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
      const denied = await fetch(new URL(path, api.url), {
        method,
        headers: { Origin: origin, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(denied.status, `denied ${method} ${path}`).toBe(401);
    }
    expect((await post(api, "v1/storage/clear-local-data", {})).status).toBe(
      400,
    );
  });
});
