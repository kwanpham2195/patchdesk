import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import {
  parseAbsolutePath,
  parseContentHash,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { createReviewSession, startNextAttempt } from "../../src/domain/review-session";
import { ReviewFailureService } from "../../src/services/review-failure-service";

const roots: string[] = [];
const at = must(parseIsoTimestamp("2026-07-16T00:00:00.000Z"));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ReviewFailureService", () => {
  it("persists a failed attempt and makes the session runnable again", async () => {
    const fixture = await runningReview();

    const failed = await fixture.service.fail({
      profileId: fixture.profileId,
      sessionId: fixture.session.id,
      attemptId: fixture.attempt.id,
      category: "flue",
      message: "The review workflow did not complete.",
    });

    expect(failed).toEqual({ _tag: "ok", value: { failed: true } });
    const storedSession = await fixture.store.load(fixture.profileId, fixture.session.id);
    expect(storedSession).toMatchObject({
      _tag: "ok",
      value: {
        state: { _tag: "ReviewFailed", attemptId: "001", error: { category: "flue", message: "The review workflow did not complete." } },
      },
    });
    expect(storedSession._tag === "ok" && storedSession.value.currentAttemptId).toBeUndefined();
    const storedAttempt = await fixture.store.loadAttempt(fixture.profileId, fixture.session.id, fixture.attempt.id);
    expect(storedAttempt).toMatchObject({
      _tag: "ok",
      value: { state: { _tag: "Failed", error: { category: "flue" } }, completedAt: at },
    });
  });

  it("rejects a failure record for a session that is not running", async () => {
    const fixture = await runningReview();
    const stored = await fixture.store.load(fixture.profileId, fixture.session.id);
    if (stored._tag !== "ok") throw new Error("fixture session missing");
    const { currentAttemptId: _cleared, ...rest } = stored.value;
    void _cleared;
    expect(await fixture.store.save({ ...rest, state: { _tag: "Created" } })).toEqual({ _tag: "ok", value: undefined });

    const result = await fixture.service.fail({
      profileId: fixture.profileId,
      sessionId: fixture.session.id,
      attemptId: fixture.attempt.id,
      category: "flue",
      message: "late failure",
    });

    expect(result).toEqual({ _tag: "err", error: { reason: "not_current" } });
  });
});

function must<T, E>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err"; readonly error: E }): T {
  if (result._tag === "err") throw new Error("Expected parsed fixture");
  return result.value;
}

async function runningReview() {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-failure-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  const profileId = must(parseWorkspaceProfileId("cfw"));
  const key = {
    profileId,
    host: must(parseGitHubHost("github.com")),
    owner: must(parseGitHubOwner("centraldigital")),
    repo: must(parseGitHubRepoName("patchdesk")),
    prNumber: must(parsePullRequestNumber(42)),
    headSha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
  };
  const seed = createReviewSession({
    key,
    pr: { headSha: key.headSha, isDraft: false, isOpen: true },
    patchPath: must(parseAbsolutePath(paths.patchFile(profileId, "placeholder" as never))),
    worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, "placeholder" as never))), headSha: key.headSha },
    createdAt: at,
  });
  const session = {
    ...seed,
    patchPath: must(parseAbsolutePath(paths.patchFile(profileId, seed.id))),
    worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, seed.id))), headSha: key.headSha },
  };
  const started = must(startNextAttempt(session, []));
  const attempt = {
    id: started.attemptId,
    sessionId: started.session.id,
    state: { _tag: "Running" as const, flueRunId: "fixture-run" },
    flueRunId: "fixture-run",
    model: "fixture-model",
    reviewSkillVersion: must(parseContentHash("a".repeat(64))),
    contextHash: must(parseContentHash("b".repeat(64))),
    contextPath: must(parseAbsolutePath(paths.attemptContextFile(profileId, started.session.id, started.attemptId))),
    reviewInputPath: must(parseAbsolutePath(paths.attemptReviewInputFile(profileId, started.session.id, started.attemptId))),
    debugPath: must(parseAbsolutePath(paths.attemptDebugFile(profileId, started.session.id, started.attemptId))),
    startedAt: at,
  };
  const store = new ReviewSessionStore(paths);
  expect(await store.save(started.session)).toEqual({ _tag: "ok", value: undefined });
  expect(await store.saveAttempt(profileId, started.session.id, attempt)).toEqual({ _tag: "ok", value: undefined });
  await writeFile(started.session.patchPath, "diff --git a/src/review.ts b/src/review.ts\n--- a/src/review.ts\n+++ b/src/review.ts\n@@ -12 +12 @@\n-old\n+new\n", "utf8");
  return {
    service: new ReviewFailureService(paths, () => at),
    store,
    profileId,
    session: started.session,
    attempt,
  };
}