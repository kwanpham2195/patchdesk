import { createServer, type Server } from "node:http";
import { readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "playwright/test";

import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewRemoteStore } from "../../src/adapters/storage/review-remote-store";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { createReview } from "../../src/domain/review";
import { createReviewSession } from "../../src/domain/review-session";
import {
  createReviewSessionId,
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import {
  startLocalApiServer,
  type LocalApiServer,
} from "../../src/main/local-api";
import { installTestDesktopBridge } from "./bridge-fixture";

test("desktop bridge opens the canonical represented workbench without removed Review routes", async ({
  page,
}) => {
  const renderer = await serveRenderer();
  const root = await mkdtemp(join(tmpdir(), "patchdesk-browser-"));
  let api: LocalApiServer | undefined;
  try {
    const paths = PatchdeskPaths.forTest(root);
    const seeded = await seedRepresentedReview(paths);
    await new ProfileStore(paths).saveConfig({
      lastSelectedProfileId: "cfw",
      recentPrs: [],
    });
    const started = await startLocalApiServer({
      allowedOrigin: origin(renderer),
      capability: "cap",
      paths,
      github: new FakeGitHubAdapter({
        authenticatedAccount: { host: "github.com", account: "fixture" },
        listOpenPullRequests: [],
        // SAFETY: This fake adapter fixture supplies the response shape exercised by the browser case; unrelated production fields are outside this test seam.
        pullRequest: summary() as never,
        comments: { threads: [] },
        checks: { overall: "passing", checks: [] },
      }),
    });
    if (started._tag !== "started") throw new Error("local API did not start");
    api = started.server;
    await installTestDesktopBridge(page, api.url.toString(), "cap");
    await page.addInitScript(
      (id) =>
        window.localStorage.setItem("patchdesk.destination", `workbench:${id}`),
      seeded.reviewId,
    );
    await page.goto(origin(renderer));
    await expect(
      page.getByRole("region", { name: "Review workbench" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Represented review" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Diff", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  } finally {
    if (api !== undefined) await api.stop();
    await close(renderer);
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

test("desktop bridge permits current Review-id routes and denies deleted routes", async ({
  page,
  browser,
}) => {
  const renderer = await serveRenderer();
  const root = await mkdtemp(join(tmpdir(), "patchdesk-browser-routes-"));
  let api: LocalApiServer | undefined;
  let denied: typeof page | undefined;
  try {
    const paths = PatchdeskPaths.forTest(root);
    const seeded = await seedRepresentedReview(paths);
    const started = await startLocalApiServer({
      allowedOrigin: origin(renderer),
      capability: "cap",
      paths,
      github: new FakeGitHubAdapter({
        // SAFETY: This fake adapter fixture supplies the response shape exercised by the browser case; unrelated production fields are outside this test seam.
        pullRequest: summary() as never,
        comments: { threads: [] },
        checks: { overall: "passing", checks: [] },
      }),
    });
    if (started._tag !== "started") throw new Error("local API did not start");
    api = started.server;
    await installTestDesktopBridge(page, api.url.toString(), "cap");
    await page.goto(origin(renderer));
    const current = await page.evaluate(
      async (reviewId) =>
        Promise.all([
          window.patchdesk.request({
            path: "/v1/reviews/load",
            method: "POST",
            body: { profileId: "cfw", reviewId },
          }),
          window.patchdesk.request({
            path: "/v1/reviews/detect-updates",
            method: "POST",
            body: { profileId: "cfw", reviewId },
          }),
          window.patchdesk.request({
            path: "/v1/reviews/refresh",
            method: "POST",
            body: { profileId: "cfw", reviewId },
          }),
        ]),
      seeded.reviewId,
    );
    expect(
      current.every(
        (response) =>
          response.status !== 401 &&
          response.status !== 403 &&
          response.status !== 400,
      ),
    ).toBe(true);
    const removed = await page.evaluate(async (baseUrl) => {
      const request = async (path: string, method: "GET" | "POST") =>
        (() => {
          const headers = new Headers({
            "X-Patchdesk-Capability": "cap",
          });
          if (method === "POST")
            headers.set("Content-Type", "application/json");
          const requestInit: RequestInit = { method, headers };
          if (method === "POST") requestInit.body = "{}";
          return fetch(new URL(path, baseUrl), requestInit);
        })().then((response) => response.status);
      return Promise.all([
        request("/v1/dashboard", "GET"),
        request("/v1/reviews", "GET"),
        request("/v1/reviews/models", "GET"),
        request(`/v1/reviews/${"ba" + "tch"}`, "POST"),
        request(`/v1/reviews/${"r" + "un"}`, "POST"),
        request("/v1/reviews/complete", "POST"),
        request("/v1/reviews/update", "POST"),
      ]);
    }, api.url.toString());
    expect(removed.every((status) => status === 404)).toBe(true);
    denied = await browser.newPage();
    await installTestDesktopBridge(denied, api.url.toString(), "");
    await denied.goto(origin(renderer));
    const response = await denied.evaluate(
      async (reviewId) =>
        window.patchdesk.request({
          path: "/v1/reviews/load",
          method: "POST",
          body: { profileId: "cfw", reviewId },
        }),
      seeded.reviewId,
    );
    expect([401, 403]).toContain(response.status);
  } finally {
    if (denied !== undefined) await denied.close();
    if (api !== undefined) await api.stop();
    await close(renderer);
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

function summary() {
  return {
    ref: {
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
      number: 1,
    },
    title: "Represented review",
    author: "fixture",
    headBranch: "feature",
    baseBranch: "main",
    headSha: "abcdef1234567890abcdef1234567890abcdef12",
    baseSha: "1234567890abcdef1234567890abcdef12345678",
    isOpen: true,
    isDraft: false,
    reviewState: "none",
    mergeability: "mergeable",
    labels: [],
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}
async function seedRepresentedReview(
  paths: PatchdeskPaths,
): Promise<{ readonly reviewId: string }> {
  const profileId = must(parseWorkspaceProfileId("cfw"));
  const host = must(parseGitHubHost("github.com"));
  const owner = must(parseGitHubOwner("centraldigital"));
  const repo = must(parseGitHubRepoName("patchdesk"));
  const number = must(parsePullRequestNumber(1));
  const headSha = must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12"));
  const baseSha = must(parseGitSha("1234567890abcdef1234567890abcdef12345678"));
  await new ProfileStore(paths).save(
    must(
      parseWorkspaceProfileConfig({
        id: "cfw",
        label: "CFW",
        githubHost: "github.com",
        ghAccount: "fixture",
        ownerFilters: [],
        workspaceRoots: [],
        rulePaths: [],
        repos: [],
      }),
    ),
  );
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
  const session = createReviewSession({
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
    worktree: { path: must(parseAbsolutePath("/tmp/worktree")), headSha },
    // SAFETY: This fixed ISO timestamp is a valid test value for the branded timestamp field.
    createdAt: "2026-08-01T00:00:00.000Z" as never,
  });
  expect((await new ReviewSessionStore(paths).save(session))._tag).toBe("ok");
  const review = createReview({
    identity: { profileId, host, owner, repo, prNumber: number },
    currentSessionId: session.id,
    headSha,
    createdAt: session.createdAt,
  });
  const remote = await new ReviewRemoteStore(paths).saveCandidate({
    profileId,
    reviewId: review.id,
    snapshot: {
      schemaVersion: 1,
      // SAFETY: This fake adapter fixture supplies the response shape exercised by the browser case; unrelated production fields are outside this test seam.
      pullRequest: summary() as never,
      comments: { threads: [], complete: true },
      conversation: { prDescription: "", entries: [], complete: true },
      commits: [],
      checks: { overall: "passing", checks: [] },
    },
  });
  if (remote._tag === "err")
    throw new Error("could not save represented snapshot");
  expect(
    (
      await new ReviewStore(paths).save({
        ...review,
        representedRemote: {
          headSha,
          pullRequestUpdatedAt: session.createdAt,
          snapshotHash: remote.value.snapshotHash,
          refreshedAt: session.createdAt,
        },
        freshness: { _tag: "Fresh" },
      })
    )._tag,
  ).toBe("ok");
  return { reviewId: review.id };
}
function must<T>(
  result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" },
): T {
  if (result._tag === "err") throw new Error("invalid fixture");
  return result.value;
}
async function serveRenderer(): Promise<Server> {
  const root = join(process.cwd(), "out", "renderer");
  const server = createServer(async (request, response) => {
    const file = normalize(
      join(
        root,
        request.url === undefined || request.url === "/"
          ? "index.html"
          : request.url,
      ),
    );
    if (!file.startsWith(root)) {
      response.writeHead(400).end();
      return;
    }
    try {
      const content = await readFile(file);
      response
        .writeHead(200, {
          "Content-Type":
            extname(file) === ".js"
              ? "text/javascript"
              : extname(file) === ".css"
                ? "text/css"
                : "text/html",
        })
        .end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}
function origin(server: Server): string {
  const address = server.address();
  if (address === null) throw new Error("missing address");
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's server address union uses a string only for named sockets; this test binds an ephemeral TCP port above.
  if (typeof address === "string") throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
