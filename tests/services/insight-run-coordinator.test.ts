import { writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { renderSuggestionCommentBody } from "../../src/domain/finding-suggestion";
import {
  parseContentHash,
  parseFindingId,
  parseInsightRunId,
  parseRepoRelativePath,
  type InsightRunId,
} from "../../src/domain/ids";
import {
  beginInsightRun,
  completeInsightRun,
} from "../../src/domain/insight-record";
import { err, ok, type Result } from "../../src/domain/result";
import type { ReviewResult } from "../../src/domain/review-result";
import { contentHash } from "../../src/services/review-artifact-hash";
import type { BriefReachRequest } from "../../src/services/brief-reach-service";
import type { DesktopNotificationEvent } from "../../src/services/desktop-notifier";
import {
  InsightRunCoordinator,
  type InsightInvoker,
} from "../../src/services/insight-run-coordinator";
import { InsightProviderCatalog } from "../../src/services/insight-provider-catalog";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import {
  analysisResult,
  cleanupRoots,
  contextPackFixture,
  fixture,
  headSha,
  must,
  now,
  profileId,
  settled,
} from "./insight-run-fixture";

afterEach(cleanupRoots);

describe("InsightRunCoordinator current lifecycle", () => {
  // Every Insight type is swept at startup, so the table is over the types
  // rather than one test for the one that happened to be written first.
  it.each(["analysis", "walkthrough", "brief"] as const)(
    "recovers a persisted active %s run during bounded startup recovery",
    async (type) => {
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
        type,
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
          brief: {
            async invoke() {
              return ok(analysisResult);
            },
          },
        },
        value.operations,
        contextPackFixture(value.paths).service,
        () => now,
      );
      await recovered.recoverAll();
      expect(
        await value.insights.load(profileId, value.review.id, type),
      ).toMatchObject({
        _tag: "ok",
        value: {
          replacementFailure: { reason: "failed" },
        },
      });
      release();
      await settled(
        value.coordinator,
        value.review.id,
        started.value.runId,
        type,
      );
    },
  );

  it("waits for an existing Review mutation before starting an Insight", async () => {
    const operations = new ReviewOperationCoordinator();
    const value = await fixture(
      {
        async invoke() {
          return ok(analysisResult);
        },
      },
      { operations },
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

  it("runs a Brief and retains it with its citations resolved", async () => {
    const value = await fixture({
      async invoke() {
        return ok({
          flow: [
            {
              kind: "call_tree",
              title: "Recovery",
              nodes: [
                {
                  label: "guard the restart",
                  change: "added",
                  // `h1` is the patch's own single hunk.
                  citations: ["h1"],
                },
              ],
            },
          ],
        });
      },
    });
    const started = await value.coordinator.start({
      profileId,
      reviewId: value.review.id,
      type: "brief",
      model: "model",
      reasoning: "medium",
    });
    if (started._tag === "err") throw new Error("expected run");
    expect(
      await settled(
        value.coordinator,
        value.review.id,
        started.value.runId,
        "brief",
      ),
    ).toMatchObject({ status: "completed" });
    expect(
      await value.insights.load(profileId, value.review.id, "brief"),
    ).toMatchObject({
      _tag: "ok",
      value: {
        retained: {
          value: {
            citationStatus: "verified",
            flow: {
              trees: [
                {
                  kind: "call_tree",
                  nodes: [
                    {
                      label: "guard the restart",
                      change: "added",
                      citations: [{ alias: "h1", kind: "hunk" }],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    });
  });

  it("retains the Reach block the reach service counted for a Brief", async () => {
    const requests: Array<BriefReachRequest> = [];
    const value = await fixture(
      {
        async invoke() {
          return ok({
            reachSymbols: ["guard"],
          });
        },
      },
      {
        operations: new ReviewOperationCoordinator(),
        reach: async (request) => {
          requests.push(request);
          return {
            _tag: "ok",
            value: {
              symbols: [
                {
                  name: "guard",
                  outsideCallerFiles: 1,
                  outsidePaths: ["src/main/local-api.ts"],
                  insidePR: false,
                },
              ],
              surfaces: [{ surface: "Public API" }],
              untested: [],
              removedStillReferenced: [],
              method: "text_match",
              hop: 1,
            },
          };
        },
      },
    );
    const started = await value.coordinator.start({
      profileId,
      reviewId: value.review.id,
      type: "brief",
      model: "model",
      reasoning: "medium",
    });
    if (started._tag === "err") throw new Error("expected run");
    expect(
      await settled(
        value.coordinator,
        value.review.id,
        started.value.runId,
        "brief",
      ),
    ).toMatchObject({ status: "completed" });
    // The model proposed `guard`; the patch's one added line carries it, so
    // Patchdesk is the one that asked for a count of it.
    expect(requests[0]?.symbols).toEqual(["guard"]);
    expect(requests[0]?.headSha).toBe(headSha);
    expect(
      await value.insights.load(profileId, value.review.id, "brief"),
    ).toMatchObject({
      _tag: "ok",
      value: {
        retained: {
          value: {
            reach: {
              method: "text_match",
              hop: 1,
              symbols: [{ name: "guard", outsideCallerFiles: 1 }],
            },
          },
        },
      },
    });
  });

  it("keeps a finding's reported location when the patch cannot map it", async () => {
    // An unmapped finding is the model's only record of where it looked, so
    // mapping must never blank the file and lines it reported.
    const value = await fixture({
      async invoke() {
        return ok({
          ...analysisResult,
          // `approve` is rejected alongside findings by the verdict rule.
          verdict: "comment" as const,
          findings: [
            {
              id: "finding-1",
              title: "Unmapped location",
              explanation: "The cited file is absent from this patch.",
              severity: "P2" as const,
              confidence: "medium" as const,
              file: "src/absent-from-patch.ts",
              lineStart: 12,
              lineEnd: 14,
              diffSide: "new" as const,
            },
          ],
        });
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
    expect(
      await settled(value.coordinator, value.review.id, started.value.runId),
    ).toMatchObject({ status: "completed" });
    expect(
      await value.insights.load(profileId, value.review.id, "analysis"),
    ).toMatchObject({
      _tag: "ok",
      value: {
        retained: {
          value: {
            findings: [
              {
                mappingStatus: "unmapped",
                file: "src/absent-from-patch.ts",
                lineStart: 12,
                lineEnd: 14,
                diffSide: "new",
              },
            ],
          },
        },
      },
    });
  });

  it("observes a Codex run's activity and keeps it after the run ends", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const codexCatalog = new InsightProviderCatalog(
      { get: async () => ok({ models: [] }) },
      () => ({
        listModels: async () =>
          ok([{ id: "model", label: "Model", reasoning: ["medium"] }]),
      }),
      async () => "/usr/local/bin/codex",
    );
    const value = await fixture(
      {
        async invoke(_input, options) {
          options.onActivity?.({ _tag: "turn_started" });
          options.onActivity?.({
            _tag: "command_started",
            id: "cmd-1",
            command: "git diff",
          });
          await wait;
          return ok(analysisResult);
        },
      },
      { providerCatalog: codexCatalog },
    );
    const started = await value.coordinator.start({
      profileId,
      reviewId: value.review.id,
      type: "analysis",
      provider: "codex-cli-account",
      model: "model",
      reasoning: "medium",
    });
    if (started._tag === "err") throw new Error("expected run");
    const trace = {
      phase: "turn",
      commands: [{ id: "cmd-1", command: "git diff", status: "in_progress" }],
    };
    await expect(
      value.coordinator.observe({
        profileId,
        reviewId: value.review.id,
        type: "analysis",
        runId: started.value.runId,
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { status: "queued", activity: trace },
    });
    release();
    expect(
      await settled(value.coordinator, value.review.id, started.value.runId),
    ).toMatchObject({ status: "completed", activity: trace });
  });

  it("never answers one run's poll with another run's trace", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const codexCatalog = new InsightProviderCatalog(
      { get: async () => ok({ models: [] }) },
      () => ({
        listModels: async () =>
          ok([{ id: "model", label: "Model", reasoning: ["medium"] }]),
      }),
      async () => "/usr/local/bin/codex",
    );
    let invocations = 0;
    const value = await fixture(
      {
        async invoke(_input, options) {
          invocations += 1;
          const id = `cmd-${String(invocations)}`;
          options.onActivity?.({ _tag: "command_started", id, command: "pwd" });
          if (invocations > 1) await wait;
          return ok(analysisResult);
        },
      },
      { providerCatalog: codexCatalog },
    );
    const startInput = {
      profileId,
      reviewId: value.review.id,
      type: "analysis",
      provider: "codex-cli-account",
      model: "model",
      reasoning: "medium",
    } as const;
    const first = await value.coordinator.start(startInput);
    if (first._tag === "err") throw new Error("expected first run");
    await settled(value.coordinator, value.review.id, first.value.runId);
    const second = await value.coordinator.start(startInput);
    if (second._tag === "err") throw new Error("expected second run");

    const observed = (runId: typeof first.value.runId) =>
      value.coordinator.observe({
        profileId,
        reviewId: value.review.id,
        type: "analysis",
        runId,
      });
    const firstPoll = await observed(first.value.runId);
    expect(firstPoll).toMatchObject({
      _tag: "ok",
      value: { status: "completed" },
    });
    expect(firstPoll._tag === "ok" && firstPoll.value.activity).toBe(undefined);
    await expect(observed(second.value.runId)).resolves.toMatchObject({
      _tag: "ok",
      value: {
        activity: {
          commands: [{ id: "cmd-2", command: "pwd", status: "in_progress" }],
        },
      },
    });
    release();
    await settled(value.coordinator, value.review.id, second.value.runId);
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

  it("fails a run as invalid_result when the invoker's payload is outside the JSON grammar", async () => {
    // `InsightInvoker.invoke` types its payload `unknown`, so an in-process
    // invoker can hand back a key whose value is `undefined` — which no JSON
    // boundary produces, and which the analysis schema's optional field would
    // otherwise accept and retain.
    const value = await fixture({
      async invoke() {
        return ok({ ...analysisResult, coverage: undefined });
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
    expect(
      await settled(value.coordinator, value.review.id, started.value.runId),
    ).toMatchObject({
      status: "failed",
      failureReason: "invalid_result",
      failureCategory: "invalid_result",
    });
    expect(
      await value.insights.load(profileId, value.review.id, "analysis"),
    ).toMatchObject({
      _tag: "ok",
      value: {
        replacementFailure: {
          reason: "invalid_result",
          category: "invalid_result",
        },
      },
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

describe("InsightRunCoordinator desktop notifications", () => {
  /** Starts one Analysis, waits for it to settle and release the Review lock, and returns what was posted. */
  async function notificationsFor(
    invoker: InsightInvoker,
    during?: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  ): Promise<ReadonlyArray<DesktopNotificationEvent>> {
    const events: DesktopNotificationEvent[] = [];
    const value = await fixture(invoker, {
      notifier: { notify: (event) => events.push(event) },
    });
    const started = await value.coordinator.start({
      profileId,
      reviewId: value.review.id,
      type: "analysis",
      model: "model",
      reasoning: "medium",
    });
    if (started._tag === "err") throw new Error("expected run");
    await during?.(value);
    await settled(value.coordinator, value.review.id, started.value.runId);
    await value.operations.withReviewLock(
      profileId,
      value.review.id,
      async () => undefined,
    );
    return events;
  }

  it("posts one completed event naming the pull request", async () => {
    const events = await notificationsFor({
      async invoke() {
        return ok(analysisResult);
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        _tag: "InsightSettled",
        insightType: "analysis",
        outcome: "completed",
        pullRequest: expect.objectContaining({
          owner: "octo-org",
          number: 42,
        }),
      }),
    ]);
  });

  it.each([
    [
      "an invocation failure",
      {
        async invoke() {
          return err({ reason: "execution_failed" as const });
        },
      },
    ],
    [
      "an unexpected failure",
      {
        async invoke(): Promise<Result<unknown, never>> {
          throw new Error("invoker defect");
        },
      },
    ],
  ])("posts one failed event after %s", async (_label, invoker) => {
    const events = await notificationsFor(invoker);

    expect(events).toMatchObject([
      { _tag: "InsightSettled", outcome: "failed" },
    ]);
  });

  it("posts nothing for a run the maintainer cancelled", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events = await notificationsFor(
      {
        async invoke() {
          await wait;
          return ok(analysisResult);
        },
      },
      async (value) => {
        const active = await value.insights.load(
          profileId,
          value.review.id,
          "analysis",
        );
        const runId =
          active._tag === "ok" ? active.value.activeRun?.id : undefined;
        if (runId === undefined) throw new Error("expected active run");
        await value.coordinator.cancel({
          profileId,
          reviewId: value.review.id,
          type: "analysis",
          runId,
        });
        release();
      },
    );

    expect(events).toEqual([]);
  });

  it("posts nothing for a run superseded by a changed patch", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events = await notificationsFor(
      {
        async invoke() {
          await wait;
          return ok(analysisResult);
        },
      },
      async (value) => {
        await writeFile(
          value.session.patchPath,
          "diff --git a/a.ts b/a.ts\n+different\n",
          "utf8",
        );
        release();
      },
    );

    expect(events).toEqual([]);
  });
});

describe("InsightRunCoordinator Finding suggestions", () => {
  const findingId = must(parseFindingId("finding-1"));
  const guardFinding = {
    id: findingId,
    severity: "P1",
    title: "Guard the added branch",
    file: must(parseRepoRelativePath("a.ts")),
    lineStart: 1,
    lineEnd: 1,
    diffSide: "new",
    explanation: "The added line accepts an invalid value.",
    suggestedComment: "Reject invalid values here.",
    confidence: "high",
    mappingStatus: "mapped",
    suggestedReplacement: { code: "guarded" },
  } as const;

  /**
   * Retains one Analysis result against the session's current revision, so a
   * test can name the exact Finding the suggestion command has to resolve
   * without running a provider.
   */
  async function seedRetainedAnalysis(
    value: Awaited<ReturnType<typeof fixture>>,
    findings: ReviewResult["findings"],
  ): Promise<InsightRunId> {
    const patchHash = must(
      parseContentHash(await contentHash(value.session.patchPath)),
    );
    const runId = must(
      parseInsightRunId(`insight-analysis-1-aaaaaaaaaaaa-${value.review.id}`),
    );
    const revision = { sessionId: value.session.id, headSha, patchHash };
    const begun = await value.insights.mutate({
      profileId,
      reviewId: value.review.id,
      type: "analysis",
      now,
      operation: (record) =>
        beginInsightRun(record, {
          id: runId,
          revision,
          provider: "pi",
          model: "model",
          reasoning: "medium",
          startedAt: now,
        }),
    });
    if (begun._tag === "err") throw new Error("could not seed an Analysis run");
    const retained = await value.insights.mutate({
      profileId,
      reviewId: value.review.id,
      type: "analysis",
      now,
      operation: (record) =>
        completeInsightRun(
          record,
          runId,
          {
            runId,
            revision,
            generatedAt: now,
            provenance: {
              provider: "pi",
              model: "model",
              reasoning: "medium",
            },
            value: { ...analysisResult, verdict: "comment", findings },
          },
          now,
        ),
    });
    if (retained._tag === "err")
      throw new Error("could not retain the Analysis result");
    return runId;
  }

  it("rebuilds the anchor and the suggestion body from the represented patch", async () => {
    const value = await fixture({
      async invoke() {
        return ok(analysisResult);
      },
    });
    const runId = await seedRetainedAnalysis(value, [guardFinding]);
    const patchHash = must(
      parseContentHash(await contentHash(value.session.patchPath)),
    );

    const resolved = await value.coordinator.resolveFindingSuggestion({
      profileId,
      reviewId: value.review.id,
      runId,
      findingId,
    });

    expect(resolved).toEqual(
      ok({
        anchor: { path: "a.ts", startLine: 1, line: 1, side: "new" },
        body: renderSuggestionCommentBody(
          "Reject invalid values here.",
          "guarded",
        ),
        finding: {
          analysisRunId: runId,
          findingId: "finding-1",
          sessionId: value.session.id,
          headSha,
          patchHash,
        },
      }),
    );
  });

  it("refuses a suggestion after the represented patch moved", async () => {
    const value = await fixture({
      async invoke() {
        return ok(analysisResult);
      },
    });
    const runId = await seedRetainedAnalysis(value, [guardFinding]);
    await writeFile(
      value.session.patchPath,
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+other\n",
      "utf8",
    );

    expect(
      await value.coordinator.resolveFindingSuggestion({
        profileId,
        reviewId: value.review.id,
        runId,
        findingId,
      }),
    ).toEqual(err("stale_request"));
  });

  it("answers not found for a Finding that retained no replacement", async () => {
    const value = await fixture({
      async invoke() {
        return ok(analysisResult);
      },
    });
    const { suggestedReplacement: _dropped, ...withoutReplacement } =
      guardFinding;
    void _dropped;
    const runId = await seedRetainedAnalysis(value, [withoutReplacement]);

    expect(
      await value.coordinator.resolveFindingSuggestion({
        profileId,
        reviewId: value.review.id,
        runId,
        findingId,
      }),
    ).toEqual(err("not_found"));
  });
});
