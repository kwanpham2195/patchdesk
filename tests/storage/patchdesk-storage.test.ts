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

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import {
  parseStoredReviewSession,
  ReviewSessionStore,
} from "../../src/adapters/storage/review-session-store";
import {
  createReviewSessionId,
  parseAbsolutePath,
  parseContentHash,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseReviewAttemptId,
} from "../../src/domain/ids";
import {
  createReviewSession,
  type ReviewSession,
} from "../../src/domain/review-session";
import { parsePatchdeskConfig } from "../../src/domain/contracts";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
  );
});

function mustParse<T, E>(
  result:
    | { readonly _tag: "ok"; readonly value: T }
    | { readonly _tag: "err"; readonly error: E },
): T {
  if (result._tag === "err") {
    throw new Error("Expected fixture value to parse");
  }

  return result.value;
}

async function testPaths(): Promise<PatchdeskPaths> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-storage-"));
  temporaryDirectories.push(root);
  return PatchdeskPaths.forTest(root);
}

const profile = mustParse(
  parseWorkspaceProfileConfig({
    id: "cfw",
    label: "CFW",
    githubHost: "github.com",
    ghAccount: "fixture-account",
    ownerFilters: ["centraldigital"],
    workspaceRoots: ["/workspace/cfw"],
    rulePaths: ["/workspace/cfw/AGENTS.md"],
    repos: [{ host: "github.com", owner: "centraldigital", repo: "patchdesk" }],
  }),
);

const timestamp = mustParse(parseIsoTimestamp("2026-07-16T00:00:00.000Z"));
const owner = mustParse(parseGitHubOwner("centraldigital"));
const repo = mustParse(parseGitHubRepoName("patchdesk"));
const prNumber = mustParse(parsePullRequestNumber(42));
const headSha = mustParse(
  parseGitSha("abcdef1234567890abcdef1234567890abcdef12"),
);
const attemptId = mustParse(parseReviewAttemptId("001"));

function sessionFor(paths: PatchdeskPaths): ReviewSession {
  const key = {
    profileId: profile.id,
    host: profile.githubHost,
    owner,
    repo,
    prNumber,
    headSha,
  };
  const sessionId = createReviewSessionId(key);
  return createReviewSession({
    key,
    pr: { headSha, isDraft: false, isOpen: true },
    patchPath: mustParse(
      parseAbsolutePath(paths.patchFile(profile.id, sessionId)),
    ),
    worktree: {
      path: mustParse(
        parseAbsolutePath(paths.worktreeDirectory(profile.id, sessionId)),
      ),
      headSha,
    },
    createdAt: timestamp,
  });
}

describe("Patchdesk storage", () => {
  it("constructs the complete deterministic artifact layout below a test-only root", async () => {
    const paths = await testPaths();
    const session = sessionFor(paths);

    expect(paths.configFile()).toBe(
      join(paths.configDirectory(), "config.json"),
    );
    expect(paths.profileFile(profile.id)).toBe(
      join(paths.configDirectory(), "profiles", "cfw.json"),
    );
    expect(paths.sessionDirectory(profile.id, session.id)).toBe(
      join(paths.dataDirectory(), "profiles", "cfw", "reviews", session.id),
    );
    expect(paths.attemptResultFile(profile.id, session.id, attemptId)).toBe(
      join(
        paths.sessionDirectory(profile.id, session.id),
        "attempts",
        "001",
        "result.json",
      ),
    );
    expect(paths.worktreeDirectory(profile.id, session.id)).toBe(
      join(
        paths.cacheDirectory(),
        "profiles",
        "cfw",
        "review-worktrees",
        session.id,
      ),
    );
    expect(paths.comparisonPatchFile(profile.id, session.id)).toBe(
      join(paths.sessionDirectory(profile.id, session.id), "comparison.diff"),
    );
    expect(paths.comparisonMetadataFile(profile.id, session.id)).toBe(
      join(paths.sessionDirectory(profile.id, session.id), "comparison.json"),
    );
    expect(paths.previousFindingsFile(profile.id, session.id)).toBe(
      join(paths.sessionDirectory(profile.id, session.id), "previous-findings.json"),
    );
    expect(paths.findingLifecycleFile(profile.id, session.id)).toBe(
      join(paths.sessionDirectory(profile.id, session.id), "finding-lifecycle.json"),
    );
    expect(paths.inboxCacheFile(profile.id)).toBe(
      join(paths.cacheDirectory(), "profiles", "cfw", "inbox-v1.json"),
    );
  });

  it("rejects unsupported stored session versions", async () => {
    const paths = await testPaths();
    const session = sessionFor(paths);
    expect(parseStoredReviewSession({
      ...session,
      schemaVersion: 1,
      scope: undefined,
    })).toMatchObject({
      _tag: "err",
      error: { _tag: "StorageFailure", reason: "invalid_stored_value" },
    });
    expect(parseStoredReviewSession({
      ...session,
      schemaVersion: 4,
    })).toMatchObject({
      _tag: "err",
      error: { _tag: "StorageFailure", reason: "invalid_stored_value" },
    });
  });

  it("migrates a valid v2 local draft to its v3 local batch", async () => {
    const paths = await testPaths();
    const session = sessionFor(paths);
    const legacy = {
      ...session,
      schemaVersion: 2,
      currentAttemptId: "001",
      draft: { state: { _tag: "LocalDraft" } },
      draftContent: {
        sessionId: session.id,
        attemptId: "001",
        state: { _tag: "LocalDraft" },
        summaryBody: "One local draft.",
        suggestedEvent: "COMMENT",
        comments: [{
          findingId: "finding-1",
          include: true,
          originalSuggestedBody: "Original suggestion.",
          body: "Keep the stored local edit.",
          path: "src/example.ts",
          line: 7,
          lineEnd: 8,
          diffSide: "new",
          postability: "postable",
        }],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };

    expect(parseStoredReviewSession(legacy)).toMatchObject({
      _tag: "ok",
      value: {
        schemaVersion: 3,
        batch: { state: { _tag: "Local" } },
        batchContent: {
          state: { _tag: "Local" },
          summaryBody: "One local draft.",
          suggestedEvent: "COMMENT",
          items: [{
            _tag: "InlineComment",
            id: "finding-1",
            source: "finding",
            findingId: "finding-1",
            anchor: {
              path: "src/example.ts",
              startLine: 7,
              line: 8,
              side: "new",
            },
            body: "Keep the stored local edit.",
            include: true,
            postability: "postable",
          }],
          receipts: [],
        },
      },
    });
  });

  it("rejects malformed v2 draft migration records", async () => {
    const paths = await testPaths();
    const session = sessionFor(paths);

    expect(parseStoredReviewSession({
      ...session,
      schemaVersion: 2,
      draft: { state: { _tag: "LocalDraft" } },
      draftContent: { state: { _tag: "LocalDraft" } },
    })).toMatchObject({
      _tag: "err",
      error: { _tag: "StorageFailure", reason: "invalid_stored_value" },
    });
  });

  it("round-trips profiles, sessions, and attempts with atomic file replacement", async () => {
    const paths = await testPaths();
    const profiles = new ProfileStore(paths);
    const sessions = new ReviewSessionStore(paths);
    const config = mustParse(
      parsePatchdeskConfig({
        lastSelectedProfileId: "cfw",
        recentPrs: ["centraldigital/patchdesk#42"],
      }),
    );
    expect(await profiles.saveConfig(config)).toEqual({
      _tag: "ok",
      value: undefined,
    });
    expect(await profiles.loadConfig()).toEqual({ _tag: "ok", value: config });
    const profileSaved = await profiles.save(profile);
    expect(profileSaved).toEqual({ _tag: "ok", value: undefined });
    expect(await profiles.load(profile.id)).toEqual({
      _tag: "ok",
      value: profile,
    });
    const updatedProfile = { ...profile, label: "Updated CFW" };
    expect(await profiles.save(updatedProfile)).toEqual({
      _tag: "ok",
      value: undefined,
    });
    expect(await profiles.load(profile.id)).toEqual({
      _tag: "ok",
      value: updatedProfile,
    });

    const session = sessionFor(paths);
    const attempt = {
      id: attemptId,
      sessionId: session.id,
      state: { _tag: "Running" as const, flueRunId: "run-fixture" },
      flueRunId: "run-fixture",
      model: "fixture-model",
      reasoning: "medium",
      reviewSkillVersion: mustParse(parseContentHash("a".repeat(64))),
      contextHash: mustParse(parseContentHash("b".repeat(64))),
      contextPath: mustParse(
        parseAbsolutePath(
          paths.attemptContextFile(profile.id, session.id, attemptId),
        ),
      ),
      reviewInputPath: mustParse(
        parseAbsolutePath(
          paths.attemptReviewInputFile(profile.id, session.id, attemptId),
        ),
      ),
      debugPath: mustParse(
        parseAbsolutePath(
          paths.attemptDebugFile(profile.id, session.id, attemptId),
        ),
      ),
      startedAt: timestamp,
    };

    expect(await sessions.save(session)).toEqual({
      _tag: "ok",
      value: undefined,
    });
    expect(await sessions.load(profile.id, session.id)).toEqual({
      _tag: "ok",
      value: session,
    });
    expect(await sessions.saveAttempt(profile.id, session.id, attempt)).toEqual(
      { _tag: "ok", value: undefined },
    );
    expect(
      await sessions.loadAttempt(profile.id, session.id, attempt.id),
    ).toEqual({ _tag: "ok", value: attempt });
  });

  it("returns typed failures for corrupt JSON and refuses token-like or arbitrary debug data", async () => {
    const paths = await testPaths();
    const profiles = new ProfileStore(paths);
    const sessions = new ReviewSessionStore(paths);
    await mkdir(join(paths.configDirectory(), "profiles"), { recursive: true });
    await writeFile(paths.profileFile(profile.id), "{not json", "utf8");
    expect(await profiles.load(profile.id)).toMatchObject({
      _tag: "err",
      error: { _tag: "StorageFailure", reason: "invalid_json" },
    });

    const sessionId = sessionFor(paths).id;
    expect(
      await sessions.appendDebug(profile.id, sessionId, {
        at: "2026-07-16T00:00:00.000Z",
        event: "attempt_started",
        token: "never-persist-this",
      }),
    ).toMatchObject({
      _tag: "err",
      error: { _tag: "StorageFailure", reason: "sensitive_value" },
    });
    expect(
      await sessions.appendDebug(profile.id, sessionId, {
        at: "2026-07-16T00:00:00.000Z",
        event: "attempt_started",
        contents: "arbitrary file contents must not be persisted",
      }),
    ).toMatchObject({
      _tag: "err",
      error: { _tag: "StorageFailure", reason: "invalid_stored_value" },
    });
  });

  it("refuses token-like profile and session inputs before creating artifacts", async () => {
    const paths = await testPaths();
    const profiles = new ProfileStore(paths);
    const sessions = new ReviewSessionStore(paths);
    const session = sessionFor(paths);

    expect(
      await profiles.save({ ...profile, accessToken: "fixture-value" }),
    ).toMatchObject({
      _tag: "err",
      error: {
        _tag: "StorageFailure",
        operation: "write",
        reason: "invalid_stored_value",
      },
    });
    expect(
      await sessions.save({ ...session, accessToken: "fixture-value" }),
    ).toMatchObject({
      _tag: "err",
      error: {
        _tag: "StorageFailure",
        operation: "write",
        reason: "invalid_stored_value",
      },
    });
    await expect(access(paths.profileFile(profile.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(paths.sessionFile(profile.id, session.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a GitHub PAT even when it appears in an otherwise benign persisted field", async () => {
    const paths = await testPaths();
    const profiles = new ProfileStore(paths);

    expect(
      await profiles.save({
        ...profile,
        label: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789",
      }),
    ).toMatchObject({
      _tag: "err",
      error: { _tag: "StorageFailure", reason: "sensitive_value" },
    });
    await expect(access(paths.profileFile(profile.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a GitHub PAT when loading a pre-existing profile artifact", async () => {
    const paths = await testPaths();
    const profiles = new ProfileStore(paths);
    await mkdir(dirname(paths.profileFile(profile.id)), { recursive: true });
    await writeFile(
      paths.profileFile(profile.id),
      JSON.stringify({
        ...profile,
        label: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789",
      }),
      "utf8",
    );

    expect(await profiles.load(profile.id)).toMatchObject({
      _tag: "err",
      error: { _tag: "StorageFailure", operation: "read", reason: "sensitive_value" },
    });
  });

  it("refuses raw model notes from persisted visible review results", async () => {
    const paths = await testPaths();
    const sessions = new ReviewSessionStore(paths);
    const session = sessionFor(paths);
    const withRawNotes = {
      ...session,
      visibleResult: {
        changeSummary: "Adds persistence.",
        verdict: "comment",
        summary: "One finding.",
        findings: [],
        validationPlan: [],
        assumptions: [],
        rawNotes:
          "diff --git a/private-file b/private-file\nsecret file contents",
      },
    };

    expect(await sessions.save(withRawNotes)).toMatchObject({
      _tag: "err",
      error: {
        _tag: "StorageFailure",
        operation: "write",
        reason: "invalid_stored_value",
      },
    });
    await mkdir(paths.sessionDirectory(profile.id, session.id), {
      recursive: true,
    });
    await writeFile(
      paths.sessionFile(profile.id, session.id),
      JSON.stringify(withRawNotes),
      "utf8",
    );
    expect(await sessions.load(profile.id, session.id)).toMatchObject({
      _tag: "err",
      error: {
        _tag: "StorageFailure",
        operation: "read",
        reason: "invalid_stored_value",
      },
    });
  });

  it("appends non-authoritative safe debug events as JSON lines", async () => {
    const paths = await testPaths();
    const sessions = new ReviewSessionStore(paths);
    const sessionId = sessionFor(paths).id;
    const appended = await sessions.appendDebug(profile.id, sessionId, {
      at: "2026-07-16T00:00:00.000Z",
      event: "attempt_started",
      attemptId: "001",
    });

    expect(appended).toEqual({ _tag: "ok", value: undefined });
    expect(
      await readFile(paths.debugTraceFile(profile.id, sessionId), "utf8"),
    ).toBe(
      '{"at":"2026-07-16T00:00:00.000Z","event":"attempt_started","attemptId":"001"}\n',
    );
  });
});
