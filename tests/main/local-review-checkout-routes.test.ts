import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { err, ok } from "../../src/domain/result";
import { registerLocalReviewRoutes } from "../../src/main/routes/local-review-routes";
import type { LocalPatchViewService } from "../../src/services/local-patch-view-service";
import type { LocalReviewOpening } from "../../src/services/local-review-opening";

type OpenInput = Parameters<LocalReviewOpening["open"]>[0];
type PatchViewInput = Parameters<LocalPatchViewService["load"]>[0];
type Opening = Pick<
  LocalReviewOpening,
  "open" | "listCheckouts" | "listBranches"
>;

const repository = {
  profileId: "acme",
  host: "github.com",
  owner: "octo-org",
  repo: "patchdesk",
};

function routeFixture(localReviewOpening: Partial<Opening> = {}) {
  const app = new Hono();
  const opens: OpenInput[] = [];
  const patchViewLoads: PatchViewInput[] = [];
  const container = {
    localPatchViews: {
      load: async (input: PatchViewInput) => {
        patchViewLoads.push(input);
        return err({ reason: "stale_head" as const });
      },
    },
    localReviewOpening: {
      open: async (input: OpenInput) => {
        opens.push(input);
        return err({ reason: "checkout_not_found" as const });
      },
      ...localReviewOpening,
    },
  };
  // SAFETY: the routes under test reach only the explicitly supplied service seam.
  registerLocalReviewRoutes(app, container as never);
  return {
    open: (source: {
      readonly kind: "local_branch";
      readonly baseBranch: string;
      readonly checkout: string;
    }) =>
      app.request("/v1/reviews/open-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...repository, source }),
      }),
    list: (query: Record<string, string>) =>
      app.request(
        `/v1/reviews/local-checkouts?${new URLSearchParams(query).toString()}`,
      ),
    branches: (query: Record<string, string>) =>
      app.request(
        `/v1/reviews/local-branches?${new URLSearchParams(query).toString()}`,
      ),
    patchView: (body: Record<string, string>) =>
      app.request("/v1/reviews/local-patch-view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    opens,
    patchViewLoads,
  };
}

describe("local Review checkout routes (#489)", () => {
  it("forwards an absolute checkout and answers a refused one with 404 checkout_not_found", async () => {
    const fixture = routeFixture();

    const opened = await fixture.open({
      kind: "local_branch",
      baseBranch: "main",
      checkout: "/work/linked",
    });

    expect(opened.status).toBe(404);
    expect(await opened.json()).toEqual({ error: "checkout_not_found" });
    expect(fixture.opens.map((input) => input.request)).toEqual([
      { kind: "local_branch", baseBranch: "main", checkout: "/work/linked" },
    ]);
  });

  it("refuses a relative checkout before opening anything", async () => {
    const fixture = routeFixture();

    const opened = await fixture.open({
      kind: "local_branch",
      baseBranch: "main",
      checkout: "linked",
    });

    expect(opened.status).toBe(400);
    expect(fixture.opens).toEqual([]);
  });

  it("lists each checkout with its folder name, head, and whether it is the configured one", async () => {
    const fixture = routeFixture({
      listCheckouts: async () =>
        ok([
          {
            path: "/work/patchdesk",
            head: { kind: "branch", branch: "main" },
            configured: true,
          },
          {
            path: "/work/linked",
            head: { kind: "detached" },
            configured: false,
          },
        ] as never),
    });

    const listed = await fixture.list(repository);

    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([
      {
        path: "/work/patchdesk",
        name: "patchdesk",
        head: { kind: "branch", branch: "main" },
        configured: true,
      },
      {
        path: "/work/linked",
        name: "linked",
        head: { kind: "detached" },
        configured: false,
      },
    ]);
  });

  it("refuses a listing without a repository and maps a repository with no checkout to 404", async () => {
    const fixture = routeFixture({
      listCheckouts: async () => err({ reason: "repository_not_local" }),
    });
    const { repo: _repo, ...withoutRepo } = repository;
    void _repo;

    expect((await fixture.list(withoutRepo)).status).toBe(400);
    expect((await fixture.list(repository)).status).toBe(404);
  });

  it("answers the branch listing of the named checkout with the inferred base", async () => {
    const asked: Array<string | undefined> = [];
    const fixture = routeFixture({
      listBranches: async (_profileId, _repository, checkout) => {
        asked.push(checkout);
        return ok({
          head: { kind: "branch", branch: "feature" },
          branches: ["main", "develop"],
          defaultBranch: "main",
          inferred: { baseBranch: "main", commitsBack: 3 },
        } as never);
      },
    });

    const listed = await fixture.branches({
      ...repository,
      checkout: "/work/linked",
    });
    const relative = await fixture.branches({
      ...repository,
      checkout: "linked",
    });

    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      head: { kind: "branch", branch: "feature" },
      branches: ["main", "develop"],
      defaultBranch: "main",
      inferred: { baseBranch: "main", commitsBack: 3 },
    });
    expect(relative.status).toBe(400);
    expect(asked).toEqual(["/work/linked"]);
  });

  it("forwards the named patch view, answers a moved-past session 409, and refuses an unknown view (#556)", async () => {
    const fixture = routeFixture();
    const key = {
      profileId: "acme",
      reviewId: "acme__octo-org__patchdesk__pr-42__review-abcdef123456",
      sessionId:
        "github.com__octo-org__patchdesk__pr-42__sha-11111111__base-bbbbbbbb__0123456789ab",
    };

    const stale = await fixture.patchView({ ...key, view: "uncommitted" });
    const unknown = await fixture.patchView({ ...key, view: "staged" });

    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "stale_head" });
    expect(unknown.status).toBe(400);
    expect(fixture.patchViewLoads).toEqual([{ ...key, view: "uncommitted" }]);
  });
});
