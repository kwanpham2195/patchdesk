import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GitHubReader } from "../../src/adapters/github/github-adapter";
import {
  parseAbsolutePath,
  parseContentHash,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
  type ContentHash,
} from "../../src/domain/ids";
import type { PullRequestSummary } from "../../src/domain/github-context";
import { createReviewSession } from "../../src/domain/review-session";
import { ok, type Result } from "../../src/domain/result";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { hashReviewArtifactContent } from "../../src/services/review-artifact-hash";
import { GitHubRevisionIdentityReader } from "../../src/services/github-revision-identity-reader";

const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "err") throw new Error("Invalid fixture");
  return result.value;
};

const profileId = must(parseWorkspaceProfileId("cfw"));
const pr = {
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
  number: must(parsePullRequestNumber(42)),
};
const baseSha = must(parseGitSha("a".repeat(40)));
const headSha = must(parseGitSha("b".repeat(40)));
const otherSha = must(parseGitSha("c".repeat(40)));
const profile = must(
  parseWorkspaceProfileConfig({
    id: profileId,
    label: "CFW",
    githubHost: "github.com",
    ghAccount: "fixture",
    ownerFilters: [],
    workspaceRoots: [],
    rulePaths: [],
    repos: [],
  }),
);
const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-before",
  "+after",
  "",
].join("\n");
const roots: string[] = [];

function contentHashOf(text: string): ContentHash {
  return must(parseContentHash(hashReviewArtifactContent(text)));
}

/** Mutable draft of `createReviewSession`'s input, built in statements so
 * `canonicalPatchHash` is added only when a fixture supplies one. */
type MutableCreateReviewSessionInput = {
  -readonly [K in keyof Parameters<typeof createReviewSession>[0]]: Parameters<
    typeof createReviewSession
  >[0][K];
};

/** Mutable draft of a fixture `PullRequestSummary`, built in statements so
 * `baseSha` is added only when a fixture supplies one. */
type MutablePullRequestSummary = {
  -readonly [K in keyof PullRequestSummary]: PullRequestSummary[K];
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("GitHubRevisionIdentityReader", () => {
  it("proves a complete canonical remote diff matches the represented session", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-revision-"));
    roots.push(root);
    const session = await makeSession(root, patch);
    const reader = new GitHubRevisionIdentityReader(
      gateway({ headSha, baseSha, changedFileCount: 1 }, patch),
    );

    await expect(reader.read({ profile, pr, session })).resolves.toMatchObject({
      _tag: "ok",
      value: { _tag: "Same", identity: { headSha, baseSha } },
    });
  });

  it("reports a complete remote patch mismatch as a changed revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-revision-"));
    roots.push(root);
    const session = await makeSession(root, patch);
    const changedPatch = patch.replace("+after", "+different");
    const reader = new GitHubRevisionIdentityReader(
      gateway(
        { headSha: otherSha, baseSha, changedFileCount: 1 },
        changedPatch,
      ),
    );

    await expect(reader.read({ profile, pr, session })).resolves.toMatchObject({
      _tag: "ok",
      value: { _tag: "Changed", identity: { headSha: otherSha, baseSha } },
    });
  });

  it("fails closed when GitHub cannot prove the diff complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-revision-"));
    roots.push(root);
    const session = await makeSession(root, patch);
    const reader = new GitHubRevisionIdentityReader(
      gateway({ headSha, baseSha, changedFileCount: 2 }, patch),
    );

    await expect(reader.read({ profile, pr, session })).resolves.toEqual({
      _tag: "ok",
      value: { _tag: "Unavailable", reason: "diff_incomplete" },
    });
  });

  it("fails closed when GitHub does not supply a base SHA", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-revision-"));
    roots.push(root);
    const session = await makeSession(root, patch);
    const reader = new GitHubRevisionIdentityReader(
      gateway({ headSha, changedFileCount: 1 }, patch),
    );

    await expect(reader.read({ profile, pr, session })).resolves.toEqual({
      _tag: "ok",
      value: { _tag: "Unavailable", reason: "base_missing" },
    });
  });

  it("reports Same when the stored canonical hash equals the fresh hash and both SHAs match", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-revision-"));
    roots.push(root);
    const session = await makeSession(root, patch, contentHashOf(patch));
    const reader = new GitHubRevisionIdentityReader(
      gateway({ headSha, baseSha, changedFileCount: 1 }, patch),
    );

    await expect(reader.read({ profile, pr, session })).resolves.toMatchObject({
      _tag: "ok",
      value: { _tag: "Same", identity: { headSha, baseSha } },
    });
  });

  it("reports Changed when the stored canonical hash differs from the fresh hash even though both SHAs match", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-revision-"));
    roots.push(root);
    const changedPatch = patch.replace("+after", "+different");
    const session = await makeSession(root, patch, contentHashOf(changedPatch));
    const reader = new GitHubRevisionIdentityReader(
      gateway({ headSha, baseSha, changedFileCount: 1 }, patch),
    );

    await expect(reader.read({ profile, pr, session })).resolves.toMatchObject({
      _tag: "ok",
      value: { _tag: "Changed", identity: { headSha, baseSha } },
    });
  });

  it("reports Same on the SHA pair alone when the legacy session has no stored canonical hash, regardless of remote patch content", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-revision-"));
    roots.push(root);
    const session = await makeSession(root, patch);
    const unrelatedRemotePatch = patch.replace("+after", "+wildly different");
    const reader = new GitHubRevisionIdentityReader(
      gateway({ headSha, baseSha, changedFileCount: 1 }, unrelatedRemotePatch),
    );

    await expect(reader.read({ profile, pr, session })).resolves.toMatchObject({
      _tag: "ok",
      value: { _tag: "Same", identity: { headSha, baseSha } },
    });
  });

  it("reports Changed when the legacy session has no stored canonical hash but the head SHA differs", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-revision-"));
    roots.push(root);
    const session = await makeSession(root, patch);
    const reader = new GitHubRevisionIdentityReader(
      gateway({ headSha: otherSha, baseSha, changedFileCount: 1 }, patch),
    );

    await expect(reader.read({ profile, pr, session })).resolves.toMatchObject({
      _tag: "ok",
      value: { _tag: "Changed", identity: { headSha: otherSha, baseSha } },
    });
  });
});

async function makeSession(
  root: string,
  contents: string,
  canonicalPatchHash?: ContentHash,
) {
  const patchPath = join(root, "review.patch");
  await writeFile(patchPath, contents, "utf8");
  const input: MutableCreateReviewSessionInput = {
    key: {
      profileId,
      host: pr.host,
      owner: pr.owner,
      repo: pr.repo,
      prNumber: pr.number,
      headSha,
      baseSha,
    },
    pr: { headSha, baseSha, isDraft: false, isOpen: true },
    patchPath: must(parseAbsolutePath(patchPath)),
    worktree: { path: must(parseAbsolutePath(root)), headSha },
    // SAFETY: this literal is a well-formed ISO 8601 instant, satisfying the
    // branded IsoTimestamp contract `createdAt` requires.
    createdAt: "2026-08-12T00:00:00.000Z" as never,
  };
  if (canonicalPatchHash !== undefined)
    input.canonicalPatchHash = canonicalPatchHash;
  return createReviewSession(input);
}

function gateway(
  current: {
    readonly headSha: typeof headSha;
    readonly baseSha?: typeof baseSha;
    readonly changedFileCount: number;
  },
  diff: string,
): Pick<GitHubReader, "getPullRequest" | "getPullRequestDiff"> {
  return {
    async getPullRequest() {
      const summary: MutablePullRequestSummary = {
        ref: pr,
        headSha: current.headSha,
        isDraft: false,
        isOpen: true,
        title: "Fixture",
        author: "fixture",
        headBranch: "feature",
        baseBranch: "main",
        reviewState: "none",
        mergeability: "mergeable",
        labels: [],
        changedFileCount: current.changedFileCount,
        // SAFETY: this literal is a well-formed ISO 8601 instant, satisfying
        // the branded IsoTimestamp contract `updatedAt` requires.
        updatedAt: "2026-08-12T00:00:00.000Z" as never,
      };
      if (current.baseSha !== undefined) summary.baseSha = current.baseSha;
      return ok(summary);
    },
    async getPullRequestDiff() {
      return ok(diff);
    },
  };
}
