import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { err, ok } from "../../src/domain/result";
import { registerLocalReviewRoutes } from "../../src/main/routes/local-review-routes";
import type { LocalReviewOpening } from "../../src/services/local-review-opening";

type OpenInput = Parameters<LocalReviewOpening["open"]>[0];
type Opening = Pick<LocalReviewOpening, "open" | "listCheckouts">;

const repository = {
  profileId: "acme",
  host: "github.com",
  owner: "octo-org",
  repo: "patchdesk",
};

function routeFixture(localReviewOpening: Partial<Opening> = {}) {
  const app = new Hono();
  const opens: OpenInput[] = [];
  const container = {
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
      readonly kind: "working_tree";
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
    opens,
  };
}

describe("local Review checkout routes (#489)", () => {
  it("forwards an absolute checkout and answers a refused one with 404 checkout_not_found", async () => {
    const fixture = routeFixture();

    const opened = await fixture.open({
      kind: "working_tree",
      checkout: "/work/linked",
    });

    expect(opened.status).toBe(404);
    expect(await opened.json()).toEqual({ error: "checkout_not_found" });
    expect(fixture.opens.map((input) => input.request)).toEqual([
      { kind: "working_tree", checkout: "/work/linked" },
    ]);
  });

  it("refuses a relative checkout before opening anything", async () => {
    const fixture = routeFixture();

    const opened = await fixture.open({
      kind: "working_tree",
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
});
