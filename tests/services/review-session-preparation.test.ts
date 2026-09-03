import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  GitHubReader,
  GitHubReadFailure,
} from "../../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewArtifactStorage } from "../../src/adapters/storage/review-artifact-storage";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import {
  createReviewSessionId,
  parseContentHash,
  parseGitSha,
  parseIsoTimestamp,
  type ContentHash,
  type GitSha,
} from "../../src/domain/ids";
import { err, ok, type Result } from "../../src/domain/result";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { hashReviewArtifactContent } from "../../src/services/review-artifact-hash";
import { ReviewContextService } from "../../src/services/review-context-service";
import { ReviewSessionPreparation } from "../../src/services/review-session-preparation";
import type { GitReadExecutor } from "../../src/services/review-worktree-service";
import { ReviewWorktreeService } from "../../src/services/review-worktree-service";

const roots: string[] = [];
// SAFETY: this literal matches parseWorkspaceProfileId's accepted slug shape.
const profileId = "cfw" as never;
const headSha = value(parseGitSha("2".repeat(40)));
const changedHeadSha = value(parseGitSha("3".repeat(40)));
const baseSha = value(parseGitSha("1".repeat(40)));
const changedBaseSha = value(parseGitSha("4".repeat(40)));
const now = value(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
// SAFETY: these literals match their branded parsers' accepted formats
// (a bare hostname, slug-shaped owner/repo names, and a positive integer).
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

function contentHashOf(text: string): ContentHash {
  return value(parseContentHash(hashReviewArtifactContent(text)));
}

function value<T>(result: Result<T, unknown>): T {
  if (result._tag === "ok") return result.value;
  throw new Error("Invalid test fixture");
}

type DiffInput = Parameters<GitHubReader["getPullRequestDiff"]>[0];

type GitFailureOptions = {
  readonly failFetchNumber?: number;
  readonly failWorktreeAdd?: boolean;
};

type GithubReaderOptions = {
  readonly bases?: ReadonlyArray<GitSha | undefined>;
  readonly openStates?: ReadonlyArray<boolean>;
  readonly onDiff?: () => Promise<void>;
  /** Chooses the returned diff text per call; defaults to always `patch`. */
  readonly diffFor?: (input: DiffInput) => string;
  /** Overrides the full diff `Result` per call; takes precedence over `diffFor`. */
  readonly diffResult?: (input: DiffInput) => Result<string, GitHubReadFailure>;
};

/** Mutable draft of `GithubReaderOptions`, built in statements so each
 * optional field is added only when a fixture supplies it. */
type MutableGithubReaderOptions = {
  -readonly [K in keyof GithubReaderOptions]: GithubReaderOptions[K];
};

function github(
  heads: ReadonlyArray<GitSha>,
  options: GithubReaderOptions = {},
) {
  let getPullRequest = 0;
  let diffs = 0;
  const diffCalls: DiffInput[] = [];
  const summary = (head: GitSha, base: GitSha | undefined, isOpen: boolean) => {
    const result = {
      ref: pullRequest,
      title: "Fixture review",
      author: "fixture",
      headBranch: "feature/review",
      baseBranch: "sit",
      headSha: head,
      isDraft: false,
      isOpen,
      reviewState: "none" as const,
      mergeability: "unknown" as const,
      labels: [],
      updatedAt: now,
    };
    return base === undefined ? result : { ...result, baseSha: base };
  };
  return {
    counts: {
      get diffs() {
        return diffs;
      },
    },
    diffCalls,
    async getPullRequest() {
      const readIndex = getPullRequest;
      const head = heads[Math.min(readIndex, heads.length - 1)] ?? headSha;
      const base =
        options.bases === undefined
          ? baseSha
          : options.bases[Math.min(readIndex, options.bases.length - 1)];
      const isOpen =
        options.openStates?.[
          Math.min(readIndex, options.openStates.length - 1)
        ] ?? true;
      getPullRequest += 1;
      return ok(summary(head, base, isOpen));
    },
    async getPullRequestComments() {
      return ok({ threads: [], complete: true });
    },
    async getPullRequestChecks() {
      return ok({ overall: "passing" as const, checks: [] });
    },
    async getPullRequestDiff(input: DiffInput) {
      diffs += 1;
      diffCalls.push(input);
      await options.onDiff?.();
      if (options.diffResult !== undefined) return options.diffResult(input);
      return ok(options.diffFor?.(input) ?? patch);
    },
  } satisfies Pick<
    GitHubReader,
    | "getPullRequest"
    | "getPullRequestComments"
    | "getPullRequestChecks"
    | "getPullRequestDiff"
  > & {
    readonly counts: { readonly diffs: number };
    readonly diffCalls: ReadonlyArray<DiffInput>;
  };
}

function git(options: GitFailureOptions = {}): GitReadExecutor & {
  readonly calls: ReadonlyArray<ReadonlyArray<string>>;
} {
  const calls: ReadonlyArray<string>[] = [];
  let fetchCount = 0;
  return {
    calls,
    async run(argv) {
      calls.push(argv);
      if (argv.includes("--show-toplevel"))
        return ok({ stdout: "/fixture/repository\n" });
      if (options.failWorktreeAdd === true && argv.includes("add"))
        return err({ _tag: "GitReadFailed" });
      if (argv.includes("status") || argv.includes("worktree"))
        return ok({ stdout: "" });
      if (argv.includes("fetch")) {
        fetchCount += 1;
        if (fetchCount === options.failFetchNumber)
          return err({ _tag: "GitReadFailed" });
        return ok({ stdout: "" });
      }
      if (argv.includes("rev-parse")) return ok({ stdout: `${baseSha}\n` });
      return err({ _tag: "GitReadFailed" });
    },
  };
}

async function setup(
  options: GithubReaderOptions & {
    readonly heads?: ReadonlyArray<GitSha>;
    readonly bases?: ReadonlyArray<GitSha | undefined>;
    readonly localPath?: string;
    readonly gitFailure?: GitFailureOptions;
    readonly credentialFailure?: boolean;
    readonly ghUnresolvable?: boolean;
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
      workspaceRoots: [],
      rulePaths: [],
      repos:
        options.localPath === undefined
          ? []
          : [
              {
                host: pullRequest.host,
                owner: pullRequest.owner,
                repo: pullRequest.repo,
                localPath: options.localPath,
              },
            ],
    }),
  );
  const profiles = new ProfileStore(paths);
  await profiles.save(profile);
  const sessions = new ReviewSessionStore(paths);
  const readerOptions: MutableGithubReaderOptions = {};
  if (options.bases !== undefined) readerOptions.bases = options.bases;
  if (options.openStates !== undefined)
    readerOptions.openStates = options.openStates;
  if (options.onDiff !== undefined) readerOptions.onDiff = options.onDiff;
  if (options.diffFor !== undefined) readerOptions.diffFor = options.diffFor;
  if (options.diffResult !== undefined)
    readerOptions.diffResult = options.diffResult;
  const reader = github(options.heads ?? [headSha], readerOptions);
  const preparation = new ReviewSessionPreparation({
    profiles,
    sessions,
    github: reader,
    paths,
    now: () => now,
    worktrees: new ReviewWorktreeService(
      paths,
      git(options.gitFailure),
      {
        environmentFor: async () =>
          options.credentialFailure === true
            ? err({ _tag: "CommandAuthenticationRequired" })
            : ok({ GH_TOKEN: "profile-token" }),
        forget: () => undefined,
      },
      async () => (options.ghUnresolvable === true ? undefined : "/usr/bin/gh"),
    ),
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
  it("rejects an open pull request before creating terminal-only review artifacts", async () => {
    const fixture = await setup({ openStates: [true] });

    await expect(
      fixture.preparation.prepare({
        profileId,
        pullRequest,
        expectedPullRequestState: "non_open",
      }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "PullRequestStateChanged" },
    });
    expect(fixture.reader.counts.diffs).toBe(0);
  });

  it("rejects a reopen race while preparing a terminal-only review", async () => {
    const fixture = await setup({ openStates: [false, false, true] });

    await expect(
      fixture.preparation.prepare({
        profileId,
        pullRequest,
        expectedPullRequestState: "non_open",
      }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "PullRequestStateChanged" },
    });
  });

  it("rejects a first PR read without a base before creating an ID or journal", async () => {
    const fixture = await setup({ bases: [undefined] });
    const result = await fixture.preparation.prepare({
      profileId,
      pullRequest,
    });

    expect(result).toEqual({
      _tag: "err",
      error: { _tag: "PreparationUnavailable" },
    });
    expect(fixture.reader.counts.diffs).toBe(0);
    await expect(fixture.sessions.listSessions(profileId)).resolves.toEqual({
      _tag: "ok",
      value: [],
    });
  });

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

  it("lists a git-quoted changed path in the prepared context", async () => {
    // Git C-quotes any path with a non-ASCII byte, so the `+++ b/` prefix test
    // this list used to run never matched one and the file went unlisted.
    const quotedPatch = [
      'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
      '--- "a/src/caf\\303\\251.ts"',
      '+++ "b/src/caf\\303\\251.ts"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const fixture = await setup({ diffFor: () => quotedPatch });

    const prepared = await fixture.preparation.prepare({
      profileId,
      pullRequest,
    });

    expect(prepared._tag).toBe("ok");
    if (prepared._tag === "err") return;
    const context = JSON.parse(
      await readFile(
        fixture.paths.preparedContextFile(profileId, prepared.value.session.id),
        "utf8",
      ),
    );
    expect(context).toMatchObject({ changedFiles: ["src/café.ts"] });
  });

  it("saves a metadata-only session when the managed head fetch fails", async () => {
    const localRepo = await mkdtemp(join(tmpdir(), "patchdesk-local-repo-"));
    roots.push(localRepo);
    const fixture = await setup({
      localPath: localRepo,
      gitFailure: { failFetchNumber: 2 },
    });

    const prepared = await fixture.preparation.prepare({
      profileId,
      pullRequest,
    });

    expect(prepared).toMatchObject({
      _tag: "ok",
      value: {
        disposition: "prepared",
        session: { localCheckoutWarning: "local_checkout_unavailable" },
      },
    });
    if (prepared._tag === "err") return;
    expect(
      fixture.reader.diffCalls.every(
        (input) =>
          input.fetchedRefs === undefined && input.snapshot !== undefined,
      ),
    ).toBe(true);
    await expect(
      fixture.sessions.load(profileId, prepared.value.session.id),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { localCheckoutWarning: "local_checkout_unavailable" },
    });
    expect(
      await present(
        join(
          fixture.paths.sessionDirectory(profileId, prepared.value.session.id),
          "preparation.journal.json",
        ),
      ),
    ).toBe(false);
  });

  it("saves a metadata-only session when worktree creation fails", async () => {
    const localRepo = await mkdtemp(join(tmpdir(), "patchdesk-local-repo-"));
    roots.push(localRepo);
    const fixture = await setup({
      localPath: localRepo,
      gitFailure: { failWorktreeAdd: true },
    });

    const prepared = await fixture.preparation.prepare({
      profileId,
      pullRequest,
    });

    expect(prepared).toMatchObject({
      _tag: "ok",
      value: {
        disposition: "prepared",
        session: { localCheckoutWarning: "local_checkout_unavailable" },
      },
    });
    if (prepared._tag === "err") return;
    expect(fixture.reader.diffCalls[0]).toMatchObject({
      snapshot: { baseSha, headSha },
    });
    expect(fixture.reader.diffCalls[0]?.fetchedRefs).toBeUndefined();
  });

  it("fails closed as an authentication failure when the profile credential is unavailable, rather than falling back to metadata-only", async () => {
    const localRepo = await mkdtemp(join(tmpdir(), "patchdesk-local-repo-"));
    roots.push(localRepo);
    const fixture = await setup({
      localPath: localRepo,
      credentialFailure: true,
    });

    const result = await fixture.preparation.prepare({
      profileId,
      pullRequest,
    });

    expect(result).toEqual({
      _tag: "err",
      error: { _tag: "GitHubAuthenticationFailed" },
    });
  });

  it("fails closed as an authentication failure when gh cannot be resolved", async () => {
    const localRepo = await mkdtemp(join(tmpdir(), "patchdesk-local-repo-"));
    roots.push(localRepo);
    const fixture = await setup({
      localPath: localRepo,
      ghUnresolvable: true,
    });

    const result = await fixture.preparation.prepare({
      profileId,
      pullRequest,
    });

    expect(result).toEqual({
      _tag: "err",
      error: { _tag: "GitHubAuthenticationFailed" },
    });
  });

  it("maps a worktree storage failure onto the existing SessionStorageUnavailable tag, and removes the created worktree", async () => {
    const localRepo = await mkdtemp(join(tmpdir(), "patchdesk-local-repo-"));
    roots.push(localRepo);
    const fixture = await setup({ localPath: localRepo });
    const worktreeSessionId = createReviewSessionId({
      profileId,
      host: pullRequest.host,
      owner: pullRequest.owner,
      repo: pullRequest.repo,
      prNumber: pullRequest.number,
      headSha,
      baseSha,
    });
    const worktreePath = fixture.paths.worktreeDirectory(
      profileId,
      worktreeSessionId,
    );
    // A regular file already at the worktree path makes the in-branch
    // `mkdir(path, { recursive: true })` throw exactly like a real storage
    // failure, without depending on filesystem permissions.
    await mkdir(dirname(worktreePath), { recursive: true });
    await writeFile(worktreePath, "not a directory", "utf8");

    const result = await fixture.preparation.prepare({
      profileId,
      pullRequest,
    });

    expect(result).toEqual({
      _tag: "err",
      error: { _tag: "SessionStorageUnavailable" },
    });
    await expect(access(worktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
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
    const sessionId = createReviewSessionId({
      profileId,
      host: pullRequest.host,
      owner: pullRequest.owner,
      repo: pullRequest.repo,
      prNumber: pullRequest.number,
      headSha,
      baseSha,
    });

    expect(result).toEqual({ _tag: "err", error: { _tag: "HeadChanged" } });
    // SAFETY: this literal is only used as a stable path segment for the
    // fixture's temp directory, never validated as a real session id.
    expect(
      await present(fixture.paths.patchFile(profileId, sessionId as never)),
    ).toBe(false);
    // SAFETY: this literal is only used as a stable path segment for the
    // fixture's temp directory, never validated as a real session id.
    expect(
      await present(
        join(
          fixture.paths.sessionDirectory(profileId, sessionId as never),
          "preparation.journal.json",
        ),
      ),
    ).toBe(false);
  });

  it("rejects a base race and cleans the preparation journal and artifacts", async () => {
    const fixture = await setup({ bases: [baseSha, changedBaseSha] });
    const result = await fixture.preparation.prepare({
      profileId,
      pullRequest,
    });
    const sessionId = createReviewSessionId({
      profileId,
      host: pullRequest.host,
      owner: pullRequest.owner,
      repo: pullRequest.repo,
      prNumber: pullRequest.number,
      headSha,
      baseSha,
    });

    expect(result).toEqual({ _tag: "err", error: { _tag: "HeadChanged" } });
    expect(await present(fixture.paths.sessionFile(profileId, sessionId))).toBe(
      false,
    );
    expect(
      await present(
        join(
          fixture.paths.sessionDirectory(profileId, sessionId),
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
      baseSha,
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

  it("stores the canonical hash of GitHub's compare rendering in snapshot mode", async () => {
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
    expect(prepared.value.session.canonicalPatchHash).toBe(
      contentHashOf(patch),
    );
  });

  it("stores the canonical hash from GitHub's compare rendering in worktree mode, never the local worktree rendering", async () => {
    // Mirrors the real defect: local `git diff` abbreviates blob SHAs in
    // `index` lines to 8 hex characters, GitHub's compare endpoint to 9, so
    // the two renderings of the same commit pair hash differently.
    const worktreeDiff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 11111111..22222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const compareDiff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111111111..222222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const localRepo = await mkdtemp(join(tmpdir(), "patchdesk-local-repo-"));
    roots.push(localRepo);
    const fixture = await setup({
      localPath: localRepo,
      diffFor: (input) =>
        input.fetchedRefs !== undefined ? worktreeDiff : compareDiff,
    });

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
    // The on-disk patch used for display and insights is still the local
    // worktree rendering.
    expect(await readFile(session.patchPath, "utf8")).toBe(worktreeDiff);
    // But the hash that proves revision identity must come from GitHub's
    // compare rendering — this is the entire point of ADR 0026.
    expect(session.canonicalPatchHash).toBe(contentHashOf(compareDiff));
    expect(session.canonicalPatchHash).not.toBe(contentHashOf(worktreeDiff));
  });

  it("fails closed, without looping, when a journal is already live and recovery cannot clear it", async () => {
    const fixture = await setup();
    const sessionId = createReviewSessionId({
      profileId,
      host: pullRequest.host,
      owner: pullRequest.owner,
      repo: pullRequest.repo,
      prNumber: pullRequest.number,
      headSha,
      baseSha,
    });
    const sessionDirectory = fixture.paths.sessionDirectory(
      profileId,
      sessionId,
    );
    const journalFile = join(sessionDirectory, "preparation.journal.json");
    await mkdir(sessionDirectory, { recursive: true });
    // A journal whose recorded target isn't one of the Session's known
    // artifact paths fails `validatedDeletionSet`'s `allowedTargets` check,
    // so recovery can never clear it (mirrors a journal recovery cannot fix,
    // rather than one it legitimately clears). `begin()` must still see
    // this file and refuse to overwrite it.
    await writeFile(
      journalFile,
      JSON.stringify({
        schemaVersion: 1,
        profileId,
        sessionId,
        state: "preparing",
        targets: [join(sessionDirectory, "not-an-allowed-target")],
      }),
      "utf8",
    );

    const result = await fixture.preparation.prepare({
      profileId,
      pullRequest,
    });

    expect(result).toEqual({
      _tag: "err",
      error: { _tag: "SessionStorageUnavailable" },
    });
    // The unrecoverable journal is still exactly what was written: the
    // retry gave up rather than looping or overwriting it.
    expect(await readFile(journalFile, "utf8")).toContain(
      "not-an-allowed-target",
    );
  });

  it("recovers from a corrupt journal on disk rather than reporting SessionStorageUnavailable forever", async () => {
    const fixture = await setup();
    const sessionId = createReviewSessionId({
      profileId,
      host: pullRequest.host,
      owner: pullRequest.owner,
      repo: pullRequest.repo,
      prNumber: pullRequest.number,
      headSha,
      baseSha,
    });
    const sessionDirectory = fixture.paths.sessionDirectory(
      profileId,
      sessionId,
    );
    const journalFile = join(sessionDirectory, "preparation.journal.json");
    await mkdir(sessionDirectory, { recursive: true });
    // Mirrors the evaluator's P-E1 probe: a journal this process can never
    // parse, sitting at the exact path `prepare()` computes for this PR.
    await writeFile(journalFile, "{ truncated", "utf8");

    const first = await fixture.preparation.prepare({ profileId, pullRequest });

    expect(first).toMatchObject({
      _tag: "ok",
      value: { disposition: "prepared" },
    });
    await expect(access(journalFile)).rejects.toThrow();

    const second = await fixture.preparation.prepare({
      profileId,
      pullRequest,
    });

    expect(second).toMatchObject({
      _tag: "ok",
      value: { disposition: "resumed" },
    });
  });

  it("still creates the session with the canonical hash absent when the extra canonical fetch fails", async () => {
    const localRepo = await mkdtemp(join(tmpdir(), "patchdesk-local-repo-"));
    roots.push(localRepo);
    const fixture = await setup({
      localPath: localRepo,
      diffResult: (input) =>
        input.fetchedRefs !== undefined
          ? ok(patch)
          : err({ _tag: "GitHubReadFailed", operation: "get_diff" }),
    });

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
    expect(session.canonicalPatchHash).toBeUndefined();
    expect(await readFile(session.patchPath, "utf8")).toBe(patch);
  });
});
