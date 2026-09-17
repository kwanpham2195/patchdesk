import { describe, expect, it } from "vitest";

import { projectAnalysisReviewActions } from "../../src/domain/analysis-review-actions";
import type { GitHubConversationThread } from "../../src/domain/github-context";

const headSha = "a".repeat(40);
const patchHash = "b".repeat(64);
const runId = "insight-analysis-1";

function project(threads: ReadonlyArray<GitHubConversationThread>) {
  return projectAnalysisReviewActions({
    // SAFETY: only the fields the projection reads are supplied; the branded
    // ids and the full Insight and session shapes are outside this seam.
    analysis: {
      status: "current",
      artifactStatus: "verified",
      retained: {
        runId,
        sessionId: "session-1",
        headSha,
        value: { findings: [{ id: "f-thread" }, { id: "f-other" }] },
      },
    } as never,
    // SAFETY: as above, a session carrying only the fields the projection reads.
    session: {
      id: "session-1",
      key: { headSha },
      findingReviewReceipts: ["f-thread", "f-other"].map((findingId) => ({
        analysisRunId: runId,
        findingId,
        sessionId: "session-1",
        headSha,
        patchHash,
        threadId: `PRRT_${findingId}`,
        pendingReviewNodeId: "PRR_1",
        state: "published",
      })),
    } as never,
    freshness: "fresh",
    // SAFETY: a 64-character lowercase hex string is a valid ContentHash.
    patchHash: patchHash as never,
    pendingReview: undefined,
    threads,
  }).findings;
}

function thread(
  state: GitHubConversationThread["state"],
  viewerDidAuthor: boolean,
): GitHubConversationThread {
  return {
    // SAFETY: a fixture GitHub thread node id.
    id: "PRRT_f-thread" as never,
    state,
    comments: [
      {
        id: "comment-1",
        author: "someone",
        body: "",
        // SAFETY: a fixed ISO timestamp.
        createdAt: "2026-09-17T00:00:00.000Z" as never,
        viewerDidAuthor,
      },
    ],
  };
}

describe("projectAnalysisReviewActions needsReply", () => {
  it("marks a published Finding whose own thread waits on the viewer", () => {
    expect(project([thread("open", false)])).toEqual({
      "f-thread": { state: "published", needsReply: true },
      "f-other": { state: "published", needsReply: false },
    });
  });

  it("clears once the viewer answered or resolved the thread", () => {
    expect(project([thread("open", true)])["f-thread"]).toEqual({
      state: "published",
      needsReply: false,
    });
    expect(project([thread("resolved", false)])["f-thread"]).toEqual({
      state: "published",
      needsReply: false,
    });
  });
});
