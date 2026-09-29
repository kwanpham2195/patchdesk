import { execFileSync } from "node:child_process";
import {
  mkdir,
  readdir,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import * as v from "valibot";
import { afterEach, describe, expect, it } from "vitest";

import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import { parseReviewId } from "../../src/domain/ids";
import {
  shortTemporaryDirectory,
  startAppWithLinkedWorktree,
  type McpAppFixture,
} from "../main/mcp-app-fixture";
import {
  addNote,
  call,
  openRoute,
  pageSchema,
  reviewWithNotes,
  setIntentInApp,
} from "./mcp-read-tools-fixture";
import { profileId, value } from "../services/local-apply-fixture";
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

describe("review_local on the agent's side (the agent prepares, the maintainer moves)", () => {
  it("returns an existing Review on its current session after the working tree changed, and records no open", async () => {
    app = await startAppWithLinkedWorktree();
    await writeFile(join(app.repositoryPath, "tracked.txt"), "two\n");
    const shown = await openRoute(app, app.repositoryPath);
    const reviews = new ReviewStore(app.paths);
    const reviewId = value(parseReviewId(shown.review.id));
    const before = value(await reviews.load(profileId, reviewId));
    await writeFile(join(app.repositoryPath, "tracked.txt"), "three\n");
    const client = await connectLegacyClient(app.socketPath);

    const called = await call(client, "review_local", {
      cwd: app.repositoryPath,
    });
    const after = value(await reviews.load(profileId, reviewId));

    // No base: the shared Review the maintainer opened supplies it.
    expect(called.content).toMatchObject({
      reviewId: shown.review.id,
      sessionId: shown.session.id,
      baseRef: "refs/heads/main",
      baseInferred: false,
    });
    expect(called.content).not.toHaveProperty("changeIntent");
    expect(after.currentSessionId).toBe(before.currentSessionId);
    expect(before.lastOpenedAt).toBeDefined();
    expect(after.lastOpenedAt).toBe(before.lastOpenedAt);
  });

  it("creates a missing Review without recording an open", async () => {
    app = await startAppWithLinkedWorktree();
    const client = await connectLegacyClient(app.socketPath);

    const called = await call(client, "review_local", {
      cwd: app.repositoryPath,
      base: "main",
    });
    const reviewId = v.parse(
      v.object({ reviewId: v.string() }),
      called.content,
    ).reviewId;
    const stored = value(
      await new ReviewStore(app.paths).load(
        profileId,
        value(parseReviewId(reviewId)),
      ),
    );

    expect(stored.lastOpenedAt).toBeUndefined();
  });

  it.each([
    {
      name: "text the maintainer entered",
      set: { kind: "text", markdown: "Reject a negative total." },
      returned: {
        kind: "text",
        source: "maintainer",
        markdown: "Reject a negative total.",
      },
    },
    {
      name: "a spec file",
      set: { kind: "file", path: "docs/spec.md" },
      returned: { kind: "file", path: "docs/spec.md" },
    },
  ] as const)(
    "returns the Change intent the maintainer set as $name beside intent_exists (#601)",
    async ({ set, returned }) => {
      app = await startAppWithLinkedWorktree();
      await writeFile(join(app.repositoryPath, "tracked.txt"), "two\n");
      const shown = await openRoute(app, app.repositoryPath);
      await setIntentInApp(app, shown.review.id, set);
      const client = await connectLegacyClient(app.socketPath);

      const called = await call(client, "review_local", {
        cwd: app.repositoryPath,
        intent: "Ship another goal.",
      });

      expect(called).toMatchObject({
        isError: false,
        content: {
          reviewId: shown.review.id,
          intentRecorded: false,
          intentRefused: "intent_exists",
        },
      });
      expect(called.content).toHaveProperty("changeIntent", returned);
    },
  );
});

describe("MCP read tool refusals", () => {
  it("refuses an intent holding a credential before opening anything", async () => {
    app = await startAppWithLinkedWorktree();
    const client = await connectLegacyClient(app.socketPath);

    const refused = await call(client, "review_local", {
      cwd: app.repositoryPath,
      intent: `Call with ghp_${"a".repeat(36)}.`,
    });

    expect(refused).toMatchObject({
      isError: true,
      content: { error: "change_intent_sensitive" },
    });
    await expect(
      readdir(app.paths.profileWorkbenchesDirectory(profileId)),
    ).rejects.toThrow();
  });

  it("refuses a working tree over the untracked size limit with untracked_too_large naming the folder, opening nothing", async () => {
    app = await startAppWithLinkedWorktree();
    const build = join(app.repositoryPath, "build");
    await mkdir(build);
    // Sparse, so the 101 MiB the limit reads costs no disk or time.
    await writeFile(join(build, "bundle.bin"), "");
    await truncate(join(build, "bundle.bin"), 101 * 1024 * 1024);
    const client = await connectLegacyClient(app.socketPath);

    const refused = await call(client, "review_local", {
      cwd: app.repositoryPath,
      base: "main",
    });

    expect(refused).toMatchObject({
      isError: true,
      content: {
        error: "untracked_too_large",
        message: expect.stringMatching(
          /more than 100 MiB of untracked files.* are build\/\. Add them to \.gitignore/,
        ),
      },
    });
    await expect(
      readdir(app.paths.profileWorkbenchesDirectory(profileId)),
    ).rejects.toThrow();
  });

  it("refuses a patch over the output cap with patch_too_large naming the file, opening nothing", async () => {
    app = await startAppWithLinkedWorktree();
    await writeFile(
      join(app.repositoryPath, "bundle.js"),
      "export const line = 0;\n".repeat(140_000),
    );
    const client = await connectLegacyClient(app.socketPath);

    const refused = await call(client, "review_local", {
      cwd: app.repositoryPath,
      base: "main",
    });

    expect(refused).toMatchObject({
      isError: true,
      content: {
        error: "patch_too_large",
        message: expect.stringContaining("most changes are bundle.js."),
      },
    });
    await expect(
      readdir(app.paths.profileWorkbenchesDirectory(profileId)),
    ).rejects.toThrow();
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

  it("refuses a cwd in a repository moved away from its configured path with checkout_missing naming that path (#488)", async () => {
    app = await startAppWithLinkedWorktree();
    execFileSync("git", [
      "-C",
      app.repositoryPath,
      "remote",
      "add",
      "origin",
      "git@github.com:octo-org/patchdesk.git",
    ]);
    const moved = `${app.repositoryPath}-moved`;
    await rename(app.repositoryPath, moved);
    const client = await connectLegacyClient(app.socketPath);

    const refused = await call(client, "review_local", { cwd: moved });

    expect(refused).toMatchObject({
      isError: true,
      content: {
        error: "checkout_missing",
        message: expect.stringContaining(
          `checkout at ${app.repositoryPath} no longer exists`,
        ),
      },
    });
  });

  it("refuses a Review of another profile with profile_changed naming the active one", async () => {
    app = await startAppWithLinkedWorktree({ profiles: "two" });
    const client = await connectLegacyClient(app.socketPath);
    const opened = await call(client, "review_local", {
      cwd: app.repositoryPath,
      base: "main",
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
