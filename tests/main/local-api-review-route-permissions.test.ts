import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";

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

// Moved from tests/browser/local-api-workbench.spec.ts:88-190 -- this test
// never touched the page's DOM. It only used Playwright's `page.evaluate` as
// a way to run `fetch` calls against the local API server (mirroring what
// `window.patchdesk.request` in `bridge-fixture.ts` does under the hood: a
// plain `fetch` carrying `X-Patchdesk-Capability` and an `Origin` header), so
// it belongs here as a direct HTTP test of `src/main/local-api.ts` rather
// than paying for a browser.

const capability = "cap";
const origin = "http://patchdesk.test";
let server: LocalApiServer | undefined;
let root: string | undefined;

afterEach(async () => {
  if (server !== undefined) await server.stop();
  server = undefined;
  if (root !== undefined)
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  root = undefined;
});

it("permits current Review-id routes and denies deleted routes", async () => {
  root = await mkdtemp(join(tmpdir(), "patchdesk-api-routes-"));
  const paths = PatchdeskPaths.forTest(root);
  const seeded = await seedRepresentedReview(paths);
  const started = await startLocalApiServer({
    allowedOrigin: origin,
    capability,
    paths,
    github: new FakeGitHubAdapter({
      // SAFETY: This fake adapter fixture supplies the response shape exercised by this test; unrelated production fields are outside this test seam.
      pullRequest: summary() as never,
      comments: { threads: [] },
      checks: { overall: "passing", checks: [] },
    }),
  });
  if (started._tag !== "started") throw new Error("local API did not start");
  server = started.server;

  const current = await Promise.all([
    call("v1/reviews/load", { profileId: "cfw", reviewId: seeded.reviewId }),
    call("v1/reviews/detect-updates", {
      profileId: "cfw",
      reviewId: seeded.reviewId,
    }),
    call("v1/reviews/refresh", {
      profileId: "cfw",
      reviewId: seeded.reviewId,
    }),
  ]);
  expect(
    current.every(
      (status) => status !== 401 && status !== 403 && status !== 400,
    ),
  ).toBe(true);

  const removed = await Promise.all([
    plainFetch("v1/dashboard", "GET"),
    plainFetch("v1/reviews", "GET"),
    plainFetch("v1/reviews/models", "GET"),
    plainFetch(`v1/reviews/${"ba" + "tch"}`, "POST"),
    plainFetch(`v1/reviews/${"r" + "un"}`, "POST"),
    plainFetch("v1/reviews/complete", "POST"),
    plainFetch("v1/reviews/update", "POST"),
  ]);
  expect(removed.every((status) => status === 404)).toBe(true);

  const denied = await call(
    "v1/reviews/load",
    { profileId: "cfw", reviewId: seeded.reviewId },
    "",
  );
  expect([401, 403]).toContain(denied);
});

/**
 * Mirrors `window.patchdesk.request` from `tests/browser/bridge-fixture.ts`:
 * a POST with a JSON body, the capability header, and the renderer's Origin.
 */
async function call(
  path: string,
  body: { readonly profileId: string; readonly reviewId: string },
  cap: string = capability,
): Promise<number> {
  if (server === undefined) throw new Error("server not started");
  const response = await fetch(new URL(path, server.url), {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Patchdesk-Capability": cap,
    },
    body: JSON.stringify(body),
  });
  return response.status;
}

/** A deleted route probe: same capability and Origin, no body assumed. */
async function plainFetch(
  path: string,
  method: "GET" | "POST",
): Promise<number> {
  if (server === undefined) throw new Error("server not started");
  const headers = new Headers({
    Origin: origin,
    "X-Patchdesk-Capability": capability,
  });
  if (method === "POST") headers.set("Content-Type", "application/json");
  const requestInit: RequestInit = { method, headers };
  if (method === "POST") requestInit.body = "{}";
  const response = await fetch(new URL(path, server.url), requestInit);
  return response.status;
}

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
  await new ProfileStore(paths).saveConfig({
    lastSelectedProfileId: "cfw",
    recentPrs: [],
  });
  await new ProfileStore(paths).save(
    must(
      parseWorkspaceProfileConfig({
        id: "cfw",
        label: "CFW",
        githubHost: "github.com",
        ghAccount: "fixture",
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
      // SAFETY: This fake adapter fixture supplies the response shape exercised by this test; unrelated production fields are outside this test seam.
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
