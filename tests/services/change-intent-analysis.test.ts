import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CommandRunner } from "../../src/adapters/github/command-runner";
import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import type { ChangeIntent } from "../../src/domain/change-intent";
import { parseRepoRelativePath } from "../../src/domain/ids";
import type { InsightType } from "../../src/domain/insight-record";
import { ok } from "../../src/domain/result";
import { createReadOnlyGitExecutor } from "../../src/main/local-api-stores";
import {
  InsightRunCoordinator,
  type InsightInvoker,
} from "../../src/services/insight-run-coordinator";
import { LocalChangeIntentService } from "../../src/services/local-change-intent-service";
import { ReviewContextPackService } from "../../src/services/review-context-pack-service";
import { ReviewContextService } from "../../src/services/review-context-service";
import { analysisResult, settled } from "./insight-run-fixture";
import {
  cleanupLocalApplyRoots,
  localApplyHarness,
  now,
  profileId,
  value,
} from "./local-apply-fixture";

afterEach(cleanupLocalApplyRoots);

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const briefResult = {
  flow: [
    {
      kind: "call_tree",
      title: "Recovery",
      nodes: [{ label: "guard", change: "added", citations: ["h1"] }],
    },
  ],
};

/**
 * A working-tree Review of a checkout holding `files`, with an Insight run
 * coordinator whose invoker records the `review-input.md` each run read.
 */
async function intentReview(
  files: Readonly<Record<string, string | Buffer>>,
  invoke: InsightInvoker["invoke"] = async (input) =>
    ok(input.type === "brief" ? briefResult : analysisResult),
) {
  const harness = await localApplyHarness();
  for (const [path, contents] of Object.entries(files))
    await writeFile(join(harness.repositoryPath, path), contents);
  const workbench = await harness.open();
  const reviewInputs: string[] = [];
  const invoker: InsightInvoker = {
    async invoke(input, options) {
      if (input.type === "analysis" && input.reviewInputPath !== undefined)
        reviewInputs.push(await readFile(input.reviewInputPath, "utf8"));
      return invoke(input, options);
    },
  };
  const insights = new InsightRunCoordinator(
    harness.reviews,
    new ReviewSessionStore(harness.paths),
    harness.insights,
    harness.paths,
    { get: async () => ok({ models: [{ id: "model", label: "Model" }] }) },
    { analysis: invoker, walkthrough: invoker, brief: invoker },
    harness.coordinator,
    new ReviewContextPackService({
      profiles: new ProfileStore(harness.paths),
      github: new FakeGitHubAdapter({}),
      context: new ReviewContextService(),
      paths: harness.paths,
      git: createReadOnlyGitExecutor(new CommandRunner()),
    }),
    () => now,
  );
  const intents = new LocalChangeIntentService({
    reviews: harness.reviews,
    coordinator: harness.coordinator,
    now: () => now,
  });
  const reviewId = workbench.review.id;
  const start = (type: InsightType = "analysis") =>
    insights.start({
      profileId,
      reviewId,
      type,
      model: "model",
      reasoning: "medium",
      language: "en",
    });
  return {
    harness,
    insights,
    reviewId,
    reviewInputs,
    setIntent: async (intent: ChangeIntent) =>
      value(await intents.set({ profileId, reviewId, intent })),
    start,
    run: async (type: InsightType = "analysis") => {
      const run = value(await start(type));
      const state = await settled(insights, reviewId, run.runId, type);
      // The run reads as settled before its completion write lets go of the Review lock.
      await harness.coordinator.withReviewLock(
        profileId,
        reviewId,
        async () => undefined,
      );
      return state;
    },
    retainedAnalysis: async () =>
      value(await harness.insights.load(profileId, reviewId, "analysis"))
        .retained,
  };
}

const specPath = value(parseRepoRelativePath("spec.md"));

describe("Change intent in an Analysis run", () => {
  it("hands Analysis entered text between delimiters and records its digest", async () => {
    const review = await intentReview({});
    await review.setIntent({
      kind: "text",
      markdown: "Reject a negative total.",
    });

    expect(await review.run()).toMatchObject({ status: "completed" });

    expect(review.reviewInputs[0]).toContain(
      [
        "## Change intent",
        "",
        "Source: text entered by the maintainer",
        "",
        "BEGIN CHANGE INTENT",
        "Reject a negative total.",
        "END CHANGE INTENT",
      ].join("\n"),
    );
    expect((await review.retainedAnalysis())?.changeIntent).toEqual({
      kind: "text",
      sha256: sha256("Reject a negative total."),
    });
  });

  it("reads a spec file from the Local snapshot, not from the working tree edited after it", async () => {
    const review = await intentReview({ "spec.md": "Goal: add a guard.\n" });
    await writeFile(
      join(review.harness.repositoryPath, "spec.md"),
      "Goal: remove the guard.\n",
    );
    await review.setIntent({ kind: "file", path: specPath });

    expect(await review.run()).toMatchObject({ status: "completed" });

    expect(review.reviewInputs[0]).toContain(
      "Source: spec file `spec.md` at the reviewed revision\n\nBEGIN CHANGE INTENT\nGoal: add a guard.\nEND CHANGE INTENT",
    );
    expect(review.reviewInputs[0]).not.toContain("remove the guard");
    expect((await review.retainedAnalysis())?.changeIntent).toEqual({
      kind: "file",
      path: "spec.md",
      sha256: sha256("Goal: add a guard.\n"),
    });
  });

  it("rebuilds the Analysis input when only the intent changed", async () => {
    const review = await intentReview({});
    await review.setIntent({ kind: "text", markdown: "First goal." });
    await review.run();
    await review.setIntent({ kind: "text", markdown: "Second goal." });

    await review.run();

    expect(review.reviewInputs[1]).toContain("Second goal.");
    expect(review.reviewInputs[1]).not.toContain("First goal.");
  });

  it("keeps a running Analysis's input when a second start is refused", async () => {
    let finish: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const review = await intentReview({}, async () => {
      await running;
      return ok(analysisResult);
    });
    await review.setIntent({ kind: "text", markdown: "First goal." });
    const first = value(await review.start());
    await review.setIntent({ kind: "text", markdown: "Second goal." });

    expect(await review.start()).toEqual({
      _tag: "err",
      error: "already_running",
    });
    expect(
      await readFile(
        review.harness.paths.preparedReviewInputFile(
          profileId,
          value(await review.harness.reviews.load(profileId, review.reviewId))
            .currentSessionId,
        ),
        "utf8",
      ),
    ).toContain("First goal.");
    finish();
    await settled(review.insights, review.reviewId, first.runId);
  });

  it.each([
    ["missing", {}, "change_intent_file_missing"],
    [
      "over 65,536 bytes",
      { "spec.md": "a".repeat(65_537) },
      "change_intent_file_too_large",
    ],
    [
      "binary",
      { "spec.md": Buffer.from([0x47, 0x00, 0x6f]) },
      "change_intent_file_not_text",
    ],
  ] as const)(
    "refuses an Analysis whose spec file is %s, and starts nothing",
    async (_case, files, reason) => {
      const review = await intentReview(files);
      await review.setIntent({ kind: "file", path: specPath });

      expect(await review.start()).toEqual({ _tag: "err", error: reason });
      expect(
        await review.harness.insights.load(
          profileId,
          review.reviewId,
          "analysis",
        ),
      ).toMatchObject({ _tag: "err", error: { reason: "not_found" } });
    },
  );

  it("runs a Brief whatever the spec file, since only Analysis reads the intent", async () => {
    const review = await intentReview({});
    await review.setIntent({ kind: "file", path: specPath });

    expect(await review.run("brief")).toMatchObject({ status: "completed" });
  });
});
