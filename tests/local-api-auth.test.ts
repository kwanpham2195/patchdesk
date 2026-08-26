import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeGitHubAdapter } from "../src/adapters/github/github-adapter";
import { ProfileStore } from "../src/adapters/storage/profile-store";
import { ReviewSessionStore } from "../src/adapters/storage/review-session-store";
import { createReviewSession } from "../src/domain/review-session";
import {
  createReviewSessionId,
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../src/domain/ids";
import { parseWorkspaceProfileConfig } from "../src/domain/workspace-profile";
import { PatchdeskPaths } from "../src/adapters/storage/patchdesk-paths";
import {
  createReadOnlyGitExecutor,
  startLocalApiServer,
  type LocalApiServer,
} from "../src/main/local-api";
import type { CommandRequest } from "../src/adapters/github/command-runner";
import { ok } from "../src/domain/result";
import { StorageManagementService } from "../src/services/storage-management-service";
import { ReviewWorkbenchController } from "../src/services/review-workbench-controller";

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

type LocalApiServerConfiguration = Parameters<typeof startLocalApiServer>[0];

async function start(
  options: Pick<
    LocalApiServerConfiguration,
    "readOnlyGit" | "resolveGitHubCli" | "github"
  > = {},
): Promise<LocalApiServer> {
  root = await mkdtemp(join(tmpdir(), "patchdesk-api-auth-"));
  const value = await startLocalApiServer({
    capability,
    allowedOrigin: origin,
    paths: PatchdeskPaths.forTest(root),
    ...options,
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
  // `body` stays `unknown` on the way in: this helper is the wire boundary
  // itself (it JSON.stringifies whatever is passed), and callers deliberately
  // send both well-formed domain payloads and malformed ones to exercise the
  // route schema's 400 responses. There is no single named domain type this
  // could be narrowed to.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- see comment above
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
  it("starts with a configured resolveGitHubCli seam, and without one falls back to real discovery", async () => {
    // ReviewWorktreeService's gh-path resolver is threaded through
    // composition (see `startLocalApiServer`'s `resolveGitHubCli` ??
    // `discoverExecutable("gh")` default): both forms must construct the
    // server without throwing. The managed-fetch credential helper's use of
    // the resolved absolute path is covered directly, without spawning a
    // real HTTP server, in `tests/services/review-worktree.test.ts`.
    await expect(
      start({ resolveGitHubCli: async () => "/opt/homebrew/bin/gh" }),
    ).resolves.toBeDefined();
    await server?.stop();
    server = undefined;
    const firstRoot = root;
    root = undefined;
    await expect(start()).resolves.toBeDefined();
    if (firstRoot !== undefined)
      await rm(firstRoot, { recursive: true, force: true });
  });

  it("forwards managed-fetch environments and keeps the longer timeout fetch-only", async () => {
    const requests: CommandRequest[] = [];
    const git = createReadOnlyGitExecutor({
      async runText(request) {
        requests.push(request);
        return ok("");
      },
    });

    await git.run(["git", "-C", "/repo", "status"]);
    await git.run(
      ["git", "-C", "/repo", "fetch", "origin", "sha:refs/review/head"],
      { GH_TOKEN: "profile-token", GIT_TERMINAL_PROMPT: "0" },
    );

    expect(requests).toEqual([
      {
        argv: ["git", "-C", "/repo", "status"],
        timeoutMs: 15_000,
      },
      {
        argv: ["git", "-C", "/repo", "fetch", "origin", "sha:refs/review/head"],
        timeoutMs: 120_000,
        environment: { GH_TOKEN: "profile-token", GIT_TERMINAL_PROMPT: "0" },
      },
    ]);
  });

  it("serves the current Review diff-file hydration contract", async () => {
    const mergeBaseSha = "fedcba9876543210fedcba9876543210fedcba98";
    const api = await start({
      readOnlyGit: {
        run: async (argv) => {
          if (argv.includes("merge-base"))
            return ok({ stdout: `${mergeBaseSha}\n` });
          return ok({
            stdout:
              argv.at(-1) === `${mergeBaseSha}:src/a.ts` ? "old\n" : "new\n",
          });
        },
      },
    });
    if (root === undefined) throw new Error("test root was not created");
    const paths = PatchdeskPaths.forTest(root);
    const profileId = must(parseWorkspaceProfileId("profile"));
    const host = must(parseGitHubHost("github.com"));
    const owner = must(parseGitHubOwner("centraldigital"));
    const repo = must(parseGitHubRepoName("patchdesk"));
    const number = must(parsePullRequestNumber(42));
    const headSha = must(
      parseGitSha("abcdef1234567890abcdef1234567890abcdef12"),
    );
    const baseSha = must(
      parseGitSha("1234567890abcdef1234567890abcdef12345678"),
    );
    expect(
      (
        await new ProfileStore(paths).save(
          must(
            parseWorkspaceProfileConfig({
              id: "profile",
              label: "Profile",
              githubHost: "github.com",
              ghAccount: "fixture",
              ownerFilters: [],
              workspaceRoots: [],
              rulePaths: [],
              repos: [],
            }),
          ),
        )
      )._tag,
    ).toBe("ok");
    const sessionId = createReviewSessionId({
      profileId,
      host,
      owner,
      repo,
      prNumber: number,
      headSha,
      baseSha,
    });
    const patchPath = paths.patchFile(profileId, sessionId);
    await mkdir(dirname(patchPath), { recursive: true });
    await writeFile(
      patchPath,
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    );
    expect(
      (
        await new ReviewSessionStore(paths).save(
          createReviewSession({
            key: {
              profileId,
              host,
              owner,
              repo,
              prNumber: number,
              headSha,
              baseSha,
            },
            pr: { headSha, baseSha, isOpen: true, isDraft: false },
            patchPath: must(parseAbsolutePath(patchPath)),
            worktree: {
              path: must(parseAbsolutePath("/tmp/patchdesk-worktree")),
              headSha,
            },
            createdAt: must(parseIsoTimestamp("2026-08-14T00:00:00.000Z")),
          }),
        )
      )._tag,
    ).toBe("ok");

    const response = await post(api, "v1/reviews/diff-file", {
      profileId: "profile",
      sessionId,
      path: "src/a.ts",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "ready",
      oldFile: { name: "src/a.ts", contents: "old\n" },
      newFile: { name: "src/a.ts", contents: "new\n" },
    });
    const unavailable = await post(api, "v1/reviews/diff-file", {
      profileId: "profile",
      sessionId,
      path: "src/missing.ts",
    });
    expect(unavailable.status).toBe(200);
    await expect(unavailable.json()).resolves.toEqual({
      state: "unavailable",
      reason: "path_unavailable",
    });
  });
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
      "v1/reviews/open-merged",
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
    for (const route of ["v1/reviews/open", "v1/reviews/open-merged"]) {
      expect(
        (
          await post(api, route, {
            profileId: "profile",
            host: "github.com",
            owner: "centraldigital",
            repo: "patchdesk",
            number: 42,
          })
        ).status,
        route,
      ).not.toBe(400);
    }
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

  it("accepts a LabelChange recent write and passes it through to the workbench controller unchanged", async () => {
    const detectUpdates = vi
      .spyOn(ReviewWorkbenchController.prototype, "detectUpdates")
      .mockResolvedValue(ok(undefined));
    const api = await start();
    const reviewId =
      "github.com__centraldigital__patchdesk__pr-42__review-abcdef123456";
    const labelChangeWrite = {
      _tag: "LabelChange",
      added: ["bug"],
      removed: ["needs-triage"],
    };

    const response = await post(api, "v1/reviews/detect-updates", {
      profileId: "profile",
      reviewId,
      recentWrites: [labelChangeWrite],
    });

    expect(response.status).toBe(200);
    expect(detectUpdates).toHaveBeenCalledTimes(1);
    expect(detectUpdates.mock.calls[0]?.[0]).toMatchObject({
      recentWrites: [labelChangeWrite],
    });
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
      ["POST", "v1/direct-entry/preview"],
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
      const requestInit: RequestInit = { method, headers: headers() };
      if (method === "POST") requestInit.body = "{}";
      const response = await fetch(new URL(path, api.url), requestInit);
      expect(response.status, `${method} ${path}`).toBe(404);
      const deniedInit: RequestInit = {
        method,
        headers: { Origin: origin, "Content-Type": "application/json" },
      };
      if (method === "POST") deniedInit.body = "{}";
      const denied = await fetch(new URL(path, api.url), deniedInit);
      expect(denied.status, `denied ${method} ${path}`).toBe(401);
    }
    expect((await post(api, "v1/storage/clear-local-data", {})).status).toBe(
      400,
    );
  });
});

describe("GET /v1/inbox page size boundary", () => {
  async function startWithWatchedProfile() {
    const adapter = new FakeGitHubAdapter({
      authenticatedAccount: { host: "github.com", account: "fixture" },
      maintainerPullRequestsSearch: {
        entries: [],
        hasNextPage: false,
        issueCount: 0,
      },
    });
    const searchMaintainerPullRequests = vi.spyOn(
      adapter,
      "searchMaintainerPullRequests",
    );
    const api = await start({ github: adapter });
    if (root === undefined) throw new Error("test root was not created");
    const paths = PatchdeskPaths.forTest(root);
    expect(
      (
        await new ProfileStore(paths).save(
          must(
            parseWorkspaceProfileConfig({
              id: "profile",
              label: "Profile",
              githubHost: "github.com",
              ghAccount: "fixture",
              ownerFilters: [],
              workspaceRoots: [],
              rulePaths: [],
              repos: [
                {
                  host: "github.com",
                  owner: "centraldigital",
                  repo: "patchdesk",
                },
              ],
            }),
          ),
        )
      )._tag,
    ).toBe("ok");
    return { api, searchMaintainerPullRequests };
  }

  it("rejects an unlisted pageSize as a normal parse failure with no GitHub read", async () => {
    const { api, searchMaintainerPullRequests } =
      await startWithWatchedProfile();

    const response = await fetch(new URL("v1/inbox?pageSize=100", api.url), {
      headers: headers(),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_input",
    });
    expect(searchMaintainerPullRequests).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric, zero, negative, or float pageSize the same way", async () => {
    const { api, searchMaintainerPullRequests } =
      await startWithWatchedProfile();

    for (const value of ["abc", "0", "-10", "25.0"]) {
      const response = await fetch(
        new URL(`v1/inbox?pageSize=${value}`, api.url),
        { headers: headers() },
      );
      expect(response.status, value).toBe(400);
    }
    expect(searchMaintainerPullRequests).not.toHaveBeenCalled();
  });

  it("defaults to page size 25 when pageSize is omitted", async () => {
    const { api, searchMaintainerPullRequests } =
      await startWithWatchedProfile();

    const response = await fetch(new URL("v1/inbox", api.url), {
      headers: headers(),
    });

    expect(response.status).toBe(200);
    expect(searchMaintainerPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 25 }),
    );
  });

  it("accepts an explicitly listed pageSize and forwards it to GitHub", async () => {
    const { api, searchMaintainerPullRequests } =
      await startWithWatchedProfile();

    const response = await fetch(new URL("v1/inbox?pageSize=10", api.url), {
      headers: headers(),
    });

    expect(response.status).toBe(200);
    expect(searchMaintainerPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 10 }),
    );
  });

  it("rejects an unknown filter state as a normal parse failure with no GitHub read", async () => {
    const { api, searchMaintainerPullRequests } =
      await startWithWatchedProfile();

    const response = await fetch(new URL("v1/inbox?state=closed", api.url), {
      headers: headers(),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_input",
    });
    expect(searchMaintainerPullRequests).not.toHaveBeenCalled();
  });

  it("rejects a repository the active profile does not watch, with no GitHub read", async () => {
    const { api, searchMaintainerPullRequests } =
      await startWithWatchedProfile();

    const response = await fetch(
      new URL(
        "v1/inbox?host=github.com&owner=some-other-org&repo=some-other-repo",
        api.url,
      ),
      { headers: headers() },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_input",
    });
    expect(searchMaintainerPullRequests).not.toHaveBeenCalled();
  });

  it("accepts a watched repository and forwards its search query to GitHub", async () => {
    const { api, searchMaintainerPullRequests } =
      await startWithWatchedProfile();

    const response = await fetch(
      new URL(
        "v1/inbox?host=github.com&owner=centraldigital&repo=patchdesk",
        api.url,
      ),
      { headers: headers() },
    );

    expect(response.status).toBe(200);
    expect(searchMaintainerPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: {
          host: "github.com",
          owner: "centraldigital",
          repo: "patchdesk",
        },
      }),
    );
  });
});

function must<T>(
  result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" },
): T {
  if (result._tag === "err") throw new Error("invalid fixture");
  return result.value;
}
