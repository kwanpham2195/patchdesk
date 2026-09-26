import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { err } from "../../src/domain/result";
import { registerInsightRoutes } from "../../src/main/routes/insight-routes";
import { registerLocalReviewRoutes } from "../../src/main/routes/local-review-routes";
import { registerReviewLifecycleRoutes } from "../../src/main/routes/review-lifecycle-routes";
import type { InsightCoordinatorFailure } from "../../src/services/insight-run-coordinator";
import type { ChangeIntentFailure } from "../../src/services/local-change-intent-service";
import type { LocalDraftFailure } from "../../src/services/local-draft-service";
import type { LocalReviewRefreshFailure } from "../../src/services/local-review-opening";
import type { ReviewWorkbenchFailure } from "../../src/services/review-workbench-controller";

// Each service's reasons, and the HTTP status its route answered with before
// the reason tables moved beside the services (ADR 0052). Keyed by the
// service's own union, so a new reason fails the typecheck here.

const localReviewStatuses = {
  not_found: 404,
  repository_not_local: 404,
  checkout_not_found: 404,
  revision_not_found: 404,
  unmerged_index: 409,
  terminal: 409,
  branch_mismatch: 409,
  in_progress: 409,
  not_applicable: 409,
  storage: 503,
} satisfies Record<LocalReviewRefreshFailure["reason"], number>;

const changeIntentStatuses = {
  change_intent_sensitive: 400,
  not_found: 404,
  in_progress: 409,
  terminal: 409,
  not_applicable: 409,
  storage: 503,
} satisfies Record<ChangeIntentFailure["reason"], number>;

const localDraftStatuses = {
  invalid_input: 400,
  not_found: 404,
  in_progress: 409,
  terminal: 409,
  not_applicable: 409,
  storage: 503,
} satisfies Record<LocalDraftFailure["reason"], number>;

const insightStatuses = {
  invalid_request: 400,
  model_unavailable: 400,
  ownership_mismatch: 403,
  not_found: 404,
  terminal_review: 409,
  already_running: 409,
  not_active: 409,
  stale_request: 409,
  not_available: 409,
  change_intent_file_missing: 409,
  change_intent_file_too_large: 409,
  change_intent_file_not_text: 409,
  change_intent_file_sensitive: 409,
  catalog_unavailable: 503,
  storage_unavailable: 503,
} satisfies Record<InsightCoordinatorFailure, number>;

const workbenchStatuses = {
  invalid_input: 400,
  github_auth: 401,
  not_found: 404,
  head_changed: 409,
  terminal: 409,
  revision_conflict: 409,
  not_fresh: 409,
  branch_mismatch: 409,
  github_read: 503,
  storage: 503,
} satisfies Record<
  ReviewWorkbenchFailure["reason"] | "branch_mismatch",
  number
>;

const identity = {
  profileId: "acme",
  reviewId: "github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
};

type RequestBody = Readonly<
  Record<string, string | Readonly<Record<string, string>>>
>;

function post(app: Hono, path: string, body: RequestBody): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function refusing(reason: string) {
  return async () => err({ reason });
}

describe("service refusal statuses (ADR 0052 reason tables)", () => {
  it.each(Object.entries(localReviewStatuses))(
    "local Review %s answers %i",
    async (reason, status) => {
      const app = new Hono();
      // SAFETY: the route under test reaches only the supplied service seam.
      registerLocalReviewRoutes(app, {
        localReviewOpening: { refresh: refusing(reason) },
      } as never);

      const answered = await post(app, "/v1/reviews/local-refresh", identity);

      expect(answered.status).toBe(status);
      expect(await answered.json()).toMatchObject({ error: reason });
    },
  );

  it.each(Object.entries(changeIntentStatuses))(
    "Change intent %s answers %i",
    async (reason, status) => {
      const app = new Hono();
      // SAFETY: the route under test reaches only the supplied service seam.
      registerLocalReviewRoutes(app, {
        localChangeIntent: { set: refusing(reason) },
      } as never);

      const answered = await post(app, "/v1/reviews/local-intent", {
        ...identity,
        intent: { kind: "text", markdown: "Ship the change intent" },
      });

      expect(answered.status).toBe(status);
      expect(await answered.json()).toEqual({ error: reason });
    },
  );

  it.each(Object.entries(localDraftStatuses))(
    "Local drafts %s answers %i",
    async (reason, status) => {
      const app = new Hono();
      // SAFETY: the route under test reaches only the supplied service seam.
      registerLocalReviewRoutes(app, {
        localDrafts: { agentPrompt: refusing(reason) },
      } as never);

      const answered = await post(
        app,
        "/v1/reviews/local-drafts/agent-prompt",
        identity,
      );

      expect(answered.status).toBe(status);
      expect(await answered.json()).toEqual({ error: reason });
    },
  );

  it.each(Object.entries(insightStatuses))(
    "Insight %s answers %i",
    async (reason, status) => {
      const app = new Hono();
      // SAFETY: the route under test reaches only the supplied service seam.
      registerInsightRoutes(app, {
        configuration: {},
        insights: { start: async () => err(reason) },
      } as never);

      const answered = await post(app, "/v1/reviews/insights/analysis/run", {
        ...identity,
        type: "analysis",
        provider: "pi",
        model: "gpt-6-luna",
        reasoning: "medium",
        language: "en",
      });

      expect(answered.status).toBe(status);
      expect(await answered.json()).toEqual({ error: reason });
    },
  );

  it.each(Object.entries(workbenchStatuses))(
    "workbench load %s answers %i",
    async (reason, status) => {
      const app = new Hono();
      // SAFETY: the route under test reaches only the supplied service seam.
      registerReviewLifecycleRoutes(app, {
        reviewWorkbench: { load: refusing(reason) },
      } as never);

      const answered = await post(app, "/v1/reviews/load", identity);

      expect(answered.status).toBe(status);
      expect(await answered.json()).toMatchObject({ error: reason });
    },
  );

  it("names the checkout's branch on a working-tree branch refusal", async () => {
    const app = new Hono();
    // SAFETY: the route under test reaches only the supplied service seam.
    registerLocalReviewRoutes(app, {
      localReviewOpening: {
        refresh: async () =>
          err({ reason: "branch_mismatch", currentBranch: "feat/467" }),
      },
    } as never);

    const answered = await post(app, "/v1/reviews/local-refresh", identity);

    expect(answered.status).toBe(409);
    expect(await answered.json()).toEqual({
      error: "branch_mismatch",
      currentBranch: "feat/467",
    });
  });
});
