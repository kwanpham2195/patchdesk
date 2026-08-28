import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { closeServer, serveRenderer, serverOrigin } from "./renderer-server";

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
      allowedOrigin: serverOrigin(renderer),
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
    await page.goto(serverOrigin(renderer));
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
    await closeServer(renderer);
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
