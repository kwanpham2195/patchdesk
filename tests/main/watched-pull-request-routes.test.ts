import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeGitHubAdapter } from "../../src/adapters/github/fake-github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { WatchedPullRequestStore } from "../../src/adapters/storage/watched-pull-request-store";
import {
  parseIsoTimestamp,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type { RawJsonValue } from "../../src/domain/json";
import { ok, type Result } from "../../src/domain/result";
import { parseWatchedPullRequests } from "../../src/domain/watched-pull-request";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { registerWatchedPullRequestRoutes } from "../../src/main/routes/watched-pull-request-routes";
import { WatchedPullRequestService } from "../../src/services/watched-pull-request-service";

function mustParse<T, E>(result: Result<T, E>): T {
  if (result._tag === "err") throw new Error("invalid fixture");
  return result.value;
}

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

const profileId = mustParse(parseWorkspaceProfileId("acme"));
const profile = mustParse(
  parseWorkspaceProfileConfig({
    id: "acme",
    label: "ACME",
    githubHost: "github.com",
    ghAccount: "octo-dev",
    workspaceRoots: [],
    rulePaths: [],
    repos: [],
  }),
);
const snapshot = {
  updatedAt: "2026-09-16T10:00:00.000Z",
  headSha: "a".repeat(40),
  reviewState: "none",
  checks: "unknown",
  state: "open",
} as const;
const pullRequest = (number: number) => ({
  host: "github.com",
  owner: "acme",
  repo: "widgets",
  number,
});

async function routeFixture(
  watchedCount: number,
  remoteState: "open" | "merged" | "closed" = "open",
) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-watched-route-"));
  roots.push(root);
  const store = new WatchedPullRequestStore(PatchdeskPaths.forTest(root));
  await store.save(
    profileId,
    mustParse(
      parseWatchedPullRequests(
        Array.from({ length: watchedCount }, (_, index) => ({
          ref: pullRequest(index + 1),
          snapshot,
          watchedAt: "2026-09-16T09:00:00.000Z",
        })),
      ),
    ),
  );
  const github = new FakeGitHubAdapter({
    watchedPullRequests: mustParse(
      parseWatchedPullRequests([
        {
          ref: pullRequest(99),
          snapshot: { ...snapshot, state: remoteState },
          watchedAt: "2026-09-16T09:00:00.000Z",
        },
      ]),
    ),
  });
  const watchedPullRequests = new WatchedPullRequestService({
    profiles: { load: async () => ok(profile) },
    store,
    github,
    now: () => mustParse(parseIsoTimestamp("2026-09-17T10:00:00.000Z")),
    notifier: undefined,
    onChange: undefined,
  });
  const app = new Hono();
  // SAFETY: the routes under test reach only the watched pull request service.
  registerWatchedPullRequestRoutes(app, { watchedPullRequests } as never);
  return {
    github,
    store,
    post: (body: RawJsonValue) =>
      app.request("/v1/watched-pull-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

describe("POST /v1/watched-pull-requests", () => {
  it("watches a pull request and answers the watched list", async () => {
    const fixture = await routeFixture(1);
    const response = await fixture.post({
      profileId: "acme",
      pullRequest: pullRequest(99),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      pullRequests: [pullRequest(1), pullRequest(99)],
    });
  });

  it("refuses the 21st watch with the tag and limit, before reading GitHub", async () => {
    const fixture = await routeFixture(20);
    const response = await fixture.post({
      profileId: "acme",
      pullRequest: pullRequest(99),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { _tag: "WatchLimitReached", limit: 20 },
    });
    expect(fixture.github.calls.readWatchedPullRequests).toEqual([]);
  });

  it.each(["merged", "closed"] as const)(
    "refuses a %s pull request without saving it",
    async (state) => {
      const fixture = await routeFixture(0, state);
      const response = await fixture.post({
        profileId: "acme",
        pullRequest: pullRequest(99),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: { _tag: "WatchedPullRequestTerminal", state },
      });
      await expect(fixture.store.load(profileId)).resolves.toEqual({
        _tag: "ok",
        value: [],
      });
    },
  );

  it("rejects a body with an unknown field", async () => {
    const fixture = await routeFixture(0);
    const response = await fixture.post({
      profileId: "acme",
      pullRequest: pullRequest(99),
      extra: true,
    });

    expect(response.status).toBe(400);
  });
});
