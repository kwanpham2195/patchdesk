import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ReviewArtifactStorage } from "../../src/adapters/storage/review-artifact-storage";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import {
  createReviewSessionId,
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
  type GitSha,
  type WorkspaceProfileId,
} from "../../src/domain/ids";
import {
  createReviewSession,
  type ReviewSession,
} from "../../src/domain/review-session";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import {
  StorageManagementService,
  type TrashMover,
} from "../../src/services/storage-management-service";
import type { GitReadExecutor } from "../../src/services/review-worktree-service";

const profileId = mustParse(parseWorkspaceProfileId("cfw"));
const host = mustParse(parseGitHubHost("github.com"));
const owner = mustParse(parseGitHubOwner("centraldigital"));
const repo = mustParse(parseGitHubRepoName("patchdesk"));
const prNumber = mustParse(parsePullRequestNumber(42));
const headSha = mustParse(parseGitSha("abcdef1234567890abcdef1234567890abcdef12"));
const completedSha = mustParse(parseGitSha("2222222222222222222222222222222222222222"));
const reviewedSha = mustParse(parseGitSha("3333333333333333333333333333333333333333"));
const createdAt = mustParse(parseIsoTimestamp("2026-07-16T00:00:00.000Z"));
const completedAt = mustParse(parseIsoTimestamp("2026-07-16T00:01:00.000Z"));
const updatedAt = mustParse(parseIsoTimestamp("2026-07-16T00:02:00.000Z"));

const localPaths = {
  cfw: "/workspace/cfw",
  patchdesk: "/workspace/patchdesk",
} as const;

function mustParse<T, E>(
  result:
    | { readonly _tag: "ok"; readonly value: T }
    | { readonly _tag: "err"; readonly error: E },
): T {
  if (result._tag === "err") throw new Error("Invalid fixture");
  return result.value;
}

type Setup = Awaited<ReturnType<typeof setupService>>;

async function setupService(): Promise<{
  readonly root: string;
  readonly paths: PatchdeskPaths;
  readonly sessions: ReviewSessionStore;
  readonly service: StorageManagementService;
  readonly artifacts: ReviewArtifactStorage;
  readonly trash: TrashMover & { readonly moves: Array<{ readonly path: string }> };
  readonly git: GitReadExecutor & { readonly calls: Array<ReadonlyArray<string>> };
  readonly sessionsById: {
    readonly created: ReviewSession;
    readonly reviewed: ReviewSession;
    readonly running: ReviewSession;
  };
}> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-storage-mgmt-"));
  const paths = PatchdeskPaths.forTest(root);
  const profile = mustParse(parseWorkspaceProfileConfig({
    id: "cfw",
    label: "CFW",
    githubHost: "github.com",
    ghAccount: "fixture",
    ownerFilters: [],
    workspaceRoots: [localPaths.cfw],
    rulePaths: [],
    repos: [
      {
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        localPath: localPaths.patchdesk,
      },
    ],
  }));
  await new ProfileStore(paths).save(profile);

  const sessions = new ReviewSessionStore(paths);
  const created = await saveSession(sessions, paths, profileId, headSha, { _tag: "Created" });
  const reviewed = await saveSession(sessions, paths, profileId, reviewedSha, {
    _tag: "ReviewCompleted",
    attemptId: "001" as never,
  });
  const running = await saveSession(sessions, paths, profileId, completedSha, {
    _tag: "Running",
    attemptId: "001" as never,
  });

  // Seed a cache directory for the running session that must be preserved.
  await mkdir(paths.worktreeDirectory(profileId, running.id), { recursive: true });
  await writeFile(
    join(paths.worktreeDirectory(profileId, running.id), "worktree.json"),
    "stale",
    "utf8",
  );
  await mkdir(join(paths.worktreeDirectory(profileId, running.id), "nested"), {
    recursive: true,
  });
  await writeFile(
    join(paths.worktreeDirectory(profileId, running.id), "nested", "data.txt"),
    "nested-data",
    "utf8",
  );
  // Seed a cache directory for the completed session that must be removed.
  await mkdir(paths.worktreeDirectory(profileId, reviewed.id), { recursive: true });

  const trash: TrashMover & { readonly moves: Array<{ readonly path: string }> } = {
    moves: [],
    async move(path) {
      this.moves.push({ path });
      return { _tag: "ok", value: undefined };
    },
  };
  const git: GitReadExecutor & { readonly calls: Array<ReadonlyArray<string>> } = {
    calls: [],
    async run(argv) {
      this.calls.push(argv);
      return { _tag: "ok", value: { stdout: "" } };
    },
  };
  const artifacts = new ReviewArtifactStorage(paths, () => completedAt);
  const service = new StorageManagementService({
    profiles: new ProfileStore(paths),
    sessions,
    artifacts,
    paths,
    trash,
    git,
    now: () => updatedAt,
  });
  return {
    root,
    paths,
    sessions,
    service,
    artifacts,
    trash,
    git,
    sessionsById: { created, reviewed, running },
  };
}

async function saveSession(
  store: ReviewSessionStore,
  paths: PatchdeskPaths,
  profileIdValue: WorkspaceProfileId,
  head: GitSha,
  state: ReviewSession["state"],
): Promise<ReviewSession> {
  const sessionId = createReviewSessionId({
    profileId: profileIdValue,
    host,
    owner,
    repo,
    prNumber,
    headSha: head,
  });
  const session = createReviewSession({
    key: {
      profileId: profileIdValue,
      host,
      owner,
      repo,
      prNumber,
      headSha: head,
    },
    pr: { headSha: head, isDraft: false, isOpen: true },
    patchPath: mustParse(parseAbsolutePath(paths.patchFile(profileIdValue, sessionId))),
    worktree: {
      path: mustParse(parseAbsolutePath(paths.worktreeDirectory(profileIdValue, sessionId))),
      headSha: head,
    },
    createdAt,
  });
  const merged: ReviewSession = { ...session, state, ...(state._tag === "Created" ? {} : { currentAttemptId: "001" as never }) };
  expect((await store.save(merged))._tag).toBe("ok");
  return merged;
}

async function exists(path: string): Promise<boolean> {
  try {
    const { access } = await import("node:fs/promises");
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("StorageManagementService", () => {
  it("returns a path-free projection where only non-running saved reviews are discardable", async () => {
    const setup = await trackSetup();
    const listed = await setup.service.list(profileId);
    expect(listed._tag).toBe("ok");
    if (listed._tag !== "ok") return;
    const byId = new Map(listed.value.sessions.map((entry) => [entry.id, entry]));
    expect(byId.get(setup.sessionsById.created.id)?.canDiscard).toBe(true);
    expect(byId.get(setup.sessionsById.reviewed.id)?.canDiscard).toBe(true);
    expect(byId.get(setup.sessionsById.running.id)?.canDiscard).toBe(false);
    expect(byId.get(setup.sessionsById.running.id)?.state).toBe("Running");
    expect(listed.value.quarantined).toEqual([]);
    expect(listed.value.cacheBytes).toBeGreaterThan(0);
  });

  it("refuses to discard a Running session", async () => {
    const setup = await trackSetup();
    const result = await setup.service.discard({
      profileId,
      sessionId: setup.sessionsById.running.id,
    });
    expect(result).toEqual({ _tag: "err", error: { _tag: "SessionRunning" } });
  });

  it("discards a saved review, retains the session.json, and removes its managed worktree", async () => {
    const setup = await trackSetup();
    const target = setup.sessionsById.reviewed;
    const result = await setup.service.discard({ profileId, sessionId: target.id });
    expect(result).toEqual({ _tag: "ok", value: undefined });
    expect(await exists(setup.paths.sessionFile(profileId, target.id))).toBe(true);
    expect(await exists(setup.paths.worktreeDirectory(profileId, target.id))).toBe(false);
    const reloaded = await setup.sessions.load(profileId, target.id);
    expect(reloaded).toMatchObject({
      _tag: "ok",
      value: { state: { _tag: "Discarded" } },
    });
  });

  it("clears non-running cache children, preserves Running worktrees, and prunes once per localPath", async () => {
    const setup = await trackSetup();
    const result = await setup.service.clearCache(profileId);
    expect(result).toMatchObject({ _tag: "ok" });
    expect(await exists(setup.paths.worktreeDirectory(profileId, setup.sessionsById.running.id))).toBe(true);
    expect(await exists(setup.paths.worktreeDirectory(profileId, setup.sessionsById.reviewed.id))).toBe(false);
    const cacheEntries = await readdir(setup.paths.worktreeRootDirectory(profileId));
    expect(cacheEntries.some((entry) => entry.includes(".removed."))).toBe(false);
    const pruneCalls = setup.git.calls.filter((argv) => argv.includes("prune"));
    expect(pruneCalls.length).toBe(1);
    expect(pruneCalls[0]?.join(" ")).toContain(localPaths.patchdesk);
  });

  it("preserves a worktree when its unreadable session envelope records Running", async () => {
    const setup = await trackSetup();
    const sessionPath = setup.paths.sessionFile(profileId, setup.sessionsById.running.id);
    const contents = await readFile(sessionPath, "utf8");
    const corrupted = contents.replace(
      /"attemptId"\s*:\s*"001"/,
      '"attemptId": "bad"',
    );
    expect(corrupted).not.toBe(contents);
    await writeFile(sessionPath, corrupted, "utf8");

    const result = await setup.service.clearCache(profileId);
    expect(result).toEqual({ _tag: "ok", value: undefined });
    expect(await exists(setup.paths.worktreeDirectory(profileId, setup.sessionsById.running.id))).toBe(true);
    expect(setup.git.calls).toHaveLength(1);
  });

  it("counts nested cache contents rather than directory metadata", async () => {
    const setup = await trackSetup();
    const result = await setup.service.list(profileId);
    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value.cacheBytes).toBe("stale".length + "nested-data".length);
  });

  it("moves a quarantined session and its worktree to Trash", async () => {
    const setup = await trackSetup();
    const target = setup.sessionsById.reviewed;
    const stamp = formatStamp("2026-07-25T00:00:00.000Z");
    const entry = `${target.id}.${stamp}`;
    const sessionRoot = setup.paths.quarantinedSessionDirectory(profileId, entry);
    const worktreeRoot = setup.paths.quarantinedWorktreeDirectory(profileId, entry);
    await mkdir(sessionRoot, { recursive: true });
    await mkdir(worktreeRoot, { recursive: true });

    const result = await setup.service.deleteQuarantined({ profileId, entryName: entry });
    expect(result).toEqual({ _tag: "ok", value: undefined });
    expect(setup.trash.moves.map((m) => m.path)).toEqual(
      expect.arrayContaining([sessionRoot, worktreeRoot]),
    );
  });

  it("rejects a valid-looking quarantine name when its session entry is absent", async () => {
    const setup = await trackSetup();
    const target = setup.sessionsById.reviewed;
    const entry = `${target.id}.${formatStamp("2026-07-25T00:00:00.000Z")}`;

    const result = await setup.service.deleteQuarantined({ profileId, entryName: entry });
    expect(result).toEqual({ _tag: "err", error: { _tag: "SessionNotFound" } });
    expect(setup.trash.moves).toHaveLength(0);
  });

  it("accepts a quarantined entry when its worktree is already absent", async () => {
    const setup = await trackSetup();
    const target = setup.sessionsById.reviewed;
    const entry = `${target.id}.${formatStamp("2026-07-25T00:00:00.000Z")}`;
    const sessionRoot = setup.paths.quarantinedSessionDirectory(profileId, entry);
    await mkdir(sessionRoot, { recursive: true });

    const result = await setup.service.deleteQuarantined({ profileId, entryName: entry });
    expect(result).toEqual({ _tag: "ok", value: undefined });
    expect(setup.trash.moves.map((move) => move.path)).toEqual([sessionRoot]);
  });

  it("rejects quarantine names without a valid session ID", async () => {
    const setup = await trackSetup();
    const result = await setup.service.deleteQuarantined({
      profileId,
      entryName: "not-a-session.20260725T000000",
    });
    expect(result).toEqual({
      _tag: "err",
      error: { _tag: "InvalidQuarantineEntryName" },
    });
    expect(setup.trash.moves).toHaveLength(0);
  });

  it("rejects traversal-shaped quarantine names without moving anything", async () => {
    const setup = await trackSetup();
    const result = await setup.service.deleteQuarantined({
      profileId,
      entryName: "../etc/passwd",
    });
    expect(result).toEqual({
      _tag: "err",
      error: { _tag: "InvalidQuarantineEntryName" },
    });
    expect(setup.trash.moves).toHaveLength(0);
  });

  it("removes a session and its cache worktree idempotently", async () => {
    const setup = await trackSetup();
    const target = setup.sessionsById.reviewed;
    expect(await setup.artifacts.removeSession(profileId, target.id)).toEqual({ _tag: "ok", value: undefined });
    expect(await exists(setup.paths.sessionDirectory(profileId, target.id))).toBe(false);
    expect(await setup.artifacts.removeSession(profileId, target.id)).toEqual({ _tag: "ok", value: undefined });
  });

  it("rejects removal when an ancestor is a symlink outside the app-owned root", async () => {
    const setup = await trackSetup();
    const outside = await mkdtemp(join(tmpdir(), "patchdesk-outside-"));
    await rm(setup.paths.profileReviewsDirectory(profileId), { recursive: true, force: true });
    await symlink(outside, setup.paths.profileReviewsDirectory(profileId), "dir");
    const result = await setup.artifacts.removeSession(profileId, setup.sessionsById.reviewed.id);
    expect(result._tag).toBe("err");
    await rm(outside, { recursive: true, force: true });
  });

  it("removes every non-running session and quarantined evidence while preserving running reviews", async () => {
    const setup = await trackSetup();
    const discarded = setup.sessionsById.created;
    expect(await setup.service.discard({ profileId, sessionId: discarded.id })).toEqual({ _tag: "ok", value: undefined });
    const entry = `${setup.sessionsById.reviewed.id}.${formatStamp("2026-07-25T00:00:00.000Z")}`;
    await mkdir(setup.paths.quarantinedSessionDirectory(profileId, entry), { recursive: true });
    await mkdir(setup.paths.quarantinedWorktreeDirectory(profileId, entry), { recursive: true });

    expect(await setup.service.clearLocalData(profileId)).toEqual({ _tag: "ok", value: undefined });
    expect(await exists(setup.paths.sessionFile(profileId, discarded.id))).toBe(false);
    expect(await exists(setup.paths.sessionFile(profileId, setup.sessionsById.reviewed.id))).toBe(false);
    expect(await exists(setup.paths.quarantinedSessionDirectory(profileId, entry))).toBe(false);
    expect(await exists(setup.paths.worktreeDirectory(profileId, setup.sessionsById.running.id))).toBe(true);
  });
});

async function trackSetup(): Promise<Setup> {
  const setup = await setupService();
  roots.push(setup.root);
  return setup;
}

function formatStamp(iso: string): string {
  const date = new Date(iso);
  const yyyy = date.getUTCFullYear().toString().padStart(4, "0");
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = date.getUTCDate().toString().padStart(2, "0");
  const hh = date.getUTCHours().toString().padStart(2, "0");
  const mi = date.getUTCMinutes().toString().padStart(2, "0");
  const ss = date.getUTCSeconds().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}`;
}
