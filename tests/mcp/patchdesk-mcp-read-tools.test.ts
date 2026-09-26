import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as v from "valibot";
import { afterEach, describe, expect, it } from "vitest";

import { InsightStore } from "../../src/adapters/storage/insight-store";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import {
  parseContentHash,
  parseGitSha,
  parseReviewId,
  parseReviewSessionId,
} from "../../src/domain/ids";
import { dismissInsightFinding } from "../../src/domain/insight-record";
import { isLocalReview, markLocalDraftsApplied } from "../../src/domain/review";
import {
  startAppWithLinkedWorktree,
  type McpAppFixture,
} from "../main/mcp-app-fixture";
import {
  beginRun,
  now,
  profileId,
  retainAnalysis,
  suggestionFinding,
  value,
} from "../services/local-apply-fixture";
import { closeMcpTestClients, mcpProtocolEras } from "./mcp-test-clients";
import {
  addNote,
  call,
  loadRoute,
  openRoute,
  reviewWithNotes,
  type Workbench,
} from "./mcp-read-tools-fixture";

/** The ids an Insight run binds to, parsed from the workbench the open route answered. */
function runTarget(workbench: Workbench) {
  return {
    review: { id: value(parseReviewId(workbench.review.id)) },
    session: {
      id: value(parseReviewSessionId(workbench.session.id)),
      key: { headSha: value(parseGitSha(workbench.session.key.headSha)) },
    },
    revision: {
      patchHash: value(parseContentHash(workbench.revision.patchHash)),
    },
  };
}

let app: McpAppFixture | undefined;
const directories: Array<string> = [];

afterEach(async () => {
  await closeMcpTestClients();
  await app?.stop();
  app = undefined;
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe.each(mcpProtocolEras)(
  "MCP read tools on the $era era",
  ({ connect }) => {
    it("review_local opens the checkout containing cwd as the open-local route does and records the agent's intent once", async () => {
      app = await startAppWithLinkedWorktree();
      await mkdir(join(app.linkedPath, "src"));
      await writeFile(join(app.linkedPath, "src", "app.ts"), "export {};\n");
      await writeFile(join(app.linkedPath, "tracked.txt"), "two\n");
      const client = await connect(app.socketPath);

      const first = await call(client, "review_local", {
        cwd: join(app.linkedPath, "src"),
        intent: "Add the app entry point.",
      });
      const again = await call(client, "review_local", {
        cwd: app.linkedPath,
        intent: "Add the app entry point.",
      });
      const route = await openRoute(app, app.linkedPath);
      const loaded = await loadRoute(app, route.review.id);

      expect(first.isError).toBe(false);
      expect(first.content).toEqual({
        reviewId: route.review.id,
        sessionId: route.session.id,
        headSha: route.session.key.headSha,
        baseSha: execFileSync("git", [
          "-C",
          app.linkedPath,
          "rev-parse",
          "HEAD",
        ])
          .toString()
          .trim(),
        patchHash: route.revision.patchHash,
        title: "Working tree on feat/linked in linked",
        changedFiles: [
          { path: "src/app.ts", status: "added", additions: 1, deletions: 0 },
          {
            path: "tracked.txt",
            status: "modified",
            additions: 1,
            deletions: 1,
          },
        ],
        retainedInsights: [],
        intentRecorded: true,
        intentKept: false,
      });
      expect(again.content).toMatchObject({
        sessionId: route.session.id,
        intentRecorded: true,
        intentKept: true,
      });
      expect(loaded.changeIntent).toMatchObject({
        intent: {
          kind: "text",
          markdown: "Add the app entry point.",
          source: "agent",
        },
      });
    });

    it("review_local returns the opened Review with the refusal when it holds a different intent, and leaves the Review unmoved (#513)", async () => {
      app = await startAppWithLinkedWorktree();
      await writeFile(join(app.repositoryPath, "tracked.txt"), "two\n");
      const client = await connect(app.socketPath);
      const first = await call(client, "review_local", {
        cwd: app.repositoryPath,
        intent: "Ship the first goal.",
      });
      const { reviewId, sessionId } = v.parse(
        v.object({ reviewId: v.string(), sessionId: v.string() }),
        first.content,
      );
      await writeFile(join(app.repositoryPath, "tracked.txt"), "three\n");

      const second = await call(client, "review_local", {
        cwd: app.repositoryPath,
        intent: "Ship another goal.",
      });
      const stored = value(
        await new ReviewStore(app.paths).load(
          profileId,
          value(parseReviewId(reviewId)),
        ),
      );

      expect(second).toMatchObject({
        isError: false,
        content: {
          reviewId,
          sessionId,
          intentRecorded: false,
          intentRefused: "intent_exists",
          intentMessage: expect.any(String),
        },
      });
      expect(second.content).not.toHaveProperty("intentKept");
      expect(stored.currentSessionId).toBe(sessionId);
      expect(stored.changeIntent).toMatchObject({
        markdown: "Ship the first goal.",
      });
    });

    it("get_insight reads each Finding's dismissed, drafted, and applied state as the workbench projects it, and marks an earlier session's result outdated", async () => {
      app = await startAppWithLinkedWorktree();
      await writeFile(
        join(app.repositoryPath, "probe.ts"),
        "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n",
      );
      const workbench = await openRoute(app, app.repositoryPath);
      const fix = (id: string, line: number) =>
        suggestionFinding(
          `finding-${id}`,
          "probe.ts",
          { start: line, end: line },
          `const ${id} = ${String(line)};`,
        );
      const appliedFix = fix("applied", 2);
      const dismissedFix = fix("dismissed", 3);
      const findings = [
        fix("drafted", 1),
        appliedFix,
        dismissedFix,
        fix("open", 4),
      ];
      const insights = new InsightStore(app.paths);
      const runId = await retainAnalysis(
        insights,
        runTarget(workbench),
        findings,
      );
      for (const findingId of ["finding-drafted", "finding-applied"]) {
        const added = await app.route(
          "v1/reviews/local-drafts/add",
          JSON.stringify({
            profileId: "acme",
            reviewId: workbench.review.id,
            sessionId: workbench.session.id,
            runId,
            findingId,
          }),
        );
        expect(added.status).toBe(200);
      }
      const reviews = new ReviewStore(app.paths);
      const reviewId = value(parseReviewId(workbench.review.id));
      const drafted = value(await reviews.load(profileId, reviewId));
      if (!isLocalReview(drafted)) throw new Error("expected a local Review");
      value(
        await reviews.save(
          markLocalDraftsApplied(drafted, {
            runId,
            findingIds: [appliedFix.id],
            appliedAt: now,
          }),
          drafted.updatedAt,
        ),
      );
      value(
        await insights.mutate({
          profileId,
          reviewId,
          type: "analysis",
          now,
          operation: (record) =>
            dismissInsightFinding(
              record,
              dismissedFix.id,
              "Accepted risk",
              now,
            ),
        }),
      );
      const client = await connect(app.socketPath);

      const current = await call(client, "get_insight", {
        reviewId: workbench.review.id,
        type: "analysis",
      });
      const projected = await loadRoute(app, workbench.review.id);
      await writeFile(join(app.repositoryPath, "probe.ts"), "const a = 5;\n");
      const moved = await openRoute(app, app.repositoryPath);
      const earlier = await call(client, "get_insight", {
        reviewId: workbench.review.id,
        type: "analysis",
      });
      await beginRun(insights, runTarget(moved), "analysis");
      const running = await call(client, "get_insight", {
        reviewId: workbench.review.id,
        type: "analysis",
      });

      const reading = v.parse(
        v.looseObject({
          result: v.looseObject({
            findings: v.array(
              v.looseObject({
                id: v.string(),
                dismissed: v.boolean(),
                drafted: v.boolean(),
                applied: v.boolean(),
              }),
            ),
          }),
        }),
        current.content,
      );
      expect(current.content).toMatchObject({
        reviewId: workbench.review.id,
        sessionId: workbench.session.id,
        headSha: workbench.session.key.headSha,
        patchHash: workbench.revision.patchHash,
        type: "analysis",
        status: "completed",
        result: { sessionId: workbench.session.id, type: "analysis" },
      });
      expect(current.content).not.toHaveProperty("result.outdated");
      expect(
        reading.result.findings.map(({ id, dismissed, drafted, applied }) => ({
          id,
          dismissed,
          drafted,
          applied,
        })),
      ).toEqual([
        {
          id: "finding-drafted",
          dismissed: false,
          drafted: true,
          applied: false,
        },
        {
          id: "finding-applied",
          dismissed: false,
          drafted: true,
          applied: true,
        },
        {
          id: "finding-dismissed",
          dismissed: true,
          drafted: false,
          applied: false,
        },
        {
          id: "finding-open",
          dismissed: false,
          drafted: false,
          applied: false,
        },
      ]);
      expect(reading.result.findings.map(({ id }) => id)).toEqual(
        projected.insights.analysis.retained?.value.findings.map(
          ({ id }) => id,
        ),
      );
      expect(running.content).toMatchObject({
        status: "running",
        result: { sessionId: workbench.session.id, outdated: true },
      });
      expect(earlier.content).toMatchObject({
        sessionId: moved.session.id,
        status: "completed",
        result: { sessionId: workbench.session.id, outdated: true },
      });
    });

    it("get_feedback returns the workbench's drafts in file and line order with the prompt the agent-prompt route renders", async () => {
      app = await startAppWithLinkedWorktree();
      const fixture = app;
      const workbench = await reviewWithNotes(fixture, 0);
      await addNote(fixture, workbench, 5);
      await addNote(fixture, workbench, 2);
      const client = await connect(fixture.socketPath);

      const feedback = await call(client, "get_feedback", {
        reviewId: workbench.review.id,
      });
      const projected = await loadRoute(fixture, workbench.review.id);
      const prompt = await fixture.route(
        "v1/reviews/local-drafts/agent-prompt",
        JSON.stringify({ profileId: "acme", reviewId: workbench.review.id }),
      );

      expect(feedback.content).toMatchObject({
        reviewId: workbench.review.id,
        sessionId: workbench.session.id,
        headSha: workbench.session.key.headSha,
        patchHash: workbench.revision.patchHash,
        localDrafts: [...projected.localDrafts].sort(
          (left, right) => left.line - right.line,
        ),
        markdown: v.parse(v.object({ markdown: v.string() }), prompt.body)
          .markdown,
      });
      expect(feedback.content).not.toHaveProperty("nextCursor");
      // Both notes were written on the Review's current session, which the workbench leaves unlabelled.
      expect(
        v
          .parse(
            v.object({
              localDrafts: v.array(v.looseObject({ state: v.string() })),
            }),
            feedback.content,
          )
          .localDrafts.map(({ state }) => state),
      ).toEqual(["current", "current"]);
    });
  },
);
