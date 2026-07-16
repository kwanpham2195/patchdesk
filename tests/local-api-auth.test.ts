import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  startLocalApiServer,
  type LocalApiServer,
} from "../src/main/local-api";
import { FakeGitHubAdapter, type GitHubReader, type GitHubReviewWriter } from "../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../src/adapters/storage/profile-store";
import { ReviewSessionStore } from "../src/adapters/storage/review-session-store";
import { parseAbsolutePath, parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parseGitSha, parsePullRequestNumber, parseReviewAttemptId, parseWorkspaceProfileId } from "../src/domain/ids";
import { createReviewSession, type ReviewSession } from "../src/domain/review-session";
import type { ReviewDraft } from "../src/domain/review-draft";
import { parseWorkspaceProfileConfig } from "../src/domain/workspace-profile";

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

  it("keeps review writes unavailable when the API receives only a GitHub reader", async () => {
    const paths = PatchdeskPaths.forTest(await mkdtemp(join(tmpdir(), "patchdesk-api-")));
    const reader = { async getPullRequest() { return { _tag: "err" as const, error: { _tag: "GitHubReadFailed" as const } }; } } as unknown as GitHubReader;
    const startup = await startLocalApiServer({ capability, allowedOrigin, paths, github: reader });
    if (startup._tag !== "started") throw new Error("Expected local API");
    localApi = startup.server;
    const response = await fetch(new URL("v1/reviews/pending", localApi.url), { method: "POST", headers: writeHeaders(), body: "{}" });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "review_write_unavailable" });
  });

  it("persists a created pending review through the capability-authenticated local API", async () => {
    const fixture = await reviewWriteFixture({ _tag: "ok", value: { reviewId: "9001", state: "PENDING" } });
    localApi = fixture.api;
    const response = await fetch(new URL("v1/reviews/pending", localApi.url), { method: "POST", headers: writeHeaders(), body: JSON.stringify(fixture.request) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ draft: { state: { _tag: "PendingGitHubReview", pendingReviewId: "9001" } } });
    await expect(fixture.sessions.load(fixture.profileId, fixture.session.id)).resolves.toMatchObject({ _tag: "ok", value: { draftContent: { state: { _tag: "PendingGitHubReview", pendingReviewId: "9001" } } } });
  });

  it("persists DraftFailed after a rejected pending-review write and never advances its phase", async () => {
    const fixture = await reviewWriteFixture({ _tag: "err", error: { _tag: "GitHubWriteFailure", category: "rejected", message: "Rejected by fixture." } });
    localApi = fixture.api;
    const response = await fetch(new URL("v1/reviews/pending", localApi.url), { method: "POST", headers: writeHeaders(), body: JSON.stringify(fixture.request) });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "github_rejected" });
    await expect(fixture.sessions.load(fixture.profileId, fixture.session.id)).resolves.toMatchObject({ _tag: "ok", value: { state: { _tag: "ReviewCompleted" }, draftContent: { state: { _tag: "DraftFailed" } } } });
  });
});

async function startTestLocalApi(): Promise<LocalApiServer> {
  const startup = await startLocalApiServer({ capability, allowedOrigin });
  if (startup._tag !== "started") {
    throw new Error("Expected valid local API startup");
  }

  return startup.server;
}

function writeHeaders(): Record<string, string> {
  return { "X-Patchdesk-Capability": capability, Origin: allowedOrigin, "Content-Type": "application/json" };
}

async function reviewWriteFixture(createResult: Awaited<ReturnType<GitHubReviewWriter["createPendingReview"]>>) {
  const paths = PatchdeskPaths.forTest(await mkdtemp(join(tmpdir(), "patchdesk-api-write-")));
  const profileId = must(parseWorkspaceProfileId("cfw"));
  const host = must(parseGitHubHost("github.com")); const owner = must(parseGitHubOwner("centraldigital")); const repo = must(parseGitHubRepoName("patchdesk")); const number = must(parsePullRequestNumber(42)); const headSha = must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")); const attemptId = must(parseReviewAttemptId("001"));
  const profile = must(parseWorkspaceProfileConfig({ id: "cfw", label: "CFW", githubHost: "github.com", ghAccount: "fixture", ownerFilters: [], workspaceRoots: [], rulePaths: [], repos: [] }));
  await new ProfileStore(paths).save(profile);
  const session = createReviewSession({ key: { profileId, host, owner, repo, prNumber: number, headSha }, pr: { headSha, isDraft: false, isOpen: true }, patchPath: must(parseAbsolutePath("/tmp/patch.diff")), worktree: { path: must(parseAbsolutePath("/tmp/worktree")), headSha }, createdAt: "2026-07-16T00:00:00.000Z" as never });
  const draft = { sessionId: session.id, attemptId, state: { _tag: "LocalDraft" as const }, summaryBody: "Summary", suggestedEvent: "COMMENT" as const, comments: [{ findingId: "finding", include: true, originalSuggestedBody: "Comment", body: "Comment", path: "src/write.ts", line: 7, diffSide: "new" as const, postability: "postable" as const }], createdAt: "2026-07-16T00:00:00.000Z", updatedAt: "2026-07-16T00:00:00.000Z" } as unknown as ReviewDraft;
  const completed = { ...session, state: { _tag: "ReviewCompleted" as const, attemptId }, currentAttemptId: attemptId, draft: { state: draft.state }, draftContent: draft } as ReviewSession;
  const sessions = new ReviewSessionStore(paths);
  await sessions.save(completed);
  const github = new FakeGitHubAdapter({ pullRequest: { headSha } } as never);
  const writer: GitHubReviewWriter = { async createPendingReview() { return createResult; }, async submitPendingReview() { return { _tag: "ok", value: { reviewId: "9001" } }; } };
  const startup = await startLocalApiServer({ capability, allowedOrigin, paths, github, reviewWriter: writer });
  if (startup._tag !== "started") throw new Error("Expected local API");
  return { api: startup.server, sessions, session: completed, profileId, request: { profileId, sessionId: completed.id, draft } };
}

function must<T>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" }): T {
  if (result._tag === "err") throw new Error("Invalid fixture");
  return result.value;
}
