import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as v from "valibot";
import { afterEach, describe, expect, it } from "vitest";

import { ReviewStore } from "../../src/adapters/storage/review-store";
import { parseReviewId } from "../../src/domain/ids";
import {
  startAppWithLinkedWorktree,
  type McpAppFixture,
} from "../main/mcp-app-fixture";
import { profileId, value } from "../services/local-apply-fixture";
import { closeMcpTestClients, connectLegacyClient } from "./mcp-test-clients";
import { addNote, call, reviewWithNotes } from "./mcp-read-tools-fixture";

let app: McpAppFixture | undefined;

afterEach(async () => {
  await closeMcpTestClients();
  await app?.stop();
  app = undefined;
});

/** The content of a tool call that was not refused, parsed with `schema`. */
function answered<Schema extends v.GenericSchema>(
  schema: Schema,
  result: { readonly isError: boolean; readonly content: unknown },
): v.InferOutput<Schema> {
  if (result.isError) throw new Error("the tool call was refused");
  return v.parse(schema, result.content);
}

describe("get_review_status", () => {
  it("answers what get_feedback, get_insight, and refresh_review read, leaves the Review unopened, and drops preparedSessionId after the maintainer's Refresh", async () => {
    app = await startAppWithLinkedWorktree();
    const fixture = app;
    const workbench = await reviewWithNotes(fixture, 1);
    const reviewId = workbench.review.id;
    const client = await connectLegacyClient(fixture.socketPath);
    answered(
      v.looseObject({ status: v.literal("awaiting_approval") }),
      await call(client, "run_insight", {
        reviewId,
        sessionId: workbench.session.id,
        type: "brief",
      }),
    );
    await writeFile(join(fixture.repositoryPath, "long.txt"), "edited\n");
    const refreshed = answered(
      v.looseObject({ preparedSessionId: v.string() }),
      await call(client, "refresh_review", { reviewId }),
    );
    const feedback = answered(
      v.looseObject({
        reviewId: v.string(),
        sessionId: v.string(),
        headSha: v.string(),
        baseSha: v.string(),
        patchHash: v.string(),
      }),
      await call(client, "get_feedback", { reviewId }),
    );
    const insight = async (type: string) => {
      const { status, requestId } = answered(
        v.looseObject({
          status: v.string(),
          requestId: v.optional(v.string()),
        }),
        await call(client, "get_insight", { reviewId, type }),
      );
      return requestId === undefined ? { status } : { status, requestId };
    };
    const insights = {
      analysis: await insight("analysis"),
      walkthrough: await insight("walkthrough"),
      brief: await insight("brief"),
    };
    const reviews = new ReviewStore(fixture.paths);
    const storedId = value(parseReviewId(reviewId));
    const before = value(await reviews.load(profileId, storedId));

    const waiting = await call(client, "get_review_status", { reviewId });
    const after = value(await reviews.load(profileId, storedId));
    const moved = await fixture.route(
      "v1/reviews/local-refresh",
      JSON.stringify({ profileId: "acme", reviewId }),
    );
    const afterRefresh = await call(client, "get_review_status", {
      reviewId,
    });

    expect(waiting).toEqual({
      isError: false,
      content: {
        reviewId: feedback.reviewId,
        sessionId: feedback.sessionId,
        headSha: feedback.headSha,
        baseSha: feedback.baseSha,
        patchHash: feedback.patchHash,
        preparedSessionId: refreshed.preparedSessionId,
        insights,
        localDraftCounts: {
          finding: {
            current: 0,
            unchanged: 0,
            changed: 0,
            needs_attention: 0,
            applied: 0,
          },
          note: {
            current: 1,
            unchanged: 0,
            changed: 0,
            needs_attention: 0,
            applied: 0,
          },
        },
        appliedFindings: [],
        explanationCount: 0,
      },
    });
    expect(waiting.content).toHaveProperty(
      "insights.brief.status",
      "awaiting_approval",
    );
    expect(after.lastOpenedAt).toBe(before.lastOpenedAt);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(moved.status).toBe(200);
    expect(afterRefresh.isError).toBe(false);
    expect(afterRefresh.content).toMatchObject({
      sessionId: refreshed.preparedSessionId,
    });
    expect(afterRefresh.content).not.toHaveProperty("preparedSessionId");
  });

  it("returns the maintainer's Ready for agent with get_feedback, and changedSinceHandoff once a note is added after it (#603)", async () => {
    app = await startAppWithLinkedWorktree();
    const fixture = app;
    const workbench = await reviewWithNotes(fixture, 2);
    const reviewId = workbench.review.id;
    const client = await connectLegacyClient(fixture.socketPath);
    const handoffSchema = v.looseObject({
      handoff: v.strictObject({ at: v.string(), verdict: v.string() }),
      changedSinceHandoff: v.boolean(),
    });

    const ready = await fixture.route(
      "v1/reviews/local-drafts/handoff",
      JSON.stringify({
        profileId: "acme",
        reviewId,
        sessionId: workbench.session.id,
        verdict: "changes_requested",
      }),
    );
    const handedOff = answered(
      handoffSchema,
      await call(client, "get_feedback", { reviewId }),
    );
    await addNote(fixture, workbench, 3);
    const feedback = answered(
      handoffSchema,
      await call(client, "get_feedback", { reviewId }),
    );
    const status = answered(
      handoffSchema,
      await call(client, "get_review_status", { reviewId }),
    );

    expect(ready.status).toBe(200);
    expect(handedOff).toMatchObject({
      handoff: { verdict: "changes_requested" },
      changedSinceHandoff: false,
    });
    expect(Number.isNaN(Date.parse(handedOff.handoff.at))).toBe(false);
    expect(feedback).toMatchObject({
      handoff: handedOff.handoff,
      changedSinceHandoff: true,
    });
    expect(status).toMatchObject({
      handoff: handedOff.handoff,
      changedSinceHandoff: true,
    });
  });
});
