import * as v from "valibot";
import { afterEach, describe, expect, it } from "vitest";

import {
  startAppWithLinkedWorktree,
  type McpAppFixture,
} from "../main/mcp-app-fixture";
import { closeMcpTestClients, connectLegacyClient } from "./mcp-test-clients";
import {
  addNote,
  call,
  loadRoute,
  reviewWithNotes,
} from "./mcp-read-tools-fixture";

let app: McpAppFixture | undefined;

afterEach(async () => {
  await closeMcpTestClients();
  await app?.stop();
  app = undefined;
});

const explainedSchema = v.looseObject({
  explanationId: v.string(),
  explanationCount: v.number(),
  sessionId: v.string(),
});

const feedbackSchema = v.looseObject({
  localDrafts: v.array(
    v.looseObject({ draftId: v.string(), line: v.number(), text: v.string() }),
  ),
  markdown: v.string(),
});

describe("explain_lines", () => {
  it("shows the explanation on its lines in the workbench and its next detection, keeps it out of get_feedback, and returns the maintainer's reply note there", async () => {
    app = await startAppWithLinkedWorktree();
    const fixture = app;
    const workbench = await reviewWithNotes(fixture, 0);
    const reviewId = workbench.review.id;
    const client = await connectLegacyClient(fixture.socketPath);
    const explanation = {
      reviewId,
      sessionId: workbench.session.id,
      path: "long.txt",
      side: "new",
      startLine: 3,
      line: 4,
      text: "I guessed these two defaults; 30 lines matched the fixture.",
    };

    const explained = await call(client, "explain_lines", explanation);
    const repeated = await call(client, "explain_lines", explanation);
    const { explanationId } = v.parse(explainedSchema, explained.content);
    const loaded = await loadRoute(fixture, reviewId);
    const detected = await fixture.route(
      "v1/reviews/detect-updates",
      JSON.stringify({ profileId: "acme", reviewId }),
    );
    const before = v.parse(
      feedbackSchema,
      (await call(client, "get_feedback", { reviewId })).content,
    );
    const replyToExplanation = await call(client, "reply_to_note", {
      reviewId,
      draftId: explanationId,
      status: "addressed",
      text: "Explained.",
    });
    // Reply on the card opens the note composer on its lines; the maintainer's reply is an ordinary note.
    await addNote(fixture, workbench, 3);
    const after = v.parse(
      feedbackSchema,
      (await call(client, "get_feedback", { reviewId })).content,
    );
    const status = await call(client, "get_review_status", { reviewId });

    const shown = {
      explanationId,
      sessionId: workbench.session.id,
      path: "long.txt",
      side: "new",
      startLine: 3,
      line: 4,
      text: explanation.text,
    };
    expect(explained).toMatchObject({
      isError: false,
      content: { explanationCount: 1, sessionId: workbench.session.id },
    });
    expect(repeated.content).toMatchObject({
      explanationId,
      explanationCount: 1,
    });
    expect(loaded).toMatchObject({ agentExplanations: [shown] });
    expect(detected.body).toMatchObject({ agentExplanations: [shown] });
    expect(before.localDrafts).toEqual([]);
    expect(before.markdown).not.toContain(explanation.text);
    expect(replyToExplanation).toMatchObject({
      isError: true,
      content: { error: "draft_not_found" },
    });
    expect(after.localDrafts).toMatchObject([
      { line: 3, text: "Note on line 3" },
    ]);
    expect(after.markdown).toContain("Note on line 3");
    expect(after.markdown).not.toContain(explanation.text);
    expect(status.content).toMatchObject({
      explanationCount: 1,
      localDraftCounts: { note: { current: 1 } },
    });
  });

  it("refuses lines outside the Combined diff as lines_not_in_diff", async () => {
    app = await startAppWithLinkedWorktree();
    const workbench = await reviewWithNotes(app, 0);
    const client = await connectLegacyClient(app.socketPath);

    const refused = await call(client, "explain_lines", {
      reviewId: workbench.review.id,
      sessionId: workbench.session.id,
      path: "long.txt",
      side: "new",
      line: 31,
      text: "Past the end of the file.",
    });

    expect(refused).toMatchObject({
      isError: true,
      content: { error: "lines_not_in_diff" },
    });
  });
});
