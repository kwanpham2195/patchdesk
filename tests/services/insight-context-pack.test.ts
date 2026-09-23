import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import { ok } from "../../src/domain/result";
import {
  analysisResult,
  cleanupRoots,
  fixture,
  profileId,
  settled,
} from "./insight-run-fixture";

afterEach(cleanupRoots);

/**
 * The context pack is no longer written at prepare, so the Insight run owns
 * building it. These tests pin what that makes load-bearing: the pack exists
 * before the invoker reads it, it is built once however many runs start, a
 * pack that does not describe this session's patch is rebuilt, and a build
 * that cannot reach GitHub refuses the run rather than running against a
 * pack that is not there.
 */
describe("Insight run context pack", () => {
  const completes = {
    async invoke() {
      return ok(analysisResult);
    },
  };

  async function run(
    value: Awaited<ReturnType<typeof fixture>>,
    type: "analysis" | "brief" = "analysis",
  ) {
    const started = await value.coordinator.start({
      profileId,
      reviewId: value.review.id,
      type,
      model: "model",
      reasoning: "medium",
    });
    if (started._tag === "err")
      throw new Error(`start failed: ${started.error}`);
    return settled(
      value.coordinator,
      value.review.id,
      started.value.runId,
      type,
    );
  }

  it("builds the pack before the run reads it, and reuses it on the next run", async () => {
    let contextAtInvoke: string | undefined;
    const value = await fixture({
      async invoke(input) {
        contextAtInvoke = await readFile(input.contextPath, "utf8").catch(
          () => undefined,
        );
        return ok(analysisResult);
      },
    });
    const contextPath = value.paths.preparedContextFile(
      profileId,
      value.session.id,
    );

    expect(await run(value)).toMatchObject({ status: "completed" });
    expect(value.contextPack.commentReads).toBe(1);
    // The invoker saw a pack, so the build ran ahead of every reader.
    expect(contextAtInvoke).toBeDefined();
    for (const path of [
      contextPath,
      value.paths.preparedReviewInputFile(profileId, value.session.id),
      value.paths.preparedDebugFile(profileId, value.session.id),
    ])
      expect(await readFile(path, "utf8")).toBeDefined();

    expect(await run(value)).toMatchObject({ status: "completed" });
    expect(value.contextPack.commentReads).toBe(1);
  });

  it("rebuilds a pack whose context.json does not parse", async () => {
    const value = await fixture(completes);
    const contextPath = value.paths.preparedContextFile(
      profileId,
      value.session.id,
    );
    await mkdir(dirname(contextPath), { recursive: true });
    // A crash mid-build leaves exactly this: a truncated file, no siblings.
    await writeFile(contextPath, '{"pr":{"title"', "utf8");

    await run(value);

    expect(value.contextPack.commentReads).toBe(1);
    expect(JSON.parse(await readFile(contextPath, "utf8"))).toMatchObject({
      changedFiles: ["a.ts"],
    });
  });

  it("rebuilds a pack left by a different patch", async () => {
    const value = await fixture(completes);
    const contextPath = value.paths.preparedContextFile(
      profileId,
      value.session.id,
    );
    await mkdir(dirname(contextPath), { recursive: true });
    await writeFile(
      contextPath,
      JSON.stringify({ patch: { path: "old", sha256: "f".repeat(64) } }),
      "utf8",
    );
    await writeFile(
      value.paths.preparedReviewInputFile(profileId, value.session.id),
      "stale",
      "utf8",
    );
    await writeFile(
      value.paths.preparedDebugFile(profileId, value.session.id),
      "{}",
      "utf8",
    );

    await run(value);

    expect(value.contextPack.commentReads).toBe(1);
    expect(JSON.parse(await readFile(contextPath, "utf8"))).toMatchObject({
      changedFiles: ["a.ts"],
    });
  });

  it("lists a git-quoted changed path in the built pack", async () => {
    // Git C-quotes any path with a non-ASCII byte, so the `+++ b/` prefix
    // test this list used to run never matched one and the file went
    // unlisted. Moved here with the builder from the prepare suite.
    const value = await fixture(completes);
    await writeFile(
      value.session.patchPath,
      [
        'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
        '--- "a/src/caf\\303\\251.ts"',
        '+++ "b/src/caf\\303\\251.ts"',
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
      "utf8",
    );

    await run(value);

    expect(
      JSON.parse(
        await readFile(
          value.paths.preparedContextFile(profileId, value.session.id),
          "utf8",
        ),
      ),
    ).toMatchObject({ changedFiles: ["src/café.ts"] });
  });

  it("builds once when two runs start together", async () => {
    const value = await fixture(completes);

    const [first, second] = await Promise.all([
      value.coordinator.start({
        profileId,
        reviewId: value.review.id,
        type: "analysis",
        model: "model",
        reasoning: "medium",
      }),
      value.coordinator.start({
        profileId,
        reviewId: value.review.id,
        type: "brief",
        model: "model",
        reasoning: "medium",
      }),
    ]);
    if (first._tag === "err" || second._tag === "err")
      throw new Error("expected two queued runs");

    expect(value.contextPack.commentReads).toBe(1);
    await settled(value.coordinator, value.review.id, first.value.runId);
    await settled(
      value.coordinator,
      value.review.id,
      second.value.runId,
      "brief",
    );
  });

  it("refuses the run when the pack cannot be built", async () => {
    const value = await fixture(completes, {
      // No `comments` fixture value, so the comments read fails the way an
      // unreachable GitHub does.
      github: new FakeGitHubAdapter({
        checks: { overall: "unknown", checks: [] },
      }),
    });

    expect(
      await value.coordinator.start({
        profileId,
        reviewId: value.review.id,
        type: "analysis",
        model: "model",
        reasoning: "medium",
      }),
    ).toEqual({ _tag: "err", error: "storage_unavailable" });
    // Nothing started, so nothing has to be swept later.
    expect(
      await value.insights.load(profileId, value.review.id, "analysis"),
    ).toMatchObject({ _tag: "err" });
  });
});
