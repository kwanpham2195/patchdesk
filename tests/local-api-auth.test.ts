import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startLocalApiServer,
  type LocalApiServer,
  type LocalApiConfiguration,
} from "../src/main/local-api";
import { FakeGitHubAdapter, type GitHubReader, type GitHubReviewWriter } from "../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../src/adapters/storage/profile-store";
import { ReviewSessionStore } from "../src/adapters/storage/review-session-store";
import { parseAbsolutePath, parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parseGitSha, parseIsoTimestamp, parsePullRequestNumber, parseReviewAttemptId, parseWorkspaceProfileId } from "../src/domain/ids";
import { createReviewSession, type ReviewSession } from "../src/domain/review-session";
import { createReview } from "../src/domain/review";
import { ReviewStore } from "../src/adapters/storage/review-store";
import { parseWorkspaceProfileConfig } from "../src/domain/workspace-profile";
import { ProfileSettingsService } from "../src/services/profile-service";
import { err, ok } from "../src/domain/result";

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
  it("keeps review-run and merge endpoints behind the capability and origin boundary", async () => {
    const startup = await startLocalApiServer({
      capability,
      allowedOrigin,
      supportedReviewModels: ["fixture-model"],
      workflowInvoker: { async invoke() { return ok({}); } },
    });
    if (startup._tag !== "started") throw new Error("Expected local API startup");
    localApi = startup.server;

    for (const path of ["v1/reviews/run", "v1/reviews/merge", "v1/reviews/detect-updates", "v1/reviews/refresh", "v1/reviews/commit-diff"]) {
      const missing = await fetch(new URL(path, localApi.url), { method: "POST", headers: { Origin: allowedOrigin, "Content-Type": "application/json" }, body: "{}" });
      expect(missing.status).toBe(401);
      const wrongOrigin = await fetch(new URL(path, localApi.url), { method: "POST", headers: { Origin: "http://evil.invalid", "X-Patchdesk-Capability": capability, "Content-Type": "application/json" }, body: "{}" });
      expect(wrongOrigin.status).toBe(403);
    }
  });

  it("exposes Review-owned Insight lifecycle routes behind the same boundary", async () => {
    const headers = { Origin: allowedOrigin, "X-Patchdesk-Capability": capability, "Content-Type": "application/json" };
    const reviewId = "github.com__centraldigital__patchdesk__pr-42__review-abcdef123456";
    const runId = `insight-analysis-1-aaaaaaaaaaaa-${reviewId}`;
    const insights: NonNullable<LocalApiConfiguration["insights"]> = {
      async start(input) { return ok({ runId: runId as never, type: input.type, status: "queued" as const }); },
      async cancel(input) { return ok({ runId: input.runId, type: input.type, status: "cancelling" as const }); },
      async observe(input) { return ok({ runId: input.runId, type: input.type, status: "running" as const }); },
    };
    const startup = await startLocalApiServer({ capability, allowedOrigin, insights });
    if (startup._tag !== "started") throw new Error("Expected local API startup");
    localApi = startup.server;
    const invalid = await fetch(new URL("v1/reviews/insights/analysis/run", localApi.url), { method: "POST", headers, body: JSON.stringify({ profileId: "cfw", reviewId, model: "model", reasoning: "low", localPath: "/tmp/private" }) });
    expect(invalid.status).toBe(400);
    const started = await fetch(new URL("v1/reviews/insights/analysis/run", localApi.url), { method: "POST", headers, body: JSON.stringify({ profileId: "cfw", reviewId, type: "analysis", model: "model", reasoning: "low" }) });
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual({ runId, type: "analysis", status: "queued" });
    const observed = await fetch(new URL(`v1/reviews/insights/runs/${runId}?profileId=cfw&reviewId=${encodeURIComponent(reviewId)}&type=analysis`, localApi.url), { headers });
    expect(observed.status).toBe(200);
    expect(await observed.json()).toEqual({ runId, type: "analysis", status: "running" });
    const cancelled = await fetch(new URL("v1/reviews/insights/analysis/cancel", localApi.url), { method: "POST", headers, body: JSON.stringify({ profileId: "cfw", reviewId, type: "analysis", runId }) });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ runId, type: "analysis", status: "cancelling" });
  });

  it("maps authenticated review-run parsing, catalog, and missing-session failures", async () => {
    const headers = { Origin: allowedOrigin, "X-Patchdesk-Capability": capability, "Content-Type": "application/json" };
    const configured = await startLocalApiServer({ capability, allowedOrigin, supportedReviewModels: ["fixture-model"], workflowInvoker: { async invoke() { return ok({}); } } });
    if (configured._tag !== "started") throw new Error("Expected local API startup");
    localApi = configured.server;
    const invalid = await fetch(new URL("v1/reviews/run", localApi.url), { method: "POST", headers, body: JSON.stringify({}) });
    expect(invalid.status).toBe(400);
    const invalidCommitDiff = await fetch(new URL("v1/reviews/commit-diff", localApi.url), { method: "POST", headers, body: JSON.stringify({}) });
    expect(invalidCommitDiff.status).toBe(400);
    const missing = await fetch(new URL("v1/reviews/run", localApi.url), { method: "POST", headers, body: JSON.stringify({ profileId: "cfw", sessionId: "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__abcdef123456", model: "fixture-model", reasoning: "medium" }) });
    expect(missing.status).toBe(404);
    await localApi.stop();
    localApi = undefined;

    const unavailable = await startLocalApiServer({ capability, allowedOrigin, workflowInvoker: { async invoke() { return ok({}); } } });
    if (unavailable._tag !== "started") throw new Error("Expected local API startup");
    localApi = unavailable.server;
    const catalog = await fetch(new URL("v1/reviews/run", localApi.url), { method: "POST", headers, body: JSON.stringify({ profileId: "cfw", sessionId: "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__abcdef123456", model: "fixture-model", reasoning: "medium" }) });
    expect(catalog.status).toBe(503);
  });

  it("returns a flattened canonical projection from an authenticated refresh", async () => {
    const fixture = await persistedReviewFixture();
    const review = createReview({ identity: { profileId: fixture.profileId, host: fixture.session.key.host, owner: fixture.session.key.owner, repo: fixture.session.key.repo, prNumber: fixture.session.key.prNumber }, currentSessionId: fixture.session.id, headSha: fixture.session.key.headSha, createdAt: fixture.session.createdAt });
    expect((await new ReviewStore(fixture.paths).save(review))._tag).toBe("ok");
    const startup = await startLocalApiServer({ capability, allowedOrigin, paths: fixture.paths, github: fixture.github });
    if (startup._tag !== "started") throw new Error("Expected local API startup");
    localApi = startup.server;
    const response = await fetch(new URL("v1/reviews/refresh", localApi.url), { method: "POST", headers: writeHeaders(), body: JSON.stringify({ profileId: fixture.profileId, reviewId: review.id }) });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ state: "review", review: { id: review.id } });
  });

  it("starts one authenticated review run from persisted server-owned artifacts", async () => {
    const fixture = await reviewRunFixture();
    localApi = fixture.api;

    const response = await fetch(new URL("v1/reviews/run", localApi.url), { method: "POST", headers: writeHeaders(), body: JSON.stringify({ profileId: fixture.profileId, sessionId: fixture.session.id, model: "fixture-model", reasoning: "medium" }) });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ attemptId: "001", model: "fixture-model", reasoning: "medium" });
    await vi.waitFor(() => expect(fixture.workflowInputs).toHaveLength(1));
    expect(fixture.workflowInputs[0]).toMatchObject({ profileId: fixture.profileId, sessionId: fixture.session.id, attemptId: "001", patchPath: fixture.session.patchPath });
  });

  it("maps stale and non-runnable authenticated review runs", async () => {
    const stale = await persistedReviewFixture();
    await mkdir(stale.paths.preparedDirectory(stale.profileId, stale.session.id), { recursive: true });
    await Promise.all([writeFile(stale.session.patchPath, "diff", "utf8"), writeFile(stale.paths.preparedContextFile(stale.profileId, stale.session.id), "{}", "utf8"), writeFile(stale.paths.preparedReviewInputFile(stale.profileId, stale.session.id), "Review", "utf8"), writeFile(stale.paths.preparedDebugFile(stale.profileId, stale.session.id), "{}", "utf8")]);
    const changedHead = must(parseGitSha("1234567890abcdef1234567890abcdef12345678"));
    const staleGitHub = new FakeGitHubAdapter({ pullRequest: { ref: { host: stale.session.key.host, owner: stale.session.key.owner, repo: stale.session.key.repo, number: stale.session.key.prNumber }, headSha: changedHead, isDraft: false, isOpen: true, title: "Fixture PR", author: "fixture", headBranch: "main", baseBranch: "main", reviewState: "none", mergeability: "mergeable", labels: [], updatedAt: "2026-08-01T00:00:00.000Z" as never } });
    const staleStartup = await startLocalApiServer({ capability, allowedOrigin, paths: stale.paths, github: staleGitHub, supportedReviewModels: ["fixture-model"], workflowInvoker: { async invoke() { return ok({}); } } });
    if (staleStartup._tag !== "started") throw new Error("Expected local API startup");
    localApi = staleStartup.server;
    const body = { profileId: stale.profileId, sessionId: stale.session.id, model: "fixture-model", reasoning: "medium" };
    expect((await fetch(new URL("v1/reviews/run", localApi.url), { method: "POST", headers: writeHeaders(), body: JSON.stringify(body) })).status).toBe(409);
    await localApi.stop();
    localApi = undefined;

    const terminal = await reviewRunFixture();
    await new ReviewSessionStore(terminal.paths).save({ ...terminal.session, state: { _tag: "Merged", mergedAt: "2026-08-01T00:00:00.000Z" as never } });
    await terminal.api.stop();
    const terminalStartup = await startLocalApiServer({ capability, allowedOrigin, paths: terminal.paths, github: terminal.github, supportedReviewModels: ["fixture-model"], workflowInvoker: { async invoke() { return ok({}); } } });
    if (terminalStartup._tag !== "started") throw new Error("Expected local API startup");
    localApi = terminalStartup.server;
    expect((await fetch(new URL("v1/reviews/run", localApi.url), { method: "POST", headers: writeHeaders(), body: JSON.stringify({ profileId: terminal.profileId, sessionId: terminal.session.id, model: "fixture-model", reasoning: "medium" }) })).status).toBe(400);
  });

  it("delegates an authenticated merge and returns its persisted session", async () => {
    const fixture = await mergeApiFixture();
    localApi = fixture.api;

    const response = await fetch(new URL("v1/reviews/merge", localApi.url), { method: "POST", headers: writeHeaders(), body: JSON.stringify({ profileId: fixture.profileId, sessionId: fixture.session.id, method: "squash", acknowledgedWarnings: true }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ session: { state: { _tag: "Merged" } } });
    expect(fixture.methods).toEqual(["squash"]);
  });

  it("maps malformed and failed authenticated merge requests", async () => {
    const fixture = await persistedReviewFixture();
    const startup = await startLocalApiServer({ capability, allowedOrigin, paths: fixture.paths, github: fixture.github, mergeWriter: { async mergePullRequest() { return err({ _tag: "GitHubWriteFailure" as const, category: "unavailable" as const, message: "Fixture unavailable." }); } } });
    if (startup._tag !== "started") throw new Error("Expected local API startup");
    localApi = startup.server;
    const malformed = await fetch(new URL("v1/reviews/merge", localApi.url), { method: "POST", headers: writeHeaders(), body: JSON.stringify({ profileId: fixture.profileId, sessionId: fixture.session.id, method: "unknown", acknowledgedWarnings: true }) });
    expect(malformed.status).toBe(400);
    const failed = await fetch(new URL("v1/reviews/merge", localApi.url), { method: "POST", headers: writeHeaders(), body: JSON.stringify({ profileId: fixture.profileId, sessionId: fixture.session.id, method: "squash", acknowledgedWarnings: true }) });
    expect(failed.status).toBe(400);
  });
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

  it("lists redacted diagnostic activity only through the authenticated route", async () => {
    localApi = await startTestLocalApi();
    const response = await fetch(new URL("v1/diagnostics?profileId=cfw", localApi.url), {
      headers: {
        "X-Patchdesk-Capability": capability,
        Origin: allowedOrigin,
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
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
      ["v1/reviews/draft", "POST"],
      ["v1/reviews/pending", "POST"],
      ["v1/reviews/submit", "POST"],
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

  it("keeps review writes unavailable when the API receives only a GitHub reader", async () => {
    const paths = PatchdeskPaths.forTest(await mkdtemp(join(tmpdir(), "patchdesk-api-")));
    const reader = { async getPullRequest() { return { _tag: "err" as const, error: { _tag: "GitHubReadFailed" as const } }; } } as unknown as GitHubReader;
    const startup = await startLocalApiServer({ capability, allowedOrigin, paths, github: reader });
    if (startup._tag !== "started") throw new Error("Expected local API");
    localApi = startup.server;
    const response = await fetch(new URL("v1/reviews/apply-batch", localApi.url), { method: "POST", headers: writeHeaders(), body: "{}" });
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

  it("submits the created pending review through the same persisted batch", async () => {
    const fixture = await reviewWriteFixture({ _tag: "ok", value: { reviewId: "9001", state: "PENDING" } });
    localApi = fixture.api;
    const applied = await fetch(new URL("v1/reviews/apply-batch", localApi.url), { method: "POST", headers: writeHeaders(), body: JSON.stringify(fixture.request) });
    const appliedBody = await applied.json() as { readonly batch?: { readonly updatedAt?: string } };
    const expectedRevision = appliedBody.batch?.updatedAt;
    if (typeof expectedRevision !== "string") throw new Error("Expected pending batch revision");

    const response = await fetch(new URL("v1/reviews/submit-batch", localApi.url), {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({ ...fixture.request, expectedRevision, event: "REQUEST_CHANGES" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      batch: { state: { _tag: "Submitted", reviewId: "9001", event: "REQUEST_CHANGES" } },
    });
    await expect(fixture.sessions.load(fixture.profileId, fixture.session.id)).resolves.toMatchObject({
      _tag: "ok",
      value: { submittedReview: { reviewId: "9001", event: "REQUEST_CHANGES" } },
    });
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

async function reviewRunFixture() {
  const fixture = await persistedReviewFixture();
  await mkdir(fixture.paths.preparedDirectory(fixture.profileId, fixture.session.id), { recursive: true });
  await Promise.all([
    writeFile(fixture.session.patchPath, "diff --git a/a.ts b/a.ts\n", "utf8"),
    writeFile(fixture.paths.preparedContextFile(fixture.profileId, fixture.session.id), "{}", "utf8"),
    writeFile(fixture.paths.preparedReviewInputFile(fixture.profileId, fixture.session.id), "Review fixture.", "utf8"),
    writeFile(fixture.paths.preparedDebugFile(fixture.profileId, fixture.session.id), "{}", "utf8"),
  ]);
  const workflowInputs: unknown[] = [];
  const startup = await startLocalApiServer({ capability, allowedOrigin, paths: fixture.paths, github: fixture.github, supportedReviewModels: ["fixture-model"], workflowInvoker: { async invoke(input) { workflowInputs.push(input); return ok({}); } } });
  if (startup._tag !== "started") throw new Error("Expected local API startup");
  return { ...fixture, api: startup.server, workflowInputs };
}

async function mergeApiFixture() {
  const fixture = await persistedReviewFixture();
  const methods: string[] = [];
  const startup = await startLocalApiServer({ capability, allowedOrigin, paths: fixture.paths, github: fixture.github, mergeWriter: { async mergePullRequest(input) { methods.push(input.method); return ok({}); } } });
  if (startup._tag !== "started") throw new Error("Expected local API startup");
  return { ...fixture, api: startup.server, methods };
}

async function persistedReviewFixture() {
  const paths = PatchdeskPaths.forTest(await mkdtemp(join(tmpdir(), "patchdesk-api-run-")));
  const profileId = must(parseWorkspaceProfileId("cfw"));
  const key = { profileId, host: must(parseGitHubHost("github.com")), owner: must(parseGitHubOwner("centraldigital")), repo: must(parseGitHubRepoName("patchdesk")), prNumber: must(parsePullRequestNumber(42)), headSha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")) };
  const seeded = createReviewSession({ key, pr: { headSha: key.headSha, isDraft: false, isOpen: true }, patchPath: must(parseAbsolutePath(paths.patchFile(profileId, "placeholder" as never))), worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, "placeholder" as never))), headSha: key.headSha }, createdAt: must(parseIsoTimestamp("2026-08-01T00:00:00.000Z")) });
  const session = { ...seeded, patchPath: must(parseAbsolutePath(paths.patchFile(profileId, seeded.id))), worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, seeded.id))), headSha: key.headSha } };
  const profile = must(parseWorkspaceProfileConfig({ id: profileId, label: "CFW", githubHost: "github.com", ghAccount: "fixture", ownerFilters: [], workspaceRoots: [], rulePaths: [], repos: [] }));
  await new ProfileStore(paths).save(profile);
  await new ReviewSessionStore(paths).save(session);
  const github = new FakeGitHubAdapter({ pullRequest: { ref: { host: key.host, owner: key.owner, repo: key.repo, number: key.prNumber }, headSha: key.headSha, isDraft: false, isOpen: true, title: "Fixture PR", author: "fixture", headBranch: "main", baseBranch: "main", reviewState: "none", mergeability: "mergeable", labels: [], updatedAt: "2026-08-01T00:00:00.000Z" as never }, mergePolicy: { pr: { host: key.host, owner: key.owner, repo: key.repo, number: key.prNumber }, headSha: key.headSha, isOpen: true, isDraft: false, mergeability: "mergeable", reviewDecision: "approved", checks: { overall: "passing", checks: [] }, complete: true }, checks: { overall: "passing", checks: [] }, comments: { threads: [], complete: true } });
  return { paths, profileId, session, github };
}

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
  const batch = { sessionId: session.id, state: { _tag: "Local" as const }, summaryBody: "Summary", suggestedEvent: "COMMENT" as const, items: [{ _tag: "InlineComment" as const, id: "finding" as never, provenance: { _tag: "model" as const, attemptId }, source: "finding" as const, findingId: "finding" as never, anchor: { path: "src/write.ts" as never, startLine: 7, line: 7, side: "new" as const }, body: "Comment", include: true, postability: "postable" as const }], receipts: [], createdAt: "2026-07-16T00:00:00.000Z" as never, updatedAt: "2026-07-16T00:00:00.000Z" as never };
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
