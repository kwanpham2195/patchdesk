import { describe, expect, it } from "vitest";

import {
  addThreadReplyMutation,
  deleteThreadCommentMutation,
  reviewThreadStateMutation,
  updateThreadCommentMutation,
} from "../../src/adapters/github/github-graphql-queries";
import { parseGitHubThreadId, parseGitSha } from "../../src/domain/ids";
import { profile, useFixtureServer } from "./github-http-fixture-server";
import {
  expectSameMutationAsGh,
  expectSameRequestAsGh,
  mustParse,
  pr,
  writeAdapter,
} from "./github-write-shape";

/**
 * The conversation write family over HTTP: a new inline thread, a reply,
 * resolve and unresolve, and the edit and delete of one comment (issue #276,
 * step T3). Resolve and unresolve, like edit and delete, pick the GraphQL
 * field rather than a variable, so each is its own document and its own label.
 */

const server = useFixtureServer();
const headSha = mustParse(parseGitSha("b".repeat(40)));
const threadId = mustParse(parseGitHubThreadId("PRRT_kwDOabc123"));
const commentNodeId = "PRRC_kwDOabc456";
const commentRestId = "2412345678";

describe("inline thread creation over HTTP", () => {
  it("posts the body, the head sha, and the anchor coordinates gh sent", async () => {
    server.respondWith((_request, response) => {
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: commentRestId,
          node_id: commentNodeId,
          pull_request_review_id: 7,
        }),
      );
    });

    const created = await writeAdapter(server).createInlineComment({
      profile,
      pr,
      headSha,
      coordinates: {
        path: "src/a.ts",
        line: 12,
        side: "RIGHT",
        start_line: 9,
        start_side: "RIGHT",
      },
      body: "note",
    });

    expect(created._tag).toBe("ok");
    expectSameRequestAsGh(server.requests()[0], {
      kind: "rest",
      host: "github.com",
      method: "POST",
      path: "repos/centraldigital/patchdesk/pulls/42/comments",
      jsonBody: JSON.stringify({
        body: "note",
        commit_id: headSha,
        path: "src/a.ts",
        line: 12,
        side: "RIGHT",
        start_line: 9,
        start_side: "RIGHT",
      }),
    });
  });

  it("replies to a thread with the id typed and the body a String", async () => {
    await writeAdapter(server).createThreadReply({
      profile,
      threadId,
      body: "reply",
    });

    // gh sent the id through `-F` and the body through `-f`, so a reply whose
    // text is all digits still reaches GitHub as a String.
    expectSameMutationAsGh(server.requests()[0], {
      query: addThreadReplyMutation,
      variables: { threadId, body: "reply" },
    });
  });

  it("keeps an all-digit reply body a String, as gh's -f did", async () => {
    await writeAdapter(server).createThreadReply({
      profile,
      threadId,
      body: "2026",
    });

    expectSameMutationAsGh(server.requests()[0], {
      query: addThreadReplyMutation,
      variables: { threadId, body: "2026" },
    });
  });
});

describe("thread state writes over HTTP", () => {
  const states = [
    { state: "resolved", field: "resolveReviewThread" },
    { state: "open", field: "unresolveReviewThread" },
  ] as const;

  it.each(states)(
    "sends the $field mutation for state $state",
    async ({ state, field }) => {
      await writeAdapter(server).setReviewThreadState({
        profile,
        threadId,
        state,
      });

      const query = reviewThreadStateMutation(state);
      expect(query).toContain(field);
      expectSameMutationAsGh(server.requests()[0], {
        query,
        variables: { threadId },
      });
    },
  );
});

describe("comment edit and delete over HTTP", () => {
  it("edits a thread comment by node id", async () => {
    await writeAdapter(server).updateThreadComment({
      profile,
      commentId: commentNodeId,
      body: "edited",
    });

    expectSameMutationAsGh(server.requests()[0], {
      query: updateThreadCommentMutation,
      variables: { commentId: commentNodeId, body: "edited" },
    });
  });

  it("deletes a thread comment by node id", async () => {
    await writeAdapter(server).deleteThreadComment({
      profile,
      commentId: commentNodeId,
    });

    expectSameMutationAsGh(server.requests()[0], {
      query: deleteThreadCommentMutation,
      variables: { commentId: commentNodeId },
    });
  });

  it("patches a published comment by its REST id", async () => {
    await writeAdapter(server).updateReviewComment({
      profile,
      pr,
      commentId: commentRestId,
      body: "edited",
    });

    expectSameRequestAsGh(server.requests()[0], {
      kind: "rest",
      host: "github.com",
      method: "PATCH",
      path: `repos/centraldigital/patchdesk/pulls/comments/${commentRestId}`,
      jsonBody: JSON.stringify({ body: "edited" }),
    });
  });

  /**
   * gh handed this endpoint's empty stdout to `runText`, and GitHub answers it
   * 204 with no body at all, so the success the call site reads is an empty
   * string on both transports.
   */
  it("deletes a published comment and reads its empty 204 as the receipt", async () => {
    server.respondWith((_request, response) => {
      response.writeHead(204);
      response.end();
    });

    const deleted = await writeAdapter(server).deleteReviewComment({
      profile,
      pr,
      commentId: commentRestId,
    });

    expect(deleted).toEqual({ _tag: "ok", value: undefined });
    expectSameRequestAsGh(server.requests()[0], {
      kind: "rest",
      host: "github.com",
      method: "DELETE",
      path: `repos/centraldigital/patchdesk/pulls/comments/${commentRestId}`,
    });
  });
});
