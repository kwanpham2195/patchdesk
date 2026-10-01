import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import { err } from "../../src/domain/result";
import { registerReviewWriteRoutes } from "../../src/main/routes/review-write-routes";
import { GitHubRefusedMetadataWrite } from "../../src/services/pull-request-metadata-write";

const reviewId = "acme__octo-org__patchdesk__pr-42__review-abcdef123456";
const common = { profileId: "acme", reviewId };

/** A refused metadata write answers 409 with its cause, so the renderer can say why (issue #755). */
function post(path: string, body: RawJsonValue) {
  const app = new Hono();
  const refuse = async () => err(new GitHubRefusedMetadataWrite("not_found"));
  const container = {
    labelWrites: { execute: refuse },
    assigneeWrites: { execute: refuse },
    reviewerWrites: { execute: refuse },
    draftStateWrites: { execute: refuse },
    baseBranchWrites: { execute: refuse },
    inlineConversations: {},
    logs: { write: () => undefined },
  };
  // SAFETY: these routes reach only the scripted write services.
  registerReviewWriteRoutes(app, container as never);
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const person = [{ id: "U_1", login: "octocat" }];

describe("a refused metadata write over the local API", () => {
  it.each([
    [
      "labels",
      "/v1/reviews/labels/command",
      { _tag: "AddLabels", labels: [{ id: "LA_1", name: "bug" }] },
    ],
    [
      "labels",
      "/v1/reviews/labels/command",
      { _tag: "RemoveLabels", labels: [{ id: "LA_1", name: "bug" }] },
    ],
    [
      "assignees",
      "/v1/reviews/assignees/command",
      { _tag: "AddAssignees", assignees: person },
    ],
    [
      "assignees",
      "/v1/reviews/assignees/command",
      { _tag: "RemoveAssignees", assignees: person },
    ],
    [
      "reviewers",
      "/v1/reviews/reviewers/command",
      { _tag: "RequestReviewers", reviewers: person },
    ],
    [
      "reviewers",
      "/v1/reviews/reviewers/command",
      { _tag: "RemoveReviewers", reviewers: person },
    ],
    [
      "draft state",
      "/v1/reviews/draft-state/command",
      { _tag: "SetDraftState", draft: true },
    ],
    [
      "base branch",
      "/v1/reviews/base-branch/command",
      { _tag: "SetBaseBranch", branch: "release/1.2" },
    ],
  ] as const)(
    "answers a refused %s write with 409 and the refusal cause",
    async (_name, path, command) => {
      const response = await post(path, { ...common, command });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "github_refused",
        cause: "not_found",
      });
    },
  );
});
