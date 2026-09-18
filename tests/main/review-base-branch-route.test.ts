import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { parseIsoTimestamp } from "../../src/domain/ids";
import { err, ok, type Result } from "../../src/domain/result";
import { registerReviewWriteRoutes } from "../../src/main/routes/review-write-routes";
import type {
  BaseBranchListFailure,
  BaseBranchListOutcome,
} from "../../src/services/base-branch-service";

const parsedResumeAt = parseIsoTimestamp("2026-09-17T10:00:00.000Z");
if (parsedResumeAt._tag === "err") throw new Error("invalid fixture");
const resumeAt = parsedResumeAt.value;
const reviewId = "cfw__centraldigital__patchdesk__pr-42__review-abcdef123456";

function routeFixture(
  answer: Result<BaseBranchListOutcome, BaseBranchListFailure>,
) {
  const app = new Hono();
  const inputs: Array<{ readonly query?: string }> = [];
  const container = {
    baseBranchWrites: {
      list: async (input: { readonly query?: string }) => {
        inputs.push(input);
        return answer;
      },
    },
  };
  // SAFETY: the route under test reaches only the base-branch service seam.
  registerReviewWriteRoutes(app, container as never);
  return {
    inputs,
    get: (search: string) => app.request(`/v1/reviews/base-branch?${search}`),
  };
}

describe("GET /v1/reviews/base-branch", () => {
  it("forwards the search and answers the ready listing", async () => {
    const fixture = routeFixture(
      ok({
        _tag: "ready",
        current: "main",
        branches: ["release/1.2"],
        branchesTotalCount: 1,
        permission: "unknown",
      }),
    );
    const response = await fixture.get(
      `profileId=cfw&reviewId=${reviewId}&query=rel`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "ready",
      current: "main",
      branches: ["release/1.2"],
      branchesTotalCount: 1,
      permission: "unknown",
    });
    expect(fixture.inputs).toMatchObject([{ query: "rel" }]);
  });

  const failures = {
    github_auth: [{ _tag: "github_auth" }, { state: "github_auth" }],
    github_read: [{ _tag: "github_read" }, { state: "github_read" }],
    github_rate_limited: [
      {
        _tag: "github_rate_limited",
        resumeAt,
      },
      { state: "github_rate_limited", resumeAt: "2026-09-17T10:00:00.000Z" },
    ],
    github_forbidden: [
      { _tag: "github_forbidden", reason: "saml" },
      { state: "github_forbidden", forbiddenReason: "saml" },
    ],
  } satisfies Record<
    Exclude<BaseBranchListOutcome, { _tag: "ready" }>["_tag"],
    readonly [BaseBranchListOutcome, Readonly<Record<string, string>>]
  >;

  for (const [tag, [outcome, body]] of Object.entries(failures)) {
    it(`answers ${tag} as data`, async () => {
      const response = await routeFixture(ok(outcome)).get(
        `profileId=cfw&reviewId=${reviewId}`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(body);
    });
  }

  it("answers a missing Review with 404", async () => {
    const response = await routeFixture(err("not_found")).get(
      `profileId=cfw&reviewId=${reviewId}`,
    );
    expect(response.status).toBe(404);
  });

  it("rejects an unparseable Review id before reaching the service", async () => {
    const fixture = routeFixture(err("not_found"));
    const response = await fixture.get("profileId=cfw&reviewId=nope");
    expect(response.status).toBe(400);
    expect(fixture.inputs).toEqual([]);
  });
});
