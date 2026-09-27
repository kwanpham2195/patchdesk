import { execFileSync } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as v from "valibot";
import { afterEach, describe, expect, it } from "vitest";

import {
  startAppWithLinkedWorktree,
  type McpAppFixture,
} from "../main/mcp-app-fixture";
import { profileId } from "../services/local-apply-fixture";
import {
  call,
  linkedBranchWithCommit,
  openInApp,
} from "./mcp-read-tools-fixture";
import { closeMcpTestClients, connectLegacyClient } from "./mcp-test-clients";

let app: McpAppFixture | undefined;

afterEach(async () => {
  await closeMcpTestClients();
  await app?.stop();
  app = undefined;
});

describe("review_local base (#555)", () => {
  it("opens the shared Review against the base the agent names", async () => {
    app = await startAppWithLinkedWorktree();
    await linkedBranchWithCommit(app);
    const client = await connectLegacyClient(app.socketPath);

    const opened = await call(client, "review_local", {
      cwd: app.linkedPath,
      base: "develop",
    });

    expect(opened).toMatchObject({
      isError: false,
      content: { baseBranch: "develop", baseInferred: false },
    });
  });

  it("reuses the shared Review the maintainer opened when the agent names no base", async () => {
    app = await startAppWithLinkedWorktree();
    await linkedBranchWithCommit(app);
    await openInApp(app, "develop");
    const client = await connectLegacyClient(app.socketPath);

    const opened = await call(client, "review_local", { cwd: app.linkedPath });
    const named = await call(client, "review_local", {
      cwd: app.linkedPath,
      base: "develop",
    });

    expect(opened).toMatchObject({
      isError: false,
      content: { baseBranch: "develop", baseInferred: false },
    });
    expect(opened.content).toMatchObject({
      reviewId: v.parse(v.object({ reviewId: v.string() }), named.content)
        .reviewId,
    });
  });

  it("infers the base on a branch with no open Review and says so", async () => {
    app = await startAppWithLinkedWorktree();
    await linkedBranchWithCommit(app);
    const client = await connectLegacyClient(app.socketPath);

    const opened = await call(client, "review_local", { cwd: app.linkedPath });

    // `develop` and `main` tie one commit back; the default branch wins.
    expect(opened).toMatchObject({
      isError: false,
      content: {
        baseBranch: "main",
        baseInferred: true,
        changedFiles: [expect.objectContaining({ path: "feature.txt" })],
      },
    });
  });

  it("names a deleted saved base and asks for an explicit base without creating a Review", async () => {
    app = await startAppWithLinkedWorktree();
    await linkedBranchWithCommit(app);
    execFileSync("git", ["branch", "topic"], { cwd: app.repositoryPath });
    const maintainer = await openInApp(app, "topic");
    const storedBefore = await readdir(
      app.paths.profileReviewsDirectory(profileId),
      { recursive: true },
    );
    execFileSync("git", ["branch", "-D", "topic"], {
      cwd: app.repositoryPath,
    });
    const client = await connectLegacyClient(app.socketPath);

    const refused = await call(client, "review_local", { cwd: app.linkedPath });

    expect(refused).toMatchObject({
      isError: true,
      content: {
        error: "revision_not_found",
        message: expect.stringMatching(/topic.*Pass base/),
      },
    });
    expect(refused.content).toMatchObject({
      message: expect.not.stringContaining("omit base"),
    });
    expect(
      await readdir(app.paths.profileReviewsDirectory(profileId), {
        recursive: true,
      }),
    ).toEqual(storedBefore);
    expect(
      await call(client, "list_local_reviews", { cwd: app.linkedPath }),
    ).toMatchObject({
      isError: false,
      content: { reviews: [{ reviewId: maintainer.review.id }] },
    });
  });

  it("refuses base_required when no other branch is behind HEAD, opening nothing", async () => {
    app = await startAppWithLinkedWorktree();
    await writeFile(join(app.repositoryPath, "tracked.txt"), "two\n");
    const client = await connectLegacyClient(app.socketPath);

    const refused = await call(client, "review_local", {
      cwd: app.repositoryPath,
    });

    expect(refused).toMatchObject({
      isError: true,
      content: {
        error: "base_required",
        message: expect.stringContaining("Pass base"),
      },
    });
    await expect(
      readdir(app.paths.profileWorkbenchesDirectory(profileId)),
    ).rejects.toThrow();
  });

  it("does not reuse another profile's shared Review of the branch", async () => {
    app = await startAppWithLinkedWorktree({ profiles: "two" });
    await linkedBranchWithCommit(app);
    await openInApp(app, "develop", "other");
    const client = await connectLegacyClient(app.socketPath);

    const opened = await call(client, "review_local", { cwd: app.linkedPath });

    expect(opened).toMatchObject({
      isError: false,
      content: { baseBranch: "main", baseInferred: true },
    });
  });

  it("refuses the removed working_tree source and a base beside a commit", async () => {
    app = await startAppWithLinkedWorktree();
    const client = await connectLegacyClient(app.socketPath);

    const workingTree = await call(client, "review_local", {
      cwd: app.repositoryPath,
      source: { kind: "working_tree" },
    });
    const commitWithBase = await call(client, "review_local", {
      cwd: app.repositoryPath,
      source: { kind: "commit", commit: "abcdef12" },
      base: "main",
    });

    for (const refused of [workingTree, commitWithBase])
      expect(refused.isError).toBe(true);
    await expect(
      readdir(app.paths.profileWorkbenchesDirectory(profileId)),
    ).rejects.toThrow();
  });
});
