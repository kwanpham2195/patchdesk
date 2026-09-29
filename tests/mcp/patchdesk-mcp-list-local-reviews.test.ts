import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

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
  setIntentInApp,
} from "./mcp-read-tools-fixture";
import { closeMcpTestClients, connectLegacyClient } from "./mcp-test-clients";

let app: McpAppFixture | undefined;

afterEach(async () => {
  await closeMcpTestClients();
  await app?.stop();
  app = undefined;
});

const listedSchema = v.looseObject({
  head: v.unknown(),
  reviews: v.array(
    v.looseObject({
      reviewId: v.string(),
      branch: v.string(),
      baseRef: v.string(),
    }),
  ),
});

async function listFrom(fixture: McpAppFixture, cwd: string) {
  const client = await connectLegacyClient(fixture.socketPath);
  const listed = await call(client, "list_local_reviews", { cwd });
  if (listed.isError) throw new Error("list_local_reviews refused");
  return v.parse(listedSchema, listed.content);
}

/** Every file under `directory` and its bytes, keyed by relative path. */
async function readTree(directory: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  }))
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files.set(relative(directory, path), await readFile(path));
    }
  return files;
}

function gitOutput(cwd: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("list_local_reviews (#558)", () => {
  it("lists the maintainer's shared Review from a subfolder of its checkout, and get_feedback reads its note", async () => {
    app = await startAppWithLinkedWorktree();
    await linkedBranchWithCommit(app);
    const opened = await openInApp(app, "develop");
    const noted = await app.route(
      "v1/reviews/local-drafts/notes/add",
      JSON.stringify({
        profileId: "acme",
        reviewId: opened.review.id,
        sessionId: opened.session.id,
        path: "feature.txt",
        side: "new",
        startLine: 1,
        line: 1,
        text: "Rename this file",
      }),
    );
    if (noted.status !== 200) throw new Error("note not added");
    const subfolder = join(app.linkedPath, "src", "deep");
    await mkdir(subfolder, { recursive: true });
    const client = await connectLegacyClient(app.socketPath);

    const listed = await call(client, "list_local_reviews", { cwd: subfolder });
    const feedback = await call(client, "get_feedback", {
      reviewId: opened.review.id,
    });

    expect(listed).toEqual({
      isError: false,
      content: {
        head: { kind: "branch", branch: "feat/linked" },
        reviews: [
          expect.objectContaining({
            reviewId: opened.review.id,
            sessionId: opened.session.id,
            headSha: opened.session.key.headSha,
            patchHash: opened.revision.patchHash,
            branch: "feat/linked",
            baseRef: "refs/heads/develop",
          }),
        ],
      },
    });
    expect(feedback).toMatchObject({
      isError: false,
      content: {
        localDrafts: [expect.objectContaining({ text: "Rename this file" })],
      },
    });
  });

  it("answers an empty list for a checkout with no shared Review, creating no Review directory", async () => {
    app = await startAppWithLinkedWorktree();

    const listed = await listFrom(app, app.repositoryPath);

    expect(listed).toEqual({
      head: { kind: "branch", branch: "main" },
      reviews: [],
    });
    await expect(
      readdir(app.paths.profileWorkbenchesDirectory(profileId)),
    ).rejects.toThrow();
  });

  it("lists two bases of the branch as two Reviews, the one opened last first", async () => {
    app = await startAppWithLinkedWorktree();
    await linkedBranchWithCommit(app);
    const againstDevelop = await openInApp(app, "develop");
    const againstMain = await openInApp(app, "main");

    const listed = await listFrom(app, app.linkedPath);

    expect(
      listed.reviews.map(({ reviewId, baseRef }) => ({
        reviewId,
        baseRef,
      })),
    ).toEqual([
      { reviewId: againstMain.review.id, baseRef: "refs/heads/main" },
      { reviewId: againstDevelop.review.id, baseRef: "refs/heads/develop" },
    ]);
  });

  it("leaves out a Review the maintainer opened in another profile", async () => {
    app = await startAppWithLinkedWorktree({ profiles: "two" });
    await linkedBranchWithCommit(app);
    await openInApp(app, "develop", "other");

    const listed = await listFrom(app, app.linkedPath);

    expect(listed.reviews).toEqual([]);
  });

  it("writes nothing: stored records, refs/patchdesk, and the worktree list are unchanged", async () => {
    app = await startAppWithLinkedWorktree();
    await linkedBranchWithCommit(app);
    await openInApp(app, "develop");
    const before = {
      files: await readTree(app.paths.dataProfilesDirectory()),
      refs: gitOutput(app.repositoryPath, "for-each-ref", "refs/patchdesk"),
      worktrees: gitOutput(
        app.repositoryPath,
        "worktree",
        "list",
        "--porcelain",
      ),
    };

    await listFrom(app, app.linkedPath);
    await listFrom(app, app.repositoryPath);

    expect(before.files.size).toBeGreaterThan(0);
    expect(before.refs).not.toBe("");
    expect(await readTree(app.paths.dataProfilesDirectory())).toEqual(
      before.files,
    );
    expect(
      gitOutput(app.repositoryPath, "for-each-ref", "refs/patchdesk"),
    ).toBe(before.refs);
    expect(
      gitOutput(app.repositoryPath, "worktree", "list", "--porcelain"),
    ).toBe(before.worktrees);
  });

  it("names each Review's Change intent by kind and source without its Markdown (#601)", async () => {
    app = await startAppWithLinkedWorktree();
    await linkedBranchWithCommit(app);
    const againstDevelop = await openInApp(app, "develop");
    await setIntentInApp(app, againstDevelop.review.id, {
      kind: "text",
      markdown: "Maintainer goal text.",
    });
    await openInApp(app, "main");
    const client = await connectLegacyClient(app.socketPath);
    await call(client, "review_local", {
      cwd: app.linkedPath,
      base: "main",
      intent: "Agent goal text.",
    });

    const listed = await call(client, "list_local_reviews", {
      cwd: app.linkedPath,
    });

    expect(listed).toMatchObject({
      isError: false,
      content: {
        reviews: [
          {
            baseBranch: "main",
            changeIntent: { kind: "text", source: "agent" },
          },
          {
            baseBranch: "develop",
            changeIntent: { kind: "text", source: "maintainer" },
          },
        ],
      },
    });
    expect(JSON.stringify(listed.content)).not.toMatch(/goal text/);
  });

  it("lists the same bases for the checked-out branch as the open dialog's reviewedBases", async () => {
    app = await startAppWithLinkedWorktree();
    await linkedBranchWithCommit(app);
    await openInApp(app, "main");
    await openInApp(app, "develop");

    const listed = await listFrom(app, app.linkedPath);
    const dialog = await app.route(
      `v1/reviews/local-branches?${new URLSearchParams({
        profileId: "acme",
        host: "github.com",
        owner: "octo-org",
        repo: "patchdesk",
        checkout: app.linkedPath,
      }).toString()}`,
    );

    expect(dialog.body).toMatchObject({
      reviewedBases: listed.reviews
        .filter((review) => review.branch === "feat/linked")
        .map((review) => review.baseRef),
    });
    expect(listed.reviews).toHaveLength(2);
  });

  it("refuses checkout_not_found for a directory outside every checkout", async () => {
    app = await startAppWithLinkedWorktree();
    const client = await connectLegacyClient(app.socketPath);

    const refused = await call(client, "list_local_reviews", {
      cwd: dirname(app.repositoryPath),
    });

    expect(refused).toMatchObject({
      isError: true,
      content: { error: "checkout_not_found" },
    });
  });
});
