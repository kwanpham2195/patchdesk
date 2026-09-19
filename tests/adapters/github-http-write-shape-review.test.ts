import { describe, expect, it } from "vitest";

import type { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import { addPendingReviewThreadMutation } from "../../src/adapters/github/github-graphql-queries";
import type { GitHubRestRequest } from "../../src/adapters/github/github-request";
import {
  parseGitHubReviewNodeId,
  parseGitHubReviewRestId,
  parseGitSha,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import { profile, useFixtureServer } from "./github-http-fixture-server";
import {
  expectSameMutationAsGh,
  expectSameRequestAsGh,
  mustParse,
  pr,
  writeAdapter,
} from "./github-write-shape";

/**
 * The review write family over HTTP: creating a review, adding a pending
 * thread, submitting, discarding, dismissing, and merging (issue #276, step
 * T3). Each case drives the real `GitHubAdapter` method against the loopback
 * server and asserts what reached the wire against what the `gh api` argv and
 * stdin for the same call encode.
 *
 * The response bodies are deliberately minimal: what is under test is the
 * request, and every one of these writes is recorded before its receipt is
 * parsed.
 */

const server = useFixtureServer();
const headSha = mustParse(parseGitSha("b".repeat(40)));
const reviewRestId = mustParse(parseGitHubReviewRestId("9001"));
const reviewNodeId = mustParse(parseGitHubReviewNodeId("PRR_kwDOabc123"));

function adapter(): GitHubAdapter {
  return writeAdapter(server);
}

const reviewsPath = "repos/octo-org/patchdesk/pulls/42/reviews";

describe("creating a review over HTTP", () => {
  it("posts the summary and its comments as gh's --input did", async () => {
    await adapter().createPendingReview({
      profile,
      pr,
      headSha,
      summaryBody: "summary",
      comments: [
        { body: "note", path: "src/a.ts", line: 12, diffSide: "new" },
        {
          body: "range",
          path: "src/b.ts",
          line: 3,
          lineEnd: 7,
          diffSide: "old",
        },
      ],
    });

    const expected: GitHubRestRequest = {
      kind: "rest",
      host: "github.com",
      method: "POST",
      path: reviewsPath,
      jsonBody: JSON.stringify({
        commit_id: headSha,
        body: "summary",
        comments: [
          { path: "src/a.ts", line: 12, side: "RIGHT", body: "note" },
          {
            path: "src/b.ts",
            line: 7,
            side: "LEFT",
            body: "range",
            start_line: 3,
            start_side: "LEFT",
          },
        ],
      }),
    };
    expectSameRequestAsGh(server.requests()[0], expected);
  });

  it("posts a direct summary review with its event", async () => {
    await adapter().createDirectSummaryReview({
      profile,
      pr,
      headSha,
      event: "APPROVE",
      body: "looks good",
    });

    expectSameRequestAsGh(server.requests()[0], {
      kind: "rest",
      host: "github.com",
      method: "POST",
      path: reviewsPath,
      jsonBody: JSON.stringify({
        commit_id: headSha,
        event: "APPROVE",
        body: "looks good",
      }),
    });
  });

  it("posts a pending review opened on one anchor", async () => {
    await adapter().startPendingReviewWithThread({
      profile,
      pr,
      headSha,
      anchor: {
        path: mustParse(parseRepoRelativePath("src/a.ts")),
        startLine: 3,
        line: 7,
        side: "new",
      },
      body: "note",
    });

    expectSameRequestAsGh(server.requests()[0], {
      kind: "rest",
      host: "github.com",
      method: "POST",
      path: reviewsPath,
      jsonBody: JSON.stringify({
        commit_id: headSha,
        comments: [
          {
            path: "src/a.ts",
            line: 7,
            side: "RIGHT",
            body: "note",
            start_line: 3,
            start_side: "RIGHT",
          },
        ],
      }),
    });
  });
});

describe("pending review writes over HTTP", () => {
  it("appends a thread with the side baked into the document, as gh sent it", async () => {
    await adapter().addPendingReviewThread({
      profile,
      pr,
      reviewId: reviewNodeId,
      anchor: {
        path: mustParse(parseRepoRelativePath("src/a.ts")),
        startLine: 12,
        line: 12,
        side: "old",
      },
      body: "note",
    });

    // `side` is a GraphQL enum, which gh's `-F` could only send as a String,
    // so the document carries it and the variables do not.
    expectSameMutationAsGh(server.requests()[0], {
      query: addPendingReviewThreadMutation("LEFT"),
      variables: {
        reviewId: reviewNodeId,
        path: "src/a.ts",
        line: 12,
        body: "note",
      },
    });
  });

  it("posts the submit event to the review's own events path", async () => {
    await adapter().submitPendingReview({
      profile,
      pr,
      reviewId: reviewRestId,
      event: "COMMENT",
      summaryBody: "summary",
    });

    expectSameRequestAsGh(server.requests()[0], {
      kind: "rest",
      host: "github.com",
      method: "POST",
      path: `${reviewsPath}/9001/events`,
      jsonBody: JSON.stringify({ event: "COMMENT", body: "summary" }),
    });
  });

  /**
   * gh handed this endpoint's answer to `runText`, so any exit-0 output was
   * the receipt. GitHub answers it 200 with the deleted review as JSON, which
   * the client must hand over as the same success rather than parse.
   */
  it("discards a pending review and reads a JSON answer as its text receipt", async () => {
    server.respondWith((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"id":9001,"state":"PENDING"}');
    });

    const discarded = await adapter().discardPendingReview({
      profile,
      pr,
      reviewId: reviewRestId,
    });

    expect(discarded).toEqual({ _tag: "ok", value: undefined });
    expectSameRequestAsGh(server.requests()[0], {
      kind: "rest",
      host: "github.com",
      method: "DELETE",
      path: `${reviewsPath}/9001`,
    });
  });

  it("discards a pending review answered with an empty 204", async () => {
    server.respondWith((_request, response) => {
      response.writeHead(204);
      response.end();
    });

    await expect(
      adapter().discardPendingReview({ profile, pr, reviewId: reviewRestId }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
  });
});

describe("published review writes over HTTP", () => {
  it("dismisses a review with its message", async () => {
    await adapter().dismissReview({
      profile,
      pr,
      reviewId: reviewRestId,
      message: "stale",
    });

    expectSameRequestAsGh(server.requests()[0], {
      kind: "rest",
      host: "github.com",
      method: "PUT",
      path: `${reviewsPath}/9001/dismissals`,
      jsonBody: JSON.stringify({ message: "stale" }),
    });
  });

  it("merges with the head sha and the chosen method", async () => {
    server.respondWith((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"merged":true,"sha":"' + "c".repeat(40) + '"}');
    });

    const merged = await adapter().mergePullRequest({
      profile,
      pr,
      headSha,
      method: "squash",
    });

    expect(merged._tag).toBe("ok");
    expectSameRequestAsGh(server.requests()[0], {
      kind: "rest",
      host: "github.com",
      method: "PUT",
      path: "repos/octo-org/patchdesk/pulls/42/merge",
      jsonBody: JSON.stringify({
        sha: headSha,
        merge_method: "squash",
      }),
    });
  });
});
