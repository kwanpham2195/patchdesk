import * as v from "valibot";
import { afterEach, describe, expect, it } from "vitest";

import {
  startAppWithLinkedWorktree,
  type McpAppFixture,
} from "../main/mcp-app-fixture";
import { closeMcpTestClients, connectLegacyClient } from "./mcp-test-clients";
import { call, loadRoute, reviewWithNotes } from "./mcp-read-tools-fixture";

let app: McpAppFixture | undefined;

afterEach(async () => {
  await closeMcpTestClients();
  await app?.stop();
  app = undefined;
});

const feedbackSchema = v.looseObject({
  localDrafts: v.array(
    v.looseObject({
      draftId: v.string(),
      line: v.number(),
      resolved: v.boolean(),
      reply: v.optional(
        v.looseObject({ status: v.string(), text: v.string() }),
      ),
    }),
  ),
  markdown: v.string(),
});

describe("reply_to_note", () => {
  it("shows the agent's question in the workbench and its next detection, and get_feedback with open: true leaves the note out once the maintainer resolves it", async () => {
    app = await startAppWithLinkedWorktree();
    const fixture = app;
    const workbench = await reviewWithNotes(fixture, 2);
    const reviewId = workbench.review.id;
    const client = await connectLegacyClient(fixture.socketPath);
    const listed = v.parse(
      feedbackSchema,
      (await call(client, "get_feedback", { reviewId })).content,
    );
    const [first, second] = listed.localDrafts;
    if (first === undefined || second === undefined)
      throw new Error("two notes were not listed");

    const replied = await call(client, "reply_to_note", {
      reviewId,
      draftId: first.draftId,
      status: "question",
      text: "Is line 1 meant to stay?",
    });
    const loaded = await loadRoute(fixture, reviewId);
    const detected = await fixture.route(
      "v1/reviews/detect-updates",
      JSON.stringify({ profileId: "acme", reviewId }),
    );
    const resolved = await fixture.route(
      "v1/reviews/local-drafts/resolve",
      JSON.stringify({
        profileId: "acme",
        reviewId,
        sessionId: workbench.session.id,
        draft: { noteId: first.draftId },
        resolved: true,
      }),
    );
    const open = v.parse(
      feedbackSchema,
      (await call(client, "get_feedback", { reviewId, open: true })).content,
    );
    const all = v.parse(
      feedbackSchema,
      (await call(client, "get_feedback", { reviewId })).content,
    );

    const reply = {
      draft: { noteId: first.draftId },
      status: "question",
      text: "Is line 1 meant to stay?",
    };
    expect(replied).toMatchObject({
      isError: false,
      content: { draftId: first.draftId, status: "question", resolved: false },
    });
    expect(loaded).toMatchObject({
      localDrafts: [{ line: 1, text: "Note on line 1" }, { line: 2 }],
      localDraftReplies: [reply],
    });
    expect(detected.body).toMatchObject({ localDraftReplies: [reply] });
    expect(resolved.status).toBe(200);
    expect(open.localDrafts.map((entry) => entry.draftId)).toEqual([
      second.draftId,
    ]);
    expect(all.localDrafts).toMatchObject([
      {
        draftId: first.draftId,
        resolved: true,
        reply: { status: "question", text: "Is line 1 meant to stay?" },
      },
      { draftId: second.draftId, resolved: false },
    ]);
    expect(all.markdown).not.toContain("Note on line 1");
    expect(all.markdown).not.toContain("Is line 1 meant to stay?");
  });

  it("refuses a draftId the Review does not hold as draft_not_found", async () => {
    app = await startAppWithLinkedWorktree();
    const workbench = await reviewWithNotes(app, 1);
    const client = await connectLegacyClient(app.socketPath);

    const refused = await call(client, "reply_to_note", {
      reviewId: workbench.review.id,
      draftId: "note-missing",
      status: "skipped",
      text: "Not needed.",
    });

    expect(refused).toMatchObject({
      isError: true,
      content: { error: "draft_not_found" },
    });
  });
});
