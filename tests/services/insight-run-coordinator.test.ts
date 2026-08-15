import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InsightStore } from "../../src/adapters/storage/insight-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import {
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { createReview } from "../../src/domain/review";
import { createReviewSession } from "../../src/domain/review-session";
import { ok, type Result } from "../../src/domain/result";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import {
  InsightRunCoordinator,
  type InsightInvoker,
  type InsightRunResponse,
} from "../../src/services/insight-run-coordinator";

const roots: string[] = [];
const must = <T>(value: Result<T, unknown>): T => {
  if (value._tag === "ok") return value.value;
  throw new Error("fixture value is invalid");
};
const profileId = must(parseWorkspaceProfileId("cfw"));
const headSha = must(parseGitSha("a".repeat(40)));
const now = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const analysisResult = {
  changeSummary: "Adds one guarded change.",
  verdict: "approve" as const,
  summary: "Check the guard.",
  findings: [],
  validationPlan: [],
  assumptions: [],
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  invoker: InsightInvoker,
  operations = new ReviewOperationCoordinator(),
) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-insight-current-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  const sessions = new ReviewSessionStore(paths);
  const reviews = new ReviewStore(paths);
  const insights = new InsightStore(paths);
  const seeded = createReviewSession({
    key: {
      profileId,
      host: must(parseGitHubHost("github.com")),
      owner: must(parseGitHubOwner("centraldigital")),
      repo: must(parseGitHubRepoName("patchdesk")),
      prNumber: must(parsePullRequestNumber(42)),
      headSha,
    },
    pr: { headSha, isDraft: false, isOpen: true },
    patchPath: must(
      parseAbsolutePath(paths.patchFile(profileId, "placeholder" as never)),
    ),
    worktree: {
      path: must(
        parseAbsolutePath(
          paths.worktreeDirectory(profileId, "placeholder" as never),
        ),
      ),
      headSha,
    },
    createdAt: now,
  });
  const session = {
    ...seeded,
    patchPath: must(parseAbsolutePath(paths.patchFile(profileId, seeded.id))),
    worktree: {
      path: must(
        parseAbsolutePath(paths.worktreeDirectory(profileId, seeded.id)),
      ),
      headSha,
    },
  };
  await mkdir(dirname(session.patchPath), { recursive: true });
  await writeFile(
    session.patchPath,
    "diff --git a/a.ts b/a.ts\n+guard\n",
    "utf8",
  );
  await sessions.save(session);
  const review = createReview({
    identity: {
      profileId,
      host: session.key.host,
      owner: session.key.owner,
      repo: session.key.repo,
      prNumber: session.key.prNumber,
    },
    currentSessionId: session.id,
    headSha,
    createdAt: now,
  });
  await reviews.save(review);
  const coordinator = new InsightRunCoordinator(
    reviews,
    sessions,
    insights,
    paths,
    {
      async get() {
        return ok({ models: [{ id: "model", label: "Model" }] });
      },
    },
    { analysis: invoker, walkthrough: invoker },
    operations,
    () => now,
  );
  return {
    coordinator,
    insights,
    reviews,
    sessions,
    review,
    session,
    paths,
    operations,
  };
}

async function settled(
  coordinator: InsightRunCoordinator,
  reviewId: string,
  runId: string,
): Promise<InsightRunResponse> {
  for (let retry = 0; retry < 100; retry += 1) {
    const state = await coordinator.observe({
      profileId,
      reviewId: reviewId as never,
      type: "analysis",
      runId: runId as never,
    });
    if (
      state._tag === "ok" &&
      state.value.status !== "queued" &&
      state.value.status !== "running" &&
      state.value.status !== "cancelling"
    )
      return state.value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Insight did not settle");
}

describe("InsightRunCoordinator current lifecycle", () => {
  it("recovers persisted active runs during bounded startup recovery", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const value = await fixture({
      async invoke() {
        await waiting;
        return ok(analysisResult);
      },
    });
    const started = await value.coordinator.start({
      profileId,
      reviewId: value.review.id,
      type: "analysis",
      model: "model",
      reasoning: "medium",
    });
    if (started._tag === "err") throw new Error("expected active run");

    const recovered = new InsightRunCoordinator(
      value.reviews,
      value.sessions,
      value.insights,
      value.paths,
      {
        async get() {
          return ok({ models: [{ id: "model", label: "Model" }] });
        },
      },
      {
        analysis: {
          async invoke() {
            return ok(analysisResult);
          },
        },
        walkthrough: {
          async invoke() {
            return ok(analysisResult);
          },
        },
      },
      value.operations,
      () => now,
    );
    await recovered.recoverAll();
    expect(
      await value.insights.load(profileId, value.review.id, "analysis"),
    ).toMatchObject({
      _tag: "ok",
      value: {
        replacementFailure: { reason: "failed" },
      },
    });
    release();
    await settled(value.coordinator, value.review.id, started.value.runId);
  });

  it("waits for an existing Review mutation before starting an Insight", async () => {
    const operations = new ReviewOperationCoordinator();
    const value = await fixture(
      {
        async invoke() {
          return ok(analysisResult);
        },
      },
      operations,
    );
    let release!: () => void;
    const held = operations.withReviewLock(
      profileId,
      value.review.id,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    let completed = false;
    const started = value.coordinator
      .start({
        profileId,
        reviewId: value.review.id,
        type: "analysis",
        model: "model",
        reasoning: "medium",
      })
      .then((result) => {
        completed = true;
        return result;
      });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(
      await value.insights.load(profileId, value.review.id, "analysis"),
    ).toMatchObject({ _tag: "err", error: { reason: "not_found" } });

    release();
    await held;
    const result = await started;
    expect(result).toMatchObject({
      _tag: "ok",
      value: { status: "queued" },
    });
    if (result._tag === "err") throw new Error("expected queued Insight");
    await settled(value.coordinator, value.review.id, result.value.runId);
  });
  it("starts from session artifacts, retains a valid result, and exposes completion", async () => {
    let received: unknown;
    const value = await fixture({
      async invoke(input) {
        received = input;
        return ok(analysisResult);
      },
    });
    const started = await value.coordinator.start({
      profileId,
      reviewId: value.review.id,
      type: "analysis",
      model: "model",
      reasoning: "medium",
    });
    expect(started).toMatchObject({
      _tag: "ok",
      value: { status: "queued", type: "analysis" },
    });
    if (started._tag === "err") throw new Error("expected run");
    expect(
      await settled(value.coordinator, value.review.id, started.value.runId),
    ).toMatchObject({ status: "completed" });
    expect(received).toMatchObject({
      sessionId: value.session.id,
      contextPath: value.paths.preparedContextFile(profileId, value.session.id),
      reviewInputPath: value.paths.preparedReviewInputFile(
        profileId,
        value.session.id,
      ),
      patchPath: value.session.patchPath,
      worktreePath: value.session.worktree.path,
    });
    expect(
      await value.insights.load(profileId, value.review.id, "analysis"),
    ).toMatchObject({
      _tag: "ok",
      value: { retained: { value: { summary: "Check the guard." } } },
    });
  });

  it("persists cancellation before aborting and does not retain a late success", async () => {
    let release!: () => void;
    let signal: AbortSignal | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const value = await fixture({
      async invoke(_input, options) {
        signal = options.signal;
        await wait;
        return ok(analysisResult);
      },
    });
    const started = await value.coordinator.start({
      profileId,
      reviewId: value.review.id,
      type: "analysis",
      model: "model",
      reasoning: "medium",
    });
    if (started._tag === "err") throw new Error("expected run");
    await expect(
      value.coordinator.cancel({
        profileId,
        reviewId: value.review.id,
        type: "analysis",
        runId: started.value.runId,
      }),
    ).resolves.toMatchObject({ _tag: "ok", value: { status: "cancelling" } });
    expect(signal?.aborted).toBe(true);
    release();
    expect(
      await settled(value.coordinator, value.review.id, started.value.runId),
    ).toMatchObject({ status: "cancelled", failureReason: "cancelled" });
    expect(
      await value.insights.load(profileId, value.review.id, "analysis"),
    ).toMatchObject({
      _tag: "ok",
      value: { replacementFailure: { reason: "cancelled" } },
    });
  });

  it("marks output superseded when its represented patch changes during execution", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const value = await fixture({
      async invoke() {
        await wait;
        return ok(analysisResult);
      },
    });
    const started = await value.coordinator.start({
      profileId,
      reviewId: value.review.id,
      type: "analysis",
      model: "model",
      reasoning: "medium",
    });
    if (started._tag === "err") throw new Error("expected run");
    await writeFile(
      value.session.patchPath,
      "diff --git a/a.ts b/a.ts\n+different\n",
      "utf8",
    );
    release();
    expect(
      await settled(value.coordinator, value.review.id, started.value.runId),
    ).toMatchObject({ status: "failed", failureReason: "superseded" });
    expect(
      await value.insights.load(profileId, value.review.id, "analysis"),
    ).toMatchObject({
      _tag: "ok",
      value: { replacementFailure: { reason: "superseded" } },
    });
  });

  it("keeps the last retained result when a replacement returns malformed output", async () => {
    let calls = 0;
    const value = await fixture({
      async invoke() {
        calls += 1;
        return ok(calls === 1 ? analysisResult : { unexpected: true });
      },
    });
    const first = await value.coordinator.start({
      profileId,
      reviewId: value.review.id,
      type: "analysis",
      model: "model",
      reasoning: "medium",
    });
    if (first._tag === "err") throw new Error("expected first run");
    await settled(value.coordinator, value.review.id, first.value.runId);
    const second = await value.coordinator.start({
      profileId,
      reviewId: value.review.id,
      type: "analysis",
      model: "model",
      reasoning: "medium",
    });
    if (second._tag === "err") throw new Error("expected second run");
    expect(
      await settled(value.coordinator, value.review.id, second.value.runId),
    ).toMatchObject({ status: "failed", failureReason: "invalid_result" });
    expect(
      await value.insights.load(profileId, value.review.id, "analysis"),
    ).toMatchObject({
      _tag: "ok",
      value: {
        retained: { value: { summary: "Check the guard." } },
        replacementFailure: { reason: "invalid_result" },
      },
    });
  });
});
