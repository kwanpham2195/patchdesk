import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";

import * as v from "valibot";
import { afterEach, describe, expect, it } from "vitest";

import { ProfileStore } from "../../src/adapters/storage/profile-store";
import {
  shortTemporaryDirectory,
  startAppWithLinkedWorktree,
  type McpAppFixture,
} from "../main/mcp-app-fixture";
import {
  addNote,
  call,
  loadRoute,
  pageSchema,
  reviewWithNotes,
} from "./mcp-read-tools-fixture";
import { closeMcpTestClients, connectLegacyClient } from "./mcp-test-clients";

let app: McpAppFixture | undefined;
const directories: Array<string> = [];

afterEach(async () => {
  await closeMcpTestClients();
  await app?.stop();
  app = undefined;
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("get_feedback paging", () => {
  it("returns exactly 25 drafts on one page with no cursor", async () => {
    app = await startAppWithLinkedWorktree();
    const fixture = app;
    const workbench = await reviewWithNotes(fixture, 25);
    const client = await connectLegacyClient(fixture.socketPath);

    const page = v.parse(
      pageSchema,
      (await call(client, "get_feedback", { reviewId: workbench.review.id }))
        .content,
    );

    expect(page.localDrafts).toHaveLength(25);
    expect(page.nextCursor).toBeUndefined();
  });

  it("splits 26 drafts into a page of 25 and a page with the 26th", async () => {
    app = await startAppWithLinkedWorktree();
    const fixture = app;
    const workbench = await reviewWithNotes(fixture, 26);
    const client = await connectLegacyClient(fixture.socketPath);

    const first = v.parse(
      pageSchema,
      (await call(client, "get_feedback", { reviewId: workbench.review.id }))
        .content,
    );
    const second = v.parse(
      pageSchema,
      (
        await call(client, "get_feedback", {
          reviewId: workbench.review.id,
          cursor: first.nextCursor,
        })
      ).content,
    );

    expect(first.localDrafts.map(({ line }) => line)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
    expect(second.localDrafts.map(({ line }) => line)).toEqual([26]);
    expect(second.nextCursor).toBeUndefined();
    expect(second.markdown).toContain("Note on line 26");
    expect(second.markdown).not.toContain("Note on line 25");
  });

  it("refuses a cursor issued before the drafts changed with stale_cursor", async () => {
    app = await startAppWithLinkedWorktree();
    const fixture = app;
    const workbench = await reviewWithNotes(fixture, 26);
    const client = await connectLegacyClient(fixture.socketPath);
    const first = v.parse(
      pageSchema,
      (await call(client, "get_feedback", { reviewId: workbench.review.id }))
        .content,
    );
    await addNote(fixture, workbench, 27);

    const stale = await call(client, "get_feedback", {
      reviewId: workbench.review.id,
      cursor: first.nextCursor,
    });

    expect(stale).toMatchObject({
      isError: true,
      content: { error: "stale_cursor" },
    });
  });
});

describe("MCP read tool refusals", () => {
  it("refuses a different intent with intent_exists and keeps the first", async () => {
    app = await startAppWithLinkedWorktree();
    const client = await connectLegacyClient(app.socketPath);
    const first = await call(client, "review_local", {
      cwd: app.repositoryPath,
      intent: "Ship the first goal.",
    });

    const second = await call(client, "review_local", {
      cwd: app.repositoryPath,
      intent: "Ship another goal.",
    });
    const reviewId = v.parse(
      v.object({ reviewId: v.string() }),
      first.content,
    ).reviewId;

    expect(second).toMatchObject({
      isError: true,
      content: { error: "intent_exists" },
    });
    expect((await loadRoute(app, reviewId)).changeIntent).toMatchObject({
      intent: { markdown: "Ship the first goal." },
    });
  });

  it("refuses a directory outside every profile checkout with checkout_not_found and lists it in diagnostics", async () => {
    app = await startAppWithLinkedWorktree();
    const outside = await shortTemporaryDirectory();
    directories.push(outside);
    execFileSync("git", ["init", "-q", outside]);
    const client = await connectLegacyClient(app.socketPath);

    const refused = await call(client, "review_local", { cwd: outside });

    expect(refused).toMatchObject({
      isError: true,
      content: { error: "checkout_not_found" },
    });
    await expect
      .poll(
        async () => (await app?.route("v1/diagnostics?profileId=acme"))?.body,
      )
      .toMatchObject({
        events: [{ category: "mcp", phase: "review_local checkout_not_found" }],
      });
  });

  it("refuses a Review of another profile with profile_changed naming the active one", async () => {
    app = await startAppWithLinkedWorktree({ profiles: "two" });
    const client = await connectLegacyClient(app.socketPath);
    const opened = await call(client, "review_local", {
      cwd: app.repositoryPath,
    });
    const reviewId = v.parse(
      v.object({ reviewId: v.string() }),
      opened.content,
    ).reviewId;
    await app.route("v1/profiles/select", JSON.stringify({ id: "other" }));

    const feedback = await call(client, "get_feedback", { reviewId });
    const insight = await call(client, "get_insight", {
      reviewId,
      type: "analysis",
    });

    for (const refused of [feedback, insight])
      expect(refused).toMatchObject({
        isError: true,
        content: {
          error: "profile_changed",
          message: expect.stringContaining("the active profile is Other"),
        },
      });
  });

  it("answers no_profile without detecting or saving a profile", async () => {
    app = await startAppWithLinkedWorktree({ profiles: "none" });
    const client = await connectLegacyClient(app.socketPath);

    const refused = await call(client, "list_repositories", {});

    expect(refused).toMatchObject({
      isError: true,
      content: { error: "no_profile" },
    });
    expect(await new ProfileStore(app.paths).list()).toEqual({
      _tag: "ok",
      value: [],
    });
  });
});
