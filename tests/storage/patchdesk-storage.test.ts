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
import { parseReviewBatch } from "../../src/domain/review-batch";
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
      schemaVersion: 6,
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
        schemaVersion: 5,
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

  it("migrates a v3 attempt-owned batch into a snapshot-owned model batch", async () => {
    const paths = await testPaths();
    const session = sessionFor(paths);
    const parsed = parseStoredReviewSession({
      ...session,
      schemaVersion: 3,
      currentAttemptId: "001",
      batch: { state: { _tag: "Local" } },
      batchContent: {
        sessionId: session.id,
        attemptId: "001",
        state: { _tag: "Local" },
        summaryBody: "Model review.",
        suggestedEvent: "COMMENT",
        items: [{
          _tag: "InlineComment",
          id: "finding-1",
          source: "finding",
          findingId: "finding-1",
          anchor: { path: "src/example.ts", startLine: 7, line: 7, side: "new" },
          body: "Preserve this guard.",
          include: true,
          postability: "postable",
        }],
        receipts: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });

    expect(parsed).toMatchObject({
      _tag: "ok",
      value: {
        schemaVersion: 5,
        batchContent: {
          items: [{ provenance: { _tag: "model", attemptId: "001" } }],
        },
      },
    });
  });

  it("migrates repeated v2 finding comments with deterministic unique item IDs", async () => {
    const paths = await testPaths();
    const session = sessionFor(paths);
    const repeatedComment = {
      findingId: "finding-1",
      include: true,
      originalSuggestedBody: "Original suggestion.",
      body: "Keep the stored local edit.",
      path: "src/example.ts",
      line: 7,
      lineEnd: 8,
      diffSide: "new",
      postability: "postable",
    };

    const migrated = parseStoredReviewSession({
      ...session,
      schemaVersion: 2,
      currentAttemptId: "001",
      draft: { state: { _tag: "LocalDraft" } },
      draftContent: {
        sessionId: session.id,
        attemptId: "001",
        state: { _tag: "LocalDraft" },
        summaryBody: "Two comments for one finding.",
        suggestedEvent: "COMMENT",
        comments: [
          repeatedComment,
          {
            ...repeatedComment,
            body: "Keep this second local edit too.",
            line: 12,
            lineEnd: 12,
          },
        ],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });

    expect(migrated).toMatchObject({ _tag: "ok" });
    if (migrated._tag === "ok") {
      expect(migrated.value.batchContent?.items.map((item) => item.id)).toEqual([
        "finding-1",
        "finding-1-2",
      ]);
    }
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

  it.each([
    {
      name: "missing session submission receipt",
      submittedReview: undefined,
    },
    {
      name: "mismatched review ID",
      submittedReview: {
        reviewId: "review-2",
        event: "COMMENT",
        submittedAt: timestamp,
      },
    },
    {
      name: "mismatched review event",
      submittedReview: {
        reviewId: "review-1",
        event: "APPROVE",
        submittedAt: timestamp,
      },
    },
  ] as const)("rejects a submitted batch with $name", async ({ submittedReview }) => {
    const paths = await testPaths();
    const session = submittedBatchSessionFor(paths);

    expect(parseStoredReviewSession({
      ...session,
      submittedReview,
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
        appearance: "dark",
        diffTheme: { light: "github-light", dark: "github-dark" },
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

  it("loads legacy global config without retaining recent PRs and persists only current settings", async () => {
    const paths = await testPaths();
    const profiles = new ProfileStore(paths);
    await mkdir(paths.configDirectory(), { recursive: true });
    await writeFile(
      paths.configFile(),
      JSON.stringify({ lastSelectedProfileId: "cfw", recentPrs: ["centraldigital/patchdesk#42"] }),
    );

    expect(await profiles.loadConfig()).toEqual({
      _tag: "ok",
      value: { lastSelectedProfileId: "cfw" },
    });
    expect(await profiles.saveConfig({
      lastSelectedProfileId: "cfw",
      appearance: "light",
      diffTheme: { light: "github-light", dark: "github-dark" },
    })).toEqual({ _tag: "ok", value: undefined });
    await expect(readFile(paths.configFile(), "utf8")).resolves.toBe(
      '{"lastSelectedProfileId":"cfw","appearance":"light","diffTheme":{"light":"github-light","dark":"github-dark"}}\n',
    );
  });

  it("rejects unknown fields in a persisted current global config", async () => {
    const paths = await testPaths();
    const profiles = new ProfileStore(paths);
    await mkdir(paths.configDirectory(), { recursive: true });
    await writeFile(
      paths.configFile(),
      JSON.stringify({ appearance: "dark", unknown: true }),
    );

    expect(await profiles.loadConfig()).toEqual({
      _tag: "err",
      error: {
        _tag: "StorageFailure",
        operation: "read",
        reason: "invalid_stored_value",
      },
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

  it("accepts an idle Discarded state without an attempt id", () => {
    const paths = PatchdeskPaths.forTest("/tmp/parse-only");
    const session = sessionFor(paths);

    const parsed = parseStoredReviewSession({
      ...session,
      state: { _tag: "Discarded" },
    });
    expect(parsed).toMatchObject({
      _tag: "ok",
      value: { state: { _tag: "Discarded" } },
    });
    if (parsed._tag === "ok") {
      expect(
        (parsed.value.state as { readonly attemptId?: unknown }).attemptId,
      ).toBeUndefined();
    }
  });

  it("excludes a quarantined entry from listSessions and reports a stored Running state", async () => {
    const paths = await testPaths();
    const sessions = new ReviewSessionStore(paths);
    const session = sessionFor(paths);
    expect((await sessions.save(session))._tag).toBe("ok");

    const quarantinedEntry = `${session.id}.20260725T000000`;
    const quarantinedDirectory = paths.quarantinedSessionDirectory(
      profile.id,
      quarantinedEntry,
    );
    await mkdir(quarantinedDirectory, { recursive: true });
    await writeFile(
      join(quarantinedDirectory, "session.json"),
      JSON.stringify({ ...session, state: { _tag: "Discarded" } }),
      "utf8",
    );

    const listed = await sessions.listSessions(profile.id);
    expect(listed).toMatchObject({
      _tag: "ok",
      value: [{ id: session.id }],
    });

    const running = await sessions.isRecordedRunning(profile.id, session.id);
    expect(running).toEqual({ _tag: "ok", value: false });
  });

  it("isRecordedRunning still returns true for a deliberately invalid Running record", async () => {
    const paths = await testPaths();
    const sessions = new ReviewSessionStore(paths);
    const session = sessionFor(paths);
    const sessionId = session.id;
    await mkdir(paths.sessionDirectory(profile.id, sessionId), { recursive: true });
    // A persisted envelope that the strict parser would reject, but that still
    // claims Running; the safety guard must honor it.
    await writeFile(
      paths.sessionFile(profile.id, sessionId),
      JSON.stringify({
        schemaVersion: 3,
        id: sessionId,
        key: { ...session.key, profileId: profile.id },
        pr: { headSha: session.key.headSha, isDraft: false, isOpen: true },
        patchPath: "not-an-absolute-path",
        worktree: { path: "/not-absolute", headSha: session.key.headSha },
        state: { _tag: "Running", attemptId: "001" },
        currentAttemptId: "001",
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
      }),
      "utf8",
    );

    const running = await sessions.isRecordedRunning(profile.id, sessionId);
    expect(running).toEqual({ _tag: "ok", value: true });
  });
});

function submittedBatchSessionFor(paths: PatchdeskPaths): ReviewSession {
  const session = sessionFor(paths);
  const batchContent = mustParse(parseReviewBatch({
    sessionId: session.id,
    attemptId,
    state: {
      _tag: "Submitted",
      reviewId: "review-1",
      event: "COMMENT",
    },
    summaryBody: "Submitted review.",
    suggestedEvent: "COMMENT",
    items: [{
      _tag: "InlineComment",
      id: "finding-1",
      source: "finding",
      findingId: "finding-1",
      anchor: {
        path: "src/example.ts",
        startLine: 7,
        line: 7,
        side: "new",
      },
      body: "Keep this branch explicit.",
      include: true,
      postability: "postable",
    }],
    receipts: [{
      _tag: "PendingReviewCreated",
      reviewId: "review-1",
      itemIds: ["finding-1"],
    }],
    createdAt: timestamp,
    updatedAt: timestamp,
  }));

  return {
    ...session,
    currentAttemptId: attemptId,
    state: { _tag: "ReviewCompleted", attemptId },
    batch: { state: batchContent.state },
    batchContent,
    submittedReview: {
      reviewId: "review-1",
      event: "COMMENT",
      submittedAt: timestamp,
    },
  };
}
