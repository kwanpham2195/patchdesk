import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GitHubReader } from "../../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewArtifactStorage } from "../../src/adapters/storage/review-artifact-storage";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import {
  createReviewSessionId,
  parseGitSha,
  parseIsoTimestamp,
  type GitSha,
} from "../../src/domain/ids";
import { err, ok, type Result } from "../../src/domain/result";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { ReviewContextService } from "../../src/services/review-context-service";
import { ReviewSessionPreparation } from "../../src/services/review-session-preparation";
import type { GitReadExecutor } from "../../src/services/review-worktree-service";
import { ReviewWorktreeService } from "../../src/services/review-worktree-service";

const roots: string[] = [];
const profileId = "cfw" as never;
const headSha = value(parseGitSha("2".repeat(40)));
const changedHeadSha = value(parseGitSha("3".repeat(40)));
const baseSha = value(parseGitSha("1".repeat(40)));
const now = value(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const pullRequest = {
  host: "github.com" as never,
  owner: "centraldigital" as never,
  repo: "patchdesk" as never,
  number: 42 as never,
};

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function value<T>(result: Result<T, unknown>): T {
  if (result._tag === "ok") return result.value;
  throw new Error("Invalid test fixture");
}

function github(heads: ReadonlyArray<GitSha>, onDiff?: () => Promise<void>) {
  let getPullRequest = 0;
  let diffs = 0;
  const summary = (head: GitSha) => ({
    ref: pullRequest,
    title: "Fixture review",
    author: "fixture",
    headBranch: "feature/review",
    baseBranch: "sit",
    headSha: head,
    baseSha,
    isDraft: false,
    isOpen: true,
    reviewState: "none" as const,
    mergeability: "unknown" as const,
    labels: [],
    updatedAt: now,
  });
  return {
    counts: {
      get diffs() {
        return diffs;
      },
    },
    async getPullRequest() {
      const head = heads[Math.min(getPullRequest, heads.length - 1)] ?? headSha;
      getPullRequest += 1;
      return ok(summary(head));
    },
    async getPullRequestComments() {
      return ok({ threads: [], complete: true });
    },
    async getPullRequestChecks() {
      return ok({ overall: "passing" as const, checks: [] });
    },
    async getPullRequestDiff(input: unknown) {
      void input;
      diffs += 1;
      await onDiff?.();
      return ok(patch);
    },
  } satisfies Pick<
    GitHubReader,
    | "getPullRequest"
    | "getPullRequestComments"
    | "getPullRequestChecks"
    | "getPullRequestDiff"
  > & { readonly counts: { readonly diffs: number } };
}

function git(): GitReadExecutor & {
  readonly calls: ReadonlyArray<ReadonlyArray<string>>;
} {
  const calls: ReadonlyArray<string>[] = [];
  return {
    calls,
    async run(argv) {
      calls.push(argv);
      if (argv.includes("--show-toplevel"))
        return ok({ stdout: "/fixture/repository\n" });
      if (
        argv.includes("status") ||
        argv.includes("fetch") ||
        argv.includes("worktree")
      )
        return ok({ stdout: "" });
      if (argv.includes("rev-parse")) return ok({ stdout: `${baseSha}\n` });
      return err({ _tag: "GitReadFailed" });
    },
  };
}

async function setup(
  options: {
    readonly heads?: ReadonlyArray<GitSha>;
    readonly onDiff?: () => Promise<void>;
    readonly localPath?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-preparation-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  const profile = value(
    parseWorkspaceProfileConfig({
      id: profileId,
      label: "CFW",
      githubHost: "github.com",
      ghAccount: "fixture",
      ownerFilters: [],
      workspaceRoots: [],
      rulePaths: [],
      repos:
        options.localPath === undefined
          ? []
          : [{ ...pullRequest, localPath: options.localPath }],
    }),
  );
  const profiles = new ProfileStore(paths);
  await profiles.save(profile);
  const sessions = new ReviewSessionStore(paths);
  const reader = github(options.heads ?? [headSha], options.onDiff);
  const preparation = new ReviewSessionPreparation({
    profiles,
    sessions,
    github: reader,
    paths,
    now: () => now,
    worktrees: new ReviewWorktreeService(paths, git()),
    context: new ReviewContextService(),
    artifacts: new ReviewArtifactStorage(paths, () => now),
  });
  return { paths, sessions, preparation, reader };
}

async function present(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("ReviewSessionPreparation", () => {
  it("prepares complete immutable patch, context, review-input, and debug artifacts", async () => {
    const fixture = await setup();
    const prepared = await fixture.preparation.prepare({
      profileId,
      pullRequest,
    });

    expect(prepared).toMatchObject({
      _tag: "ok",
      value: { disposition: "prepared" },
    });
    if (prepared._tag === "err") return;
    const session = prepared.value.session;
    expect(await readFile(session.patchPath, "utf8")).toBe(patch);
    expect(
      await readFile(
        fixture.paths.preparedContextFile(profileId, session.id),
        "utf8",
      ),
    ).toContain("src/a.ts");
    expect(
      await readFile(
        fixture.paths.preparedReviewInputFile(profileId, session.id),
        "utf8",
      ),
    ).toContain("PR review input");
    expect(
      JSON.parse(
        await readFile(
          fixture.paths.preparedDebugFile(profileId, session.id),
          "utf8",
        ),
      ),
    ).toMatchObject({ inspectedFileCount: 0, searchCount: 0, gitShowCount: 0 });
    expect(
      await present(
        join(
          fixture.paths.sessionDirectory(profileId, session.id),
          "preparation.journal.json",
        ),
      ),
    ).toBe(false);
    expect(session.pr.baseSha).toBe(baseSha);
  });

  it("resumes the deterministic prepared session without rewriting the patch", async () => {
    const fixture = await setup();
    const first = await fixture.preparation.prepare({ profileId, pullRequest });
    const second = await fixture.preparation.prepare({
      profileId,
      pullRequest,
    });

    expect(first).toMatchObject({
      _tag: "ok",
      value: { disposition: "prepared" },
    });
    expect(second).toMatchObject({
      _tag: "ok",
      value: { disposition: "resumed" },
    });
    if (first._tag === "err" || second._tag === "err") return;
    expect(second.value.session.id).toBe(first.value.session.id);
    expect(fixture.reader.counts.diffs).toBe(1);
  });

  it("serializes concurrent preparation for one deterministic session", async () => {
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await setup({ onDiff: async () => await wait });
    const first = fixture.preparation.prepare({ profileId, pullRequest });
    const second = fixture.preparation.prepare({ profileId, pullRequest });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release?.();
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result._tag)).toEqual(["ok", "ok"]);
    expect(
      results
        .flatMap((result) =>
          result._tag === "ok" ? [result.value.disposition] : [],
        )
        .sort(),
    ).toEqual(["prepared", "resumed"]);
    expect(fixture.reader.counts.diffs).toBe(1);
  });

  it("rejects a head race and cleans the preparation journal and artifacts", async () => {
    const fixture = await setup({ heads: [headSha, changedHeadSha] });
    const result = await fixture.preparation.prepare({
      profileId,
      pullRequest,
    });
    const sessionId = `github.com__centraldigital__patchdesk__pr-42__sha-${headSha.slice(0, 8)}`;

    expect(result).toEqual({ _tag: "err", error: { _tag: "HeadChanged" } });
    expect(
      await present(fixture.paths.patchFile(profileId, sessionId as never)),
    ).toBe(false);
    expect(
      await present(
        join(
          fixture.paths.sessionDirectory(profileId, sessionId as never),
          "preparation.journal.json",
        ),
      ),
    ).toBe(false);
  });

  it("quarantines an invalid current session before preparing the exact replacement", async () => {
    const fixture = await setup();
    const sessionId = createReviewSessionId({
      profileId,
      host: pullRequest.host,
      owner: pullRequest.owner,
      repo: pullRequest.repo,
      prNumber: pullRequest.number,
      headSha,
    });
    await mkdir(fixture.paths.sessionDirectory(profileId, sessionId), {
      recursive: true,
    });
    await writeFile(
      fixture.paths.sessionFile(profileId, sessionId),
      JSON.stringify({ schemaVersion: 1, id: sessionId }),
      "utf8",
    );
    const result = await fixture.preparation.prepare({
      profileId,
      pullRequest,
    });

    expect(result).toMatchObject({
      _tag: "ok",
      value: { disposition: "prepared", session: { id: sessionId } },
    });
    const quarantined = fixture.paths.profileReviewsDirectory(profileId);
    expect(await present(join(quarantined, ".quarantine"))).toBe(true);
  });
});
