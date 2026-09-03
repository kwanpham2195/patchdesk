import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeGitHubAdapter } from "../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../src/adapters/storage/profile-store";
import { ReviewRemoteStore } from "../src/adapters/storage/review-remote-store";
import { ReviewStore } from "../src/adapters/storage/review-store";
import { ReviewSessionStore } from "../src/adapters/storage/review-session-store";
import { createReview } from "../src/domain/review";
import { createReviewSession } from "../src/domain/review-session";
import {
  createReviewSessionId,
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseGitHubThreadId,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../src/domain/ids";
import { parseWorkspaceProfileConfig } from "../src/domain/workspace-profile";
import {
  startLocalApiServer,
  type LocalApiServer,
} from "../src/main/local-api";

const capability = "test-capability";
const origin = "http://patchdesk.test";
const AVATAR_URL = "https://avatars.githubusercontent.com/u/1?v=4";
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

function must<T>(
  result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" },
): T {
  if (result._tag === "err") throw new Error("invalid fixture");
  return result.value;
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

/** Mirrors `tests/browser/local-api-workbench.spec.ts`'s seed, plus one comment with an avatar URL. */
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
    // SAFETY: this literal is a well-formed ISO 8601 instant, satisfying the
    // branded IsoTimestamp contract `createdAt` requires.
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
      // SAFETY: `summary()` matches `PullRequestSummary` field-for-field
      // (branded ref/GitSha fields as plain strings); fixture data, not a
      // runtime-decoded value.
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

describe("local API avatar fetcher configuration seam", () => {
  it("uses an injected fetchAvatar override instead of the real network fetcher during a refresh", async () => {
    root = await mkdtemp(join(tmpdir(), "patchdesk-avatar-fetcher-"));
    const paths = PatchdeskPaths.forTest(root);
    const seeded = await seedRepresentedReview(paths);

    const fetchAvatarCalls: string[] = [];
    const stubFetchAvatar = vi.fn(async (avatarUrl: string) => {
      fetchAvatarCalls.push(avatarUrl);
      return { bytes: new Uint8Array([1, 2, 3]) };
    });
    // Any real network fetch (i.e. the production `createAvatarFetcher`
    // reaching out to avatars.githubusercontent.com) would go through the
    // global fetch. Spying on it proves the stub above was used instead.
    const globalFetchSpy = vi.spyOn(globalThis, "fetch");

    const started = await startLocalApiServer({
      capability,
      allowedOrigin: origin,
      paths,
      fetchAvatar: stubFetchAvatar,
      github: new FakeGitHubAdapter({
        // SAFETY: `summary()` matches `PullRequestSummary` field-for-field
        // (branded ref/GitSha fields as plain strings); fixture data, not a
        // runtime-decoded value.
        pullRequest: summary() as never,
        comments: {
          threads: [
            {
              id: must(parseGitHubThreadId("thread-1")),
              state: "open",
              comments: [
                {
                  id: "comment-1",
                  author: "octocat",
                  authorAvatarUrl: AVATAR_URL,
                  body: "hello",
                  // SAFETY: this literal is a well-formed ISO 8601 instant,
                  // satisfying the branded IsoTimestamp contract `createdAt`
                  // requires.
                  createdAt: "2026-08-01T00:00:00.000Z" as never,
                },
              ],
            },
          ],
          complete: true,
        },
        checks: { overall: "passing", checks: [] },
      }),
    });
    if (started._tag !== "started") throw new Error("local API did not start");
    server = started.server;

    const refreshed = await fetch(new URL("v1/reviews/refresh", server.url), {
      method: "POST",
      headers: {
        Origin: origin,
        "X-Patchdesk-Capability": capability,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        profileId: "cfw",
        reviewId: seeded.reviewId,
      }),
    });
    expect(refreshed.status).toBeLessThan(400);

    expect(stubFetchAvatar).toHaveBeenCalledWith(AVATAR_URL);
    expect(fetchAvatarCalls).toEqual([AVATAR_URL]);
    const realNetworkCalls = globalFetchSpy.mock.calls.filter(([input]) =>
      String(input).includes("avatars.githubusercontent.com"),
    );
    expect(realNetworkCalls).toHaveLength(0);
  });
});
