import { describe, expect, it } from "vitest";

import {
  parseGitHubReviewNodeId,
  parseGitHubThreadId,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import { json, profile, useFixtureServer } from "./github-http-fixture-server";
import { mustParse, pr, writeAdapter } from "./github-write-shape";

/**
 * A mutation GitHub answers with HTTP 200, no `errors`, and a null root field
 * or a null node created or changed (issue #768). The comment was not made, so
 * each is a refusal with cause `unprocessable`; a non-null node with missing
 * fields stays a malformed success, and a query answered the same way is
 * untouched.
 */

const server = useFixtureServer();
const threadId = mustParse(parseGitHubThreadId("PRRT_kwDOabc123"));
const reviewId = mustParse(parseGitHubReviewNodeId("PRR_kwDOabc123"));
const unprocessable = {
  _tag: "err",
  error: expect.objectContaining({
    category: "refused",
    cause: "unprocessable",
  }),
};

const reply = () =>
  writeAdapter(server).createThreadReply({
    profile,
    threadId,
    body: "note",
  });

describe("a mutation answered with nothing", () => {
  it("refuses a reply whose comment is null", async () => {
    server.respondWith(
      json(200, {
        data: { addPullRequestReviewThreadReply: { comment: null } },
      }),
    );
    await expect(reply()).resolves.toEqual(unprocessable);
  });

  it("refuses a reply whose root field is null", async () => {
    server.respondWith(
      json(200, { data: { addPullRequestReviewThreadReply: null } }),
    );
    await expect(reply()).resolves.toEqual(unprocessable);
  });

  it("refuses a mutation whose data is null", async () => {
    server.respondWith(json(200, { data: null }));
    await expect(reply()).resolves.toEqual(unprocessable);
  });

  it("keeps a reply with a non-null comment missing its id unavailable", async () => {
    server.respondWith(
      json(200, { data: { addPullRequestReviewThreadReply: { comment: {} } } }),
    );
    await expect(reply()).resolves.toEqual({
      _tag: "err",
      error: expect.objectContaining({ category: "unavailable" }),
    });
  });

  it("refuses an edit whose comment is null", async () => {
    server.respondWith(
      json(200, {
        data: {
          updatePullRequestReviewComment: { pullRequestReviewComment: null },
        },
      }),
    );
    await expect(
      writeAdapter(server).updateThreadComment({
        profile,
        commentId: "PRRC_1",
        body: "edited",
      }),
    ).resolves.toEqual(unprocessable);
  });

  it.each([
    ["resolved", "resolveReviewThread"],
    ["open", "unresolveReviewThread"],
  ] as const)(
    "refuses a %s state change whose thread is null",
    async (state, field) => {
      server.respondWith(json(200, { data: { [field]: { thread: null } } }));
      await expect(
        writeAdapter(server).setReviewThreadState({ profile, threadId, state }),
      ).resolves.toEqual(unprocessable);
    },
  );

  it("refuses a pending add-thread whose thread is null", async () => {
    server.respondWith(
      json(200, { data: { addPullRequestReviewThread: { thread: null } } }),
    );
    await expect(
      writeAdapter(server).addPendingReviewThread({
        profile,
        pr,
        reviewId,
        anchor: {
          path: mustParse(parseRepoRelativePath("src/a.ts")),
          startLine: 1,
          line: 1,
          side: "new",
        },
        body: "note",
      }),
    ).resolves.toEqual(unprocessable);
  });

  it("refuses a metadata mutation whose root field is null", async () => {
    server.respondWith(json(200, { data: { addLabelsToLabelable: null } }));
    await expect(
      writeAdapter(server).addLabelsToLabelable({
        profile,
        labelableId: "PR_1",
        labelIds: ["L_1"],
      }),
    ).resolves.toEqual(unprocessable);
  });

  it("accepts a metadata mutation whose only field is a null clientMutationId", async () => {
    server.respondWith(
      json(200, { data: { addLabelsToLabelable: { clientMutationId: null } } }),
    );
    await expect(
      writeAdapter(server).addLabelsToLabelable({
        profile,
        labelableId: "PR_1",
        labelIds: ["L_1"],
      }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
  });
});

describe("a query answered with a null root", () => {
  it("stays a success", async () => {
    server.respondWith(json(200, { data: { repository: null } }));
    const result = await server.client().graphql(profile, {
      kind: "graphql",
      host: "github.com",
      document: "query Probe { repository { id } }",
      variables: [],
    });
    expect(result._tag).toBe("ok");
  });
});
