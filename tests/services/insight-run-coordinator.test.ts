import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { InsightStore } from "../../src/adapters/storage/insight-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import { parseAbsolutePath, parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parseGitSha, parseIsoTimestamp, parsePullRequestNumber, parseWorkspaceProfileId } from "../../src/domain/ids";
import { createReview } from "../../src/domain/review";
import { createReviewSession } from "../../src/domain/review-session";
import { ok, type Result } from "../../src/domain/result";
import { InsightRunCoordinator, type InsightInvoker, type InsightRunResponse } from "../../src/services/insight-run-coordinator";

const must = <T>(result: Result<T, unknown>): T => { if (result._tag === "ok") return result.value; throw new Error("fixture"); };
const profileId = must(parseWorkspaceProfileId("cfw"));
const headSha = must(parseGitSha("a".repeat(40)));
const now = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));

async function fixture(invokers: { readonly analysis: InsightInvoker; readonly walkthrough: InsightInvoker }) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-insight-coordinator-"));
  const paths = PatchdeskPaths.forTest(root);
  const sessions = new ReviewSessionStore(paths);
  const reviews = new ReviewStore(paths);
  const sessionSeed = createReviewSession({ key: { profileId, host: must(parseGitHubHost("github.com")), owner: must(parseGitHubOwner("centraldigital")), repo: must(parseGitHubRepoName("patchdesk")), prNumber: must(parsePullRequestNumber(42)), headSha }, pr: { headSha, isDraft: false, isOpen: true }, patchPath: must(parseAbsolutePath(paths.patchFile(profileId, "placeholder" as never))), worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, "placeholder" as never))), headSha }, createdAt: now });
  const session = { ...sessionSeed, patchPath: must(parseAbsolutePath(paths.patchFile(profileId, sessionSeed.id))), worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, sessionSeed.id))), headSha } };
  const review = createReview({ identity: { profileId, host: session.key.host, owner: session.key.owner, repo: session.key.repo, prNumber: session.key.prNumber }, currentSessionId: session.id, headSha, createdAt: now });
  await mkdir(dirname(session.patchPath), { recursive: true });
  await writeFile(session.patchPath, "diff --git a/src/a.ts b/src/a.ts\n+change\n", "utf8");
  await sessions.save(session);
  await reviews.save(review);
  const coordinator = new InsightRunCoordinator(reviews, sessions, new InsightStore(paths), paths, { async get() { return ok({ models: [{ id: "model", label: "Model" }] }); } }, invokers, () => now);
  return { root, coordinator, review, paths, reviews, sessions };
}

const successful = (capture?: { value?: Parameters<InsightInvoker["invoke"]>[0] }): InsightInvoker => ({ async invoke(input) { if (capture !== undefined) capture.value = input; return ok({ summary: "result" }); } });

async function eventually(action: () => Promise<Result<InsightRunResponse, unknown>>, expected: InsightRunResponse["status"]): Promise<Result<InsightRunResponse, unknown>> {
  let latest = await action();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (latest._tag === "ok" && latest.value.status === expected) return latest;
    await new Promise((resolve) => setTimeout(resolve, 10));
    latest = await action();
  }
  return latest;
}

describe("InsightRunCoordinator", () => {
  it("starts Analysis from session-owned prepared artifacts without a Review attempt", async () => {
    const capture: { value?: Parameters<InsightInvoker["invoke"]>[0] } = {};
    const fixtureValue = await fixture({ analysis: successful(capture), walkthrough: successful() });
    try {
      const started = await fixtureValue.coordinator.start({ profileId, reviewId: fixtureValue.review.id, type: "analysis", model: "model", reasoning: "medium" });
      expect(started._tag).toBe("ok");
      await eventually(() => fixtureValue.coordinator.observe({ profileId, reviewId: fixtureValue.review.id, type: "analysis", runId: started._tag === "ok" ? started.value.runId : "missing" as never }), "completed");
      expect(capture.value).toMatchObject({
        sessionId: fixtureValue.review.currentSessionId,
        contextPath: fixtureValue.paths.preparedContextFile(profileId, fixtureValue.review.currentSessionId),
        reviewInputPath: fixtureValue.paths.preparedReviewInputFile(profileId, fixtureValue.review.currentSessionId),
      });
    } finally { await rm(fixtureValue.root, { recursive: true, force: true }); }
  });

  it("rejects same-type concurrency but allows Analysis and Walkthrough together", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fixtureValue = await fixture({
      analysis: { async invoke() { await pending; return ok({ summary: "result" }); } },
      walkthrough: successful(),
    });
    try {
      const first = await fixtureValue.coordinator.start({ profileId, reviewId: fixtureValue.review.id, type: "analysis", model: "model", reasoning: "medium" });
      expect(first._tag).toBe("ok");
      const duplicate = await fixtureValue.coordinator.start({ profileId, reviewId: fixtureValue.review.id, type: "analysis", model: "model", reasoning: "medium" });
      expect(duplicate).toEqual({ _tag: "err", error: "already_running" });
      const walkthrough = await fixtureValue.coordinator.start({ profileId, reviewId: fixtureValue.review.id, type: "walkthrough", model: "model", reasoning: "medium" });
      expect(walkthrough._tag).toBe("ok");
      release();
      if (first._tag === "ok") await eventually(() => fixtureValue.coordinator.observe({ profileId, reviewId: fixtureValue.review.id, type: "analysis", runId: first.value.runId }), "completed");
      if (walkthrough._tag === "ok") await eventually(() => fixtureValue.coordinator.observe({ profileId, reviewId: fixtureValue.review.id, type: "walkthrough", runId: walkthrough.value.runId }), "completed");
    } finally { release(); await rm(fixtureValue.root, { recursive: true, force: true }); }
  });

  it("retains a successful result and exposes completion after the process settles", async () => {
    const fixtureValue = await fixture({ analysis: successful(), walkthrough: successful() });
    try {
      const started = await fixtureValue.coordinator.start({ profileId, reviewId: fixtureValue.review.id, type: "analysis", model: "model", reasoning: "low" });
      if (started._tag === "err") throw new Error("expected run");
      const observed = await eventually(() => fixtureValue.coordinator.observe({ profileId, reviewId: fixtureValue.review.id, type: "analysis", runId: started.value.runId }), "completed");
      expect(observed).toEqual({ _tag: "ok", value: { runId: started.value.runId, type: "analysis", status: "completed" } });
      await expect(fixtureValue.coordinator.cancel({ profileId, reviewId: fixtureValue.review.id, type: "analysis", runId: started.value.runId })).resolves.toEqual(observed);
    } finally { await rm(fixtureValue.root, { recursive: true, force: true }); }
  });

  it("turns an orphaned durable run into a retryable failure during recovery", async () => {
    let release!: () => void;
    let resolveInvoked: () => void = () => undefined;
    const invoked = new Promise<void>((resolve) => { resolveInvoked = resolve; });
    const pendingInvoker: InsightInvoker = { async invoke() { resolveInvoked(); await new Promise<void>((resolve) => { release = resolve; }); return ok({ summary: "late" }); } };
    const fixtureValue = await fixture({ analysis: pendingInvoker, walkthrough: successful() });
    try {
      const started = await fixtureValue.coordinator.start({ profileId, reviewId: fixtureValue.review.id, type: "analysis", model: "model", reasoning: "medium" });
      if (started._tag === "err") throw new Error("expected run");
      await invoked;
      const restarted = new InsightRunCoordinator(fixtureValue.reviews, fixtureValue.sessions, new InsightStore(fixtureValue.paths), fixtureValue.paths, { async get() { return ok({ models: [{ id: "model", label: "Model" }] }); } }, { analysis: successful(), walkthrough: successful() }, () => now);
      await expect(restarted.recover({ profileId, reviewId: fixtureValue.review.id, type: "analysis" })).resolves.toEqual({ _tag: "ok", value: { runId: started.value.runId, type: "analysis", status: "failed" } });
      release();
    } finally { await rm(fixtureValue.root, { recursive: true, force: true }); }
  });

  it("persists cancelling before aborting the owned process", async () => {
    let signal: AbortSignal | undefined;
    let resolveInvoked: () => void = () => undefined;
    const invoked = new Promise<void>((resolve) => { resolveInvoked = resolve; });
    const invoker: InsightInvoker = { async invoke(_input, options) { signal = options.signal; resolveInvoked(); await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true })); return { _tag: "err", error: { reason: "cancelled" } }; } };
    const fixtureValue = await fixture({ analysis: invoker, walkthrough: successful() });
    try {
      const started = await fixtureValue.coordinator.start({ profileId, reviewId: fixtureValue.review.id, type: "analysis", model: "model", reasoning: "medium" });
      if (started._tag === "err") throw new Error("expected run");
      await invoked;
      expect(signal).toBeDefined();
      await expect(fixtureValue.coordinator.cancel({ profileId, reviewId: fixtureValue.review.id, type: "analysis", runId: started.value.runId })).resolves.toMatchObject({ _tag: "ok", value: { status: "cancelling" } });
      await expect(eventually(() => fixtureValue.coordinator.observe({ profileId, reviewId: fixtureValue.review.id, type: "analysis", runId: started.value.runId }), "cancelled")).resolves.toMatchObject({ _tag: "ok", value: { status: "cancelled" } });
    } finally { await rm(fixtureValue.root, { recursive: true, force: true }); }
  });
});
