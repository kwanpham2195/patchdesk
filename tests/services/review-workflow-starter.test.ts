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
import { ReviewWorkflowStarter } from "../../src/services/review-workflow-starter";

const roots: string[] = [];
const now = must(parseIsoTimestamp("2026-07-17T00:00:00.000Z"));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ReviewWorkflowStarter", () => {
  it("starts only the persisted current attempt with server-owned review artifact paths", async () => {
    const fixture = await runningAttempt();
    const inputs: unknown[] = [];
    const starter = new ReviewWorkflowStarter(fixture.store, {
      async invoke(input) {
        inputs.push(input);
        return { _tag: "ok", value: { runId: "flue-run-42" } };
      },
    });

    await expect(starter.start({ profileId: fixture.profileId, sessionId: fixture.session.id, attemptId: fixture.attempt.id })).resolves.toEqual({
      _tag: "ok",
      value: { runId: "flue-run-42" },
    });
    expect(inputs).toEqual([{
      profileId: fixture.profileId,
      sessionId: fixture.session.id,
      attemptId: fixture.attempt.id,
      contextPath: fixture.attempt.contextPath,
      reviewInputPath: fixture.attempt.reviewInputPath,
      patchPath: fixture.session.patchPath,
      worktreePath: fixture.session.worktree.path,
      scope: { kind: "full" },
    }]);
  });

  it("rejects a non-current attempt without invoking Flue", async () => {
    const fixture = await runningAttempt();
    const starter = new ReviewWorkflowStarter(fixture.store, {
      async invoke() {
        throw new Error("must not invoke");
      },
    });

    await expect(starter.start({ profileId: fixture.profileId, sessionId: fixture.session.id, attemptId: "002" })).resolves.toEqual({
      _tag: "err",
      error: { reason: "not_current" },
    });
  });
});

async function runningAttempt() {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-workflow-starter-"));
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
    createdAt: now,
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
    state: { _tag: "Running" as const, flueRunId: "pending" },
    flueRunId: "pending",
    model: "opencode-go/kimi-k2.7-code",
    reviewSkillVersion: must(parseContentHash("a".repeat(64))),
    contextHash: must(parseContentHash("b".repeat(64))),
    contextPath: must(parseAbsolutePath(paths.attemptContextFile(profileId, started.session.id, started.attemptId))),
    reviewInputPath: must(parseAbsolutePath(paths.attemptReviewInputFile(profileId, started.session.id, started.attemptId))),
    debugPath: must(parseAbsolutePath(paths.attemptDebugFile(profileId, started.session.id, started.attemptId))),
    startedAt: now,
  };
  const store = new ReviewSessionStore(paths);
  await store.save(started.session);
  await store.saveAttempt(profileId, started.session.id, attempt);
  await Promise.all([
    writeFile(session.patchPath, "diff --git a/src/review.ts b/src/review.ts\n", "utf8"),
    writeFile(attempt.contextPath, '{"changedFiles":["src/review.ts"]}', "utf8"),
    writeFile(attempt.reviewInputPath, "Review the fixture.", "utf8"),
  ]);
  return { store, profileId, session: started.session, attempt };
}

function must<T>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" }): T {
  if (result._tag === "err") throw new Error("invalid fixture");
  return result.value;
}
