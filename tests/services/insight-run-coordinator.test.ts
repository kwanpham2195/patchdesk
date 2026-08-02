import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { InsightStore } from "../../src/adapters/storage/insight-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import { parseAbsolutePath, parseFindingId, parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parseGitSha, parseIsoTimestamp, parsePullRequestNumber, parseWorkspaceProfileId } from "../../src/domain/ids";
import { createReview } from "../../src/domain/review";
import { createReviewSession } from "../../src/domain/review-session";
import { err, ok, type Result } from "../../src/domain/result";
import { InsightRunCoordinator, type InsightInvoker, type InsightRunResponse } from "../../src/services/insight-run-coordinator";

const must = <T>(result: Result<T, unknown>): T => { if (result._tag === "ok") return result.value; throw new Error("fixture"); };
const profileId = must(parseWorkspaceProfileId("cfw"));
const headSha = must(parseGitSha("a".repeat(40)));
const now = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));

class FailingInsightStore extends InsightStore {
  failWritesRemaining = 0;

  override save(...args: Parameters<InsightStore["save"]>): ReturnType<InsightStore["save"]> {
    if (this.failWritesRemaining > 0) {
      this.failWritesRemaining -= 1;
      return Promise.resolve(err({ _tag: "StorageFailure", operation: "write", reason: "io" }));
    }
    return super.save(...args);
  }
}

async function fixture(invokers: { readonly analysis: InsightInvoker; readonly walkthrough: InsightInvoker }) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-insight-coordinator-"));
  const paths = PatchdeskPaths.forTest(root);
  const sessions = new ReviewSessionStore(paths);
  const reviews = new ReviewStore(paths);
  const insights = new FailingInsightStore(paths);
  const sessionSeed = createReviewSession({ key: { profileId, host: must(parseGitHubHost("github.com")), owner: must(parseGitHubOwner("centraldigital")), repo: must(parseGitHubRepoName("patchdesk")), prNumber: must(parsePullRequestNumber(42)), headSha }, pr: { headSha, isDraft: false, isOpen: true }, patchPath: must(parseAbsolutePath(paths.patchFile(profileId, "placeholder" as never))), worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, "placeholder" as never))), headSha }, createdAt: now });
  const session = { ...sessionSeed, patchPath: must(parseAbsolutePath(paths.patchFile(profileId, sessionSeed.id))), worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, sessionSeed.id))), headSha } };
  const review = createReview({ identity: { profileId, host: session.key.host, owner: session.key.owner, repo: session.key.repo, prNumber: session.key.prNumber }, currentSessionId: session.id, headSha, createdAt: now });
  await mkdir(dirname(session.patchPath), { recursive: true });
  await writeFile(session.patchPath, "diff --git a/src/a.ts b/src/a.ts\n+change\n", "utf8");
  await sessions.save(session);
  await reviews.save(review);
  const coordinator = new InsightRunCoordinator(reviews, sessions, insights, paths, { async get() { return ok({ models: [{ id: "model", label: "Model" }] }); } }, invokers, () => now);
  return { root, coordinator, review, paths, reviews, sessions, insights };
}

const successfulAnalysis = (capture?: { value?: Parameters<InsightInvoker["invoke"]>[0] }): InsightInvoker => ({ async invoke(input) { if (capture !== undefined) capture.value = input; return ok({ changeSummary: "A change", verdict: "comment", summary: "A review", findings: [], validationPlan: [], assumptions: [] }); } });
const successfulWalkthrough: InsightInvoker = { async invoke() { return ok({ title: "Walkthrough", focus: "The change", chapters: [] }); } };

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
    const fixtureValue = await fixture({ analysis: successfulAnalysis(capture), walkthrough: successfulWalkthrough });
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
      analysis: { async invoke() { await pending; return ok({ changeSummary: "A change", verdict: "comment", summary: "A review", findings: [], validationPlan: [], assumptions: [] }); } },
      walkthrough: successfulWalkthrough,
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
    const fixtureValue = await fixture({ analysis: successfulAnalysis(), walkthrough: successfulWalkthrough });
    try {
      const started = await fixtureValue.coordinator.start({ profileId, reviewId: fixtureValue.review.id, type: "analysis", model: "model", reasoning: "low" });
      if (started._tag === "err") throw new Error("expected run");
      const observed = await eventually(() => fixtureValue.coordinator.observe({ profileId, reviewId: fixtureValue.review.id, type: "analysis", runId: started.value.runId }), "completed");
      expect(observed).toEqual({ _tag: "ok", value: { runId: started.value.runId, type: "analysis", status: "completed" } });
      await expect(fixtureValue.coordinator.cancel({ profileId, reviewId: fixtureValue.review.id, type: "analysis", runId: started.value.runId })).resolves.toEqual(observed);
    } finally { await rm(fixtureValue.root, { recursive: true, force: true }); }
  });

  it("dismisses a Finding only for the retained current Analysis run", async () => {
    const findingId = must(parseFindingId("finding-1"));
    const fixtureValue = await fixture({
      analysis: { async invoke() { return ok({ changeSummary: "A change", verdict: "comment", summary: "A review", findings: [{ id: findingId, severity: "P1", title: "Guard", explanation: "The guard is missing.", confidence: "high", mappingStatus: "mapped", file: "src/a.ts", lineStart: 1, diffSide: "new" }], validationPlan: [], assumptions: [] }); } },
      walkthrough: successfulWalkthrough,
    });
    try {
      const started = await fixtureValue.coordinator.start({ profileId, reviewId: fixtureValue.review.id, type: "analysis", model: "model", reasoning: "medium" });
      if (started._tag === "err") throw new Error("expected run");
      await eventually(() => fixtureValue.coordinator.observe({ profileId, reviewId: fixtureValue.review.id, type: "analysis", runId: started.value.runId }), "completed");
      const dismissed = await fixtureValue.coordinator.dismissFinding({ profileId, reviewId: fixtureValue.review.id, runId: started.value.runId, findingId, reason: "Not applicable." });
      expect(dismissed).toEqual({ _tag: "ok", value: { findingId, status: "dismissed" } });
      expect(await fixtureValue.insights.load(profileId, fixtureValue.review.id, "analysis")).toMatchObject({ _tag: "ok", value: { dismissals: [{ findingId, reason: "Not applicable." }] } });
    } finally { await rm(fixtureValue.root, { recursive: true, force: true }); }
  });

  it("rejects adding a Finding until the draft controller is available", async () => {
    const fixtureValue = await fixture({ analysis: successfulAnalysis(), walkthrough: successfulWalkthrough });
    try {
      const result = await fixtureValue.coordinator.addFinding({ profileId, reviewId: fixtureValue.review.id, runId: "insight-analysis-1-aaaaaaaaaaaa-test" as never, findingId: "finding-1" as never });
      expect(result).toEqual({ _tag: "err", error: "draft_unavailable" });
    } finally { await rm(fixtureValue.root, { recursive: true, force: true }); }
  });

  it("turns an orphaned durable run into a retryable failure during recovery", async () => {
    let release!: () => void;
    let resolveInvoked: () => void = () => undefined;
    const invoked = new Promise<void>((resolve) => { resolveInvoked = resolve; });
    const pendingInvoker: InsightInvoker = { async invoke() { resolveInvoked(); await new Promise<void>((resolve) => { release = resolve; }); return ok({ changeSummary: "A change", verdict: "comment", summary: "A review", findings: [], validationPlan: [], assumptions: [] }); } };
    const fixtureValue = await fixture({ analysis: pendingInvoker, walkthrough: successfulWalkthrough });
    try {
      const started = await fixtureValue.coordinator.start({ profileId, reviewId: fixtureValue.review.id, type: "analysis", model: "model", reasoning: "medium" });
      if (started._tag === "err") throw new Error("expected run");
      await invoked;
      const restarted = new InsightRunCoordinator(fixtureValue.reviews, fixtureValue.sessions, new InsightStore(fixtureValue.paths), fixtureValue.paths, { async get() { return ok({ models: [{ id: "model", label: "Model" }] }); } }, { analysis: successfulAnalysis(), walkthrough: successfulWalkthrough }, () => now);
      await expect(restarted.recoverAll()).resolves.toBeUndefined();
      await expect(restarted.observe({ profileId, reviewId: fixtureValue.review.id, type: "analysis", runId: started.value.runId })).resolves.toEqual({ _tag: "ok", value: { runId: started.value.runId, type: "analysis", status: "failed" } });
      release();
    } finally { await rm(fixtureValue.root, { recursive: true, force: true }); }
  });

  it("fails detached execution when the invoker throws or returns invalid output", async () => {
    const throwing = await fixture({ analysis: { async invoke() { throw new Error("provider exploded"); } }, walkthrough: successfulWalkthrough });
    try {
      const started = await throwing.coordinator.start({ profileId, reviewId: throwing.review.id, type: "analysis", model: "model", reasoning: "medium" });
      if (started._tag === "err") throw new Error("expected run");
      await expect(eventually(() => throwing.coordinator.observe({ profileId, reviewId: throwing.review.id, type: "analysis", runId: started.value.runId }), "failed")).resolves.toMatchObject({ _tag: "ok", value: { status: "failed" } });
    } finally { await rm(throwing.root, { recursive: true, force: true }); }

    const invalid = await fixture({ analysis: { async invoke() { return ok({ summary: "not a review result" }); } }, walkthrough: successfulWalkthrough });
    try {
      const started = await invalid.coordinator.start({ profileId, reviewId: invalid.review.id, type: "analysis", model: "model", reasoning: "medium" });
      if (started._tag === "err") throw new Error("expected run");
      await expect(eventually(() => invalid.coordinator.observe({ profileId, reviewId: invalid.review.id, type: "analysis", runId: started.value.runId }), "failed")).resolves.toMatchObject({ _tag: "ok", value: { status: "failed" } });
    } finally { await rm(invalid.root, { recursive: true, force: true }); }
  });

  it("recovers after a terminal persistence failure instead of leaving the run permanently active", async () => {
    const fixtureValue = await fixture({ analysis: successfulAnalysis(), walkthrough: successfulWalkthrough });
    try {
      const started = await fixtureValue.coordinator.start({ profileId, reviewId: fixtureValue.review.id, type: "analysis", model: "model", reasoning: "medium" });
      if (started._tag === "err") throw new Error("expected run");
      fixtureValue.insights.failWritesRemaining = 1;
      await eventually(() => fixtureValue.coordinator.observe({ profileId, reviewId: fixtureValue.review.id, type: "analysis", runId: started.value.runId }), "failed");
      const retried = await fixtureValue.coordinator.start({ profileId, reviewId: fixtureValue.review.id, type: "analysis", model: "model", reasoning: "medium" });
      expect(retried._tag).toBe("ok");
      if (retried._tag === "ok") await eventually(() => fixtureValue.coordinator.observe({ profileId, reviewId: fixtureValue.review.id, type: "analysis", runId: retried.value.runId }), "completed");
    } finally { await new Promise((resolve) => setTimeout(resolve, 50)); await rm(fixtureValue.root, { recursive: true, force: true }); }
  });

  it("persists cancelling before aborting the owned process", async () => {
    let signal: AbortSignal | undefined;
    let resolveInvoked: () => void = () => undefined;
    const invoked = new Promise<void>((resolve) => { resolveInvoked = resolve; });
    const invoker: InsightInvoker = { async invoke(_input, options) { signal = options.signal; resolveInvoked(); await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true })); return { _tag: "err", error: { reason: "cancelled" } }; } };
    const fixtureValue = await fixture({ analysis: invoker, walkthrough: successfulWalkthrough });
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
