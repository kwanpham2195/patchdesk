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
import { parseAbsolutePath, parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parseGitSha, parseIsoTimestamp, parsePullRequestNumber, parseReviewAttemptId, parseWorkspaceProfileId } from "../src/domain/ids";
import { createReviewSession, type ReviewSession } from "../src/domain/review-session";
import { parseWorkspaceProfileConfig } from "../src/domain/workspace-profile";
import { ProfileSettingsService } from "../src/services/profile-service";

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

  it("exports a sanitized support bundle only through the authenticated route", async () => {
    localApi = await startTestLocalApi();
    const response = await fetch(new URL("v1/diagnostics/support-bundle", localApi.url), {
      method: "POST",
      headers: {
        "X-Patchdesk-Capability": capability,
        Origin: allowedOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ profileId: "cfw" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 1,
      profileId: "cfw",
      events: expect.arrayContaining([
        expect.objectContaining({ category: "migration", phase: "attempt-recover" }),
      ]),
    });
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

  it("returns main-process-owned application metadata with safe environment diagnostics", async () => {
    const startup = await startLocalApiServer({
      capability,
      allowedOrigin,
      appMetadata: {
        productName: "Patchdesk",
        version: "0.1.0",
        architecture: "arm64",
        distribution: "unsigned_internal",
      },
    });
    if (startup._tag !== "started") throw new Error("Expected local API");
    localApi = startup.server;

    const response = await fetch(new URL("v1/environment", localApi.url), {
      headers: {
        "X-Patchdesk-Capability": capability,
        Origin: allowedOrigin,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      productName: "Patchdesk",
      version: "0.1.0",
      architecture: "arm64",
      distribution: "unsigned_internal",
    });
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

  it("reads and patches only valid global settings through the authenticated API", async () => {
    const paths = PatchdeskPaths.forTest(await mkdtemp(join(tmpdir(), "patchdesk-settings-api-")));
    const profileStore = new ProfileStore(paths);
    await profileStore.saveConfig({ lastSelectedProfileId: "cfw" });
    const startup = await startLocalApiServer({ capability, allowedOrigin, paths });
    if (startup._tag !== "started") throw new Error("Expected local API");
    localApi = startup.server;
    const headers = {
      "X-Patchdesk-Capability": capability,
      Origin: allowedOrigin,
      "Content-Type": "application/json",
    };

    const initial = await fetch(new URL("v1/settings", localApi.url), { headers });
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toEqual({ lastSelectedProfileId: "cfw" });

    const updated = await fetch(new URL("v1/settings", localApi.url), {
      method: "PATCH",
      headers,
      body: JSON.stringify({ appearance: "dark", diffTheme: { light: "github-light", dark: "github-dark" } }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toEqual({
      lastSelectedProfileId: "cfw",
      appearance: "dark",
      diffTheme: { light: "github-light", dark: "github-dark" },
    });
    await expect(profileStore.loadConfig()).resolves.toEqual({
      _tag: "ok",
      value: {
        lastSelectedProfileId: "cfw",
        appearance: "dark",
        diffTheme: { light: "github-light", dark: "github-dark" },
      },
    });

    for (const body of [
      { appearance: "bright" },
      { diffTheme: { light: "", dark: "github-dark" } },
      { appearance: "light", unknown: true },
      {},
    ]) {
      const invalid = await fetch(new URL("v1/settings", localApi.url), {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toEqual({ error: "invalid_input" });
    }
  });

  it("removes the obsolete per-review storage routes from the authenticated API", async () => {
    localApi = await startTestLocalApi();
    const headers = { "X-Patchdesk-Capability": capability, Origin: allowedOrigin, "Content-Type": "application/json" };

    for (const [path, method] of [
      ["v1/storage", "GET"],
      ["v1/storage/discard", "POST"],
      ["v1/storage/quarantine/delete", "POST"],
    ] as const) {
      const response = await fetch(new URL(path, localApi.url), {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify({ profileId: "cfw" }) } : {}),
      });
      expect(response.status).toBe(404);
    }

    const cleanup = await fetch(new URL("v1/storage/clear-local-data", localApi.url), {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(cleanup.status).toBe(400);
  });

  it("returns an empty settings config when no global config file exists", async () => {
    const paths = PatchdeskPaths.forTest(await mkdtemp(join(tmpdir(), "patchdesk-empty-settings-api-")));
    const startup = await startLocalApiServer({ capability, allowedOrigin, paths });
    if (startup._tag !== "started") throw new Error("Expected local API");
    localApi = startup.server;

    const response = await fetch(new URL("v1/settings", localApi.url), {
      headers: { "X-Patchdesk-Capability": capability, Origin: allowedOrigin },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({});
  });

  it("never fabricates a review run when the workflow invoker is unavailable", async () => {
    localApi = await startTestLocalApi();
    const headers = { "X-Patchdesk-Capability": capability, Origin: allowedOrigin, "Content-Type": "application/json" };
    const started = await fetch(new URL("v1/runs/review-pr", localApi.url), { method: "POST", headers, body: JSON.stringify({ sessionId: "session", attemptId: "001" }) });
    expect(started.status).toBe(503);
    await expect(started.json()).resolves.toEqual({ error: "workflow_unavailable" });
  });

  it("serves a read-only maintainer inbox through the capability boundary", async () => {
    const paths = PatchdeskPaths.forTest(await mkdtemp(join(tmpdir(), "patchdesk-inbox-api-")));
    const profile = must(parseWorkspaceProfileConfig({
      id: "cfw",
      label: "CFW",
      githubHost: "github.com",
      ghAccount: "maintainer",
      ownerFilters: [],
      workspaceRoots: [],
      rulePaths: [],
      repos: [{ host: "github.com", owner: "centraldigital", repo: "patchdesk" }],
    }));
    const settings = new ProfileSettingsService(new ProfileStore(paths));
    await settings.saveProfile(profile);
    await settings.selectProfile(profile.id);
    const host = must(parseGitHubHost("github.com"));
    const owner = must(parseGitHubOwner("centraldigital"));
    const repo = must(parseGitHubRepoName("patchdesk"));
    const sha = must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12"));
    const github = new FakeGitHubAdapter({
      authenticatedAccount: { host: "github.com", account: "maintainer" },
      listOpenPullRequests: [{
        ref: { host, owner, repo, number: must(parsePullRequestNumber(42)) },
        title: "Fixture inbox PR",
        author: "author",
        headBranch: "feature/inbox",
        baseBranch: "sit",
        headSha: sha,
        isDraft: false,
        isOpen: true,
        reviewState: "none",
        mergeability: "unknown",
        labels: [],
        requestedReviewers: ["maintainer"],
        updatedAt: must(parseIsoTimestamp("2026-07-18T00:00:00.000Z")),
      }],
      checks: { overall: "unknown", checks: [] },
    });
    const startup = await startLocalApiServer({ capability, allowedOrigin, paths, github });
    if (startup._tag !== "started") throw new Error("Expected local API");
    localApi = startup.server;
    const response = await fetch(new URL("v1/inbox", localApi.url), { headers: { "X-Patchdesk-Capability": capability, Origin: allowedOrigin } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      profile: { id: "cfw" },
      inbox: { dataFreshness: "fresh", rows: [{ title: "Fixture inbox PR", recommendedAction: { kind: "run_review" } }] },
    });
  });

  it("keeps walkthrough routes capability/origin protected and rejects renderer paths", async () => {
    const walkthroughs = {
      async generate() { return { _tag: "ok" as const, value: { lifecycle: "idle" as const, noticeKey: "walkthrough-idle" as const } }; },
      async load() { return { _tag: "ok" as const, value: { lifecycle: "idle" as const, noticeKey: "walkthrough-idle" as const } }; },
    };
    const startup = await startLocalApiServer({ capability, allowedOrigin, walkthroughs });
    if (startup._tag !== "started") throw new Error("Expected local API");
    localApi = startup.server;
    const unauthorized = await fetch(new URL("v1/reviews/walkthrough/generate", localApi.url), { method: "POST", headers: { Origin: allowedOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ profileId: "p", sessionId: "s", model: "m", reasoning: "low" }) });
    expect(unauthorized.status).toBe(401);
    const wrongOrigin = await fetch(new URL("v1/reviews/walkthrough/generate", localApi.url), { method: "POST", headers: { Origin: "http://evil.invalid", "X-Patchdesk-Capability": capability, "Content-Type": "application/json" }, body: JSON.stringify({ profileId: "p", sessionId: "s", model: "m", reasoning: "low" }) });
    expect(wrongOrigin.status).toBe(403);
    const invalid = await fetch(new URL("v1/reviews/walkthrough/generate", localApi.url), { method: "POST", headers: { Origin: allowedOrigin, "X-Patchdesk-Capability": capability, "Content-Type": "application/json" }, body: JSON.stringify({ profileId: "p", sessionId: "s", model: "m", reasoning: "low", patchPath: "/tmp/secret" }) });
    expect(invalid.status).toBe(400);
  });

  it("maps walkthrough dependency failures to the required statuses", async () => {
    const walkthroughs = {
      async generate(input: unknown) {
        return input === undefined
          ? { _tag: "err" as const, error: { reason: "invalid_input" as const } }
          : { _tag: "err" as const, error: { reason: "stale_snapshot" as const } };
      },
      async load() { return { _tag: "err" as const, error: { reason: "workflow_unavailable" as const } }; },
    };
    const startup = await startLocalApiServer({ capability, allowedOrigin, walkthroughs });
    if (startup._tag !== "started") throw new Error("Expected local API");
    localApi = startup.server;
    const headers = { Origin: allowedOrigin, "X-Patchdesk-Capability": capability, "Content-Type": "application/json" };
    const stale = await fetch(new URL("v1/reviews/walkthrough/generate", localApi.url), { method: "POST", headers, body: JSON.stringify({ profileId: "p", sessionId: "s", model: "m", reasoning: "low" }) });
    expect(stale.status).toBe(409);
    const unavailable = await fetch(new URL("v1/reviews/walkthrough/load", localApi.url), { method: "POST", headers, body: JSON.stringify({ profileId: "p", sessionId: "s" }) });
    expect(unavailable.status).toBe(503);
  });

  it("returns the renderer-safe stale lifecycle from walkthrough load when the snapshot hash no longer matches", async () => {
    const staleProjection = { lifecycle: "stale" as const, noticeKey: "walkthrough-stale" as const, actionKey: "walkthrough-regenerate" as const };
    const walkthroughs = {
      async generate() { return { _tag: "err" as const, error: { reason: "stale_snapshot" as const } }; },
      async load() { return { _tag: "ok" as const, value: staleProjection }; },
    };
    const startup = await startLocalApiServer({ capability, allowedOrigin, walkthroughs });
    if (startup._tag !== "started") throw new Error("Expected local API");
    localApi = startup.server;
    const headers = { Origin: allowedOrigin, "X-Patchdesk-Capability": capability, "Content-Type": "application/json" };
    const response = await fetch(new URL("v1/reviews/walkthrough/load", localApi.url), { method: "POST", headers, body: JSON.stringify({ profileId: "p", sessionId: "s" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(staleProjection);
  });

  it("returns 400 for malformed JSON before the unavailable dependency check", async () => {
    const startup = await startLocalApiServer({ capability, allowedOrigin });
    if (startup._tag !== "started") throw new Error("Expected local API");
    localApi = startup.server;
    const headers = { Origin: allowedOrigin, "X-Patchdesk-Capability": capability, "Content-Type": "application/json" };
    const response = await fetch(new URL("v1/reviews/walkthrough/generate", localApi.url), { method: "POST", headers, body: "not-json" });
    expect(response.status).toBe(400);
  });

  it("returns 400 for renderer-supplied path fields before the unavailable dependency check", async () => {
    const startup = await startLocalApiServer({ capability, allowedOrigin });
    if (startup._tag !== "started") throw new Error("Expected local API");
    localApi = startup.server;
    const headers = { Origin: allowedOrigin, "X-Patchdesk-Capability": capability, "Content-Type": "application/json" };
    const response = await fetch(new URL("v1/reviews/walkthrough/generate", localApi.url), { method: "POST", headers, body: JSON.stringify({ profileId: "p", sessionId: "s", model: "m", reasoning: "low", patchPath: "/tmp/secret" }) });
    expect(response.status).toBe(400);
  });

  it("returns 503 only for valid walkthrough requests when the dependency is unavailable", async () => {
    const startup = await startLocalApiServer({ capability, allowedOrigin });
    if (startup._tag !== "started") throw new Error("Expected local API");
    localApi = startup.server;
    const headers = { Origin: allowedOrigin, "X-Patchdesk-Capability": capability, "Content-Type": "application/json" };
    const response = await fetch(new URL("v1/reviews/walkthrough/load", localApi.url), { method: "POST", headers, body: JSON.stringify({ profileId: "p", sessionId: "s" }) });
    expect(response.status).toBe(503);
  });

  it("returns 404 for walkthrough generate with a missing profile or session", async () => {
    const walkthroughs = {
      async generate() { return { _tag: "err" as const, error: { reason: "profile_not_found" as const } }; },
      async load() { return { _tag: "err" as const, error: { reason: "session_not_found" as const } }; },
    };
    const startup = await startLocalApiServer({ capability, allowedOrigin, walkthroughs });
    if (startup._tag !== "started") throw new Error("Expected local API");
    localApi = startup.server;
    const headers = { Origin: allowedOrigin, "X-Patchdesk-Capability": capability, "Content-Type": "application/json" };
    const missingProfile = await fetch(new URL("v1/reviews/walkthrough/generate", localApi.url), { method: "POST", headers, body: JSON.stringify({ profileId: "p", sessionId: "s", model: "m", reasoning: "low" }) });
    expect(missingProfile.status).toBe(404);
    const missingSession = await fetch(new URL("v1/reviews/walkthrough/load", localApi.url), { method: "POST", headers, body: JSON.stringify({ profileId: "p", sessionId: "s" }) });
    expect(missingSession.status).toBe(404);
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

  it("persists a created pending review batch through the capability-authenticated local API", async () => {
    const fixture = await reviewWriteFixture({ _tag: "ok", value: { reviewId: "9001", state: "PENDING" } });
    localApi = fixture.api;
    const response = await fetch(new URL("v1/reviews/apply-batch", localApi.url), { method: "POST", headers: writeHeaders(), body: JSON.stringify(fixture.request) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ batch: { state: { _tag: "PendingReview", reviewId: "9001" } } });
    await expect(fixture.sessions.load(fixture.profileId, fixture.session.id)).resolves.toMatchObject({ _tag: "ok", value: { batchContent: { state: { _tag: "PendingReview", reviewId: "9001" } } } });
  });

  it("persists PartialFailure after a rejected batch write and never advances its phase", async () => {
    const fixture = await reviewWriteFixture({ _tag: "err", error: { _tag: "GitHubWriteFailure", category: "rejected", message: "Rejected by fixture." } });
    localApi = fixture.api;
    const response = await fetch(new URL("v1/reviews/apply-batch", localApi.url), { method: "POST", headers: writeHeaders(), body: JSON.stringify(fixture.request) });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "github_rejected" });
    await expect(fixture.sessions.load(fixture.profileId, fixture.session.id)).resolves.toMatchObject({ _tag: "ok", value: { state: { _tag: "ReviewCompleted" }, batchContent: { state: { _tag: "PartialFailure" } } } });
  });

  it("authenticates the global local-data cleanup route", async () => {
    localApi = await startTestLocalApi();
    const response = await fetch(new URL("v1/storage/clear-local-data", localApi.url), {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_input" });

    const unauthorized = await fetch(new URL("v1/storage/clear-local-data", localApi.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: allowedOrigin },
      body: JSON.stringify({ profileId: "cfw" }),
    });
    expect(unauthorized.status).toBe(401);
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
  const batch = { sessionId: session.id, attemptId, state: { _tag: "Local" as const }, summaryBody: "Summary", suggestedEvent: "COMMENT" as const, items: [{ _tag: "InlineComment" as const, id: "finding" as never, source: "finding" as const, findingId: "finding" as never, anchor: { path: "src/write.ts" as never, startLine: 7, line: 7, side: "new" as const }, body: "Comment", include: true, postability: "postable" as const }], receipts: [], createdAt: "2026-07-16T00:00:00.000Z" as never, updatedAt: "2026-07-16T00:00:00.000Z" as never };
  const completed = { ...session, state: { _tag: "ReviewCompleted" as const, attemptId }, currentAttemptId: attemptId, batch: { state: batch.state }, batchContent: batch } as ReviewSession;
  const sessions = new ReviewSessionStore(paths);
  await sessions.save(completed);
  const github = new FakeGitHubAdapter({ pullRequest: { headSha } } as never);
  const writer: GitHubReviewWriter = { async createPendingReview() { return createResult; }, async submitPendingReview() { return { _tag: "ok", value: { reviewId: "9001" } }; } };
  const startup = await startLocalApiServer({ capability, allowedOrigin, paths, github, reviewWriter: writer });
  if (startup._tag !== "started") throw new Error("Expected local API");
  return { api: startup.server, sessions, session: completed, profileId, request: { profileId, sessionId: completed.id, expectedRevision: batch.updatedAt, acknowledgement: true } };
}

function must<T>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" }): T {
  if (result._tag === "err") throw new Error("Invalid fixture");
  return result.value;
}
