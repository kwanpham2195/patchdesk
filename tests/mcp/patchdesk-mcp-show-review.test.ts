import { execFileSync } from "node:child_process";

import * as v from "valibot";
import { afterEach, describe, expect, it } from "vitest";

import { ProfileStore } from "../../src/adapters/storage/profile-store";
import type { ReviewWindow } from "../../src/main/desktop-review-window";
import {
  startAppWithLinkedWorktree,
  type McpAppFixture,
} from "../main/mcp-app-fixture";
import { call } from "./mcp-read-tools-fixture";
import { closeMcpTestClients, connectLegacyClient } from "./mcp-test-clients";

let app: McpAppFixture | undefined;

afterEach(async () => {
  await closeMcpTestClients();
  await app?.stop();
  app = undefined;
});

/** A window that switches to every Review it is handed and records each one. */
function recordingWindow(): ReviewWindow & { readonly shown: string[] } {
  const shown: string[] = [];
  return {
    shown,
    async show(reviewId) {
      shown.push(reviewId);
      return "shown";
    },
  };
}

async function openWithAgent(
  fixture: McpAppFixture,
  cwd: string,
): Promise<string> {
  const client = await connectLegacyClient(fixture.socketPath);
  const opened = await call(client, "review_local", { cwd, base: "main" });
  return v.parse(v.object({ reviewId: v.string() }), opened.content).reviewId;
}

describe("show_review", () => {
  it("hands a local Review the maintainer never opened to the window", async () => {
    const window = recordingWindow();
    app = await startAppWithLinkedWorktree({ reviewWindow: window });
    const reviewId = await openWithAgent(app, app.repositoryPath);
    const client = await connectLegacyClient(app.socketPath);

    const shown = await call(client, "show_review", { reviewId });

    expect(shown).toEqual({ isError: false, content: { status: "shown" } });
    expect(window.shown).toEqual([reviewId]);
  });

  it("shows a Review whose repository is no longer watched, and the renderer's open still loads it", async () => {
    const window = recordingWindow();
    app = await startAppWithLinkedWorktree({ reviewWindow: window });
    const reviewId = await openWithAgent(app, app.repositoryPath);
    const profiles = new ProfileStore(app.paths);
    const listed = await profiles.list();
    if (listed._tag === "err") throw new Error("profiles not listed");
    const [acme] = listed.value;
    if (acme === undefined) throw new Error("profile fixture missing");
    await profiles.save({
      ...acme,
      repos: acme.repos.filter(({ repo }) => repo !== "patchdesk"),
    });
    const client = await connectLegacyClient(app.socketPath);

    const shown = await call(client, "show_review", { reviewId });
    const loaded = await app.route(
      "v1/reviews/load",
      JSON.stringify({ profileId: "acme", reviewId, recordOpen: true }),
    );

    expect(shown.content).toEqual({ status: "shown" });
    expect(window.shown).toEqual([reviewId]);
    expect(loaded.status).toBe(200);
  });

  it("refuses an unknown reviewId not_found and one of another profile profile_changed, leaving the window alone", async () => {
    const window = recordingWindow();
    app = await startAppWithLinkedWorktree({
      profiles: "two",
      reviewWindow: window,
    });
    const reviewId = await openWithAgent(app, app.repositoryPath);
    await app.route("v1/profiles/select", JSON.stringify({ id: "other" }));
    const client = await connectLegacyClient(app.socketPath);

    const otherProfile = await call(client, "show_review", { reviewId });
    const unknown = await call(client, "show_review", {
      reviewId: reviewId.replace(/review-[a-f0-9]{12}$/, "review-000000000000"),
    });

    expect(otherProfile).toMatchObject({
      isError: true,
      content: {
        error: "profile_changed",
        message: expect.stringContaining("the active profile is Other"),
      },
    });
    expect(unknown).toMatchObject({
      isError: true,
      content: { error: "not_found" },
    });
    expect(window.shown).toEqual([]);
  });

  it("refuses a shared Review whose checkout switched branch, naming the branch, and leaves the window alone", async () => {
    const window = recordingWindow();
    app = await startAppWithLinkedWorktree({ reviewWindow: window });
    const reviewId = await openWithAgent(app, app.linkedPath);
    execFileSync("git", [
      "-C",
      app.linkedPath,
      "checkout",
      "-q",
      "-b",
      "other",
    ]);
    const client = await connectLegacyClient(app.socketPath);

    const refused = await call(client, "show_review", { reviewId });

    expect(refused).toMatchObject({
      isError: true,
      content: {
        error: "branch_mismatch",
        message: expect.stringContaining("on branch other"),
      },
    });
    expect(window.shown).toEqual([]);
  });
});
