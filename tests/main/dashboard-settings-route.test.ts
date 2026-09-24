import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeGitHubAdapter } from "../../src/adapters/github/fake-github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import type { NotificationSettings } from "../../src/domain/contracts";
import type { RawJsonValue } from "../../src/domain/json";
import { registerDashboardRoutes } from "../../src/main/routes/dashboard-routes";
import { DashboardController } from "../../src/services/dashboard-controller";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

async function routeFixture() {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-settings-route-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  const dashboard = new DashboardController(
    new ProfileStore(paths),
    new FakeGitHubAdapter({}),
    undefined,
    paths,
  );
  const saved: NotificationSettings[] = [];
  const app = new Hono();
  // SAFETY: the settings routes under test reach only the dashboard controller.
  registerDashboardRoutes(app, { dashboard } as never, (notifications) =>
    saved.push(notifications),
  );
  return {
    saved,
    patch: (body: RawJsonValue) =>
      app.request("/v1/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

describe("PATCH /v1/settings", () => {
  it("tells the watched pull request poll the saved interval", async () => {
    const fixture = await routeFixture();
    const response = await fixture.patch({
      notifications: {
        enabled: true,
        preparationAndMerge: false,
        intervalMinutes: 10,
      },
    });

    expect(response.status).toBe(200);
    expect(fixture.saved).toMatchObject([{ intervalMinutes: 10 }]);
  });

  it("tells the poll nothing when the patch is refused", async () => {
    const fixture = await routeFixture();
    const response = await fixture.patch({
      notifications: { enabled: true, intervalMinutes: 2 },
    });

    expect(response.status).toBe(400);
    expect(fixture.saved).toEqual([]);
  });
});
