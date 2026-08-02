import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { createEmptyReviewBatch } from "../../src/domain/review-batch";
import { ReviewCompletionService } from "../../src/services/review-completion-service";

const roots: string[] = [];
const at = must(parseIsoTimestamp("2026-07-16T00:00:00.000Z"));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ReviewCompletionService", () => {
  it("validates and persists a completed result without mutating the local draft", async () => {
    const fixture = await runningReview();
    const completed = await fixture.service.complete({
      profileId: fixture.profileId,
      sessionId: fixture.session.id,
      attemptId: fixture.attempt.id,
      result: result(),
    });

    expect(completed).toMatchObject({
      _tag: "ok",
      value: {
        session: { state: { _tag: "ReviewCompleted", attemptId: "001" } },
      },
    });
    const savedSession = await fixture.store.load(fixture.profileId, fixture.session.id);
    expect(savedSession).toMatchObject({ _tag: "ok", value: { visibleResult: { changeSummary: "Protect the write boundary" } } });
    if (savedSession._tag === "ok") expect(savedSession.value.batchContent).toBeUndefined();
    expect(await fixture.store.loadAttempt(fixture.profileId, fixture.session.id, fixture.attempt.id)).toMatchObject({
      _tag: "ok",
      value: { state: { _tag: "Completed" } },
    });
    expect(JSON.parse(await readFile(fixture.resultPath, "utf8"))).toMatchObject({ changeSummary: "Protect the write boundary" });
  });

  it("replaces only model items when an optional AI run completes", async () => {
    const fixture = await runningReview();
    const initial = createEmptyReviewBatch({
      sessionId: fixture.session.id,
      createdAt: at,
    });
    const sessionWithHumanItem = {
      ...fixture.session,
      batch: { state: initial.state },
      batchContent: {
        ...initial,
        items: [{
          _tag: "InlineComment" as const,
          id: "manual-1" as never,
          provenance: { _tag: "human" as const },
          source: "manual" as const,
          anchor: { path: "src/review.ts" as never, startLine: 12, line: 12, side: "new" as const },
          body: "Keep this local observation.",
          include: true,
          postability: "postable" as const,
        }],
      },
    };
    expect(await fixture.store.save(sessionWithHumanItem)).toEqual({ _tag: "ok", value: undefined });

    const completed = await fixture.service.complete({
      profileId: fixture.profileId,
      sessionId: fixture.session.id,
      attemptId: fixture.attempt.id,
      result: result(),
    });

    expect(completed).toMatchObject({
      _tag: "ok",
      value: {
        session: {
          batchContent: {
            items: [{ id: "manual-1", provenance: { _tag: "human" } }],
          },
        },
      },
    });
  });

  it("rejects invalid, raw, or credential-like model output without creating a result artifact", async () => {
    const fixture = await runningReview();
    for (const invalid of [
      { ...result(), findings: [{ ...result().findings[0], mappingStatus: "mapped" }] },
      { ...result(), rawNotes: "hidden chain of thought" },
      { ...result(), summary: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789" },
    ]) {
      expect(await fixture.service.complete({ profileId: fixture.profileId, sessionId: fixture.session.id, attemptId: fixture.attempt.id, result: invalid })).toEqual({ _tag: "err", error: { reason: "invalid_result" } });
    }
    await expect(access(fixture.resultPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects prior-finding assessments on a full review", async () => {
    const fixture = await runningReview();
    expect(await fixture.service.complete({
      profileId: fixture.profileId,
      sessionId: fixture.session.id,
      attemptId: fixture.attempt.id,
      result: { ...result(), priorFindingAssessments: [{ priorFindingToken: "a".repeat(64), disposition: "resolved" as const, explanation: "Unsupported for a full review." }] },
    })).toEqual({ _tag: "err", error: { reason: "invalid_result" } });
  });

  it("projects incremental lifecycle evidence and excludes previously submitted comments by default", async () => {
    const fixture = await runningReview();
    const scope = {
      kind: "incremental" as const,
      baseSessionId: fixture.session.id,
      baseHeadSha: fixture.session.key.headSha,
      headSha: fixture.session.key.headSha,
      comparisonPatchPath: must(parseAbsolutePath(fixture.paths.comparisonPatchFile(fixture.profileId, fixture.session.id))),
      comparisonMetadataPath: must(parseAbsolutePath(fixture.paths.comparisonMetadataFile(fixture.profileId, fixture.session.id))),
      previousFindingsPath: must(parseAbsolutePath(fixture.paths.previousFindingsFile(fixture.profileId, fixture.session.id))),
      lifecyclePath: must(parseAbsolutePath(fixture.paths.findingLifecycleFile(fixture.profileId, fixture.session.id))),
    };
    await writeFile(scope.comparisonPatchPath, "diff --git a/src/review.ts b/src/review.ts\n--- a/src/review.ts\n+++ b/src/review.ts\n@@ -12 +12 @@\n-old\n+new\n", "utf8");
    await writeFile(scope.comparisonMetadataPath, JSON.stringify({ schemaVersion: 1, baseSessionId: scope.baseSessionId, baseHeadSha: scope.baseHeadSha, headSha: scope.headSha, ancestry: "fast_forward", source: "local_git", completeness: "complete", commits: [], files: [{ path: "src/review.ts", status: "modified", additions: 1, deletions: 1, binary: false, textPatchAvailable: true }], additions: 1, deletions: 1, createdAt: at }), "utf8");
    await writeFile(scope.previousFindingsPath, JSON.stringify([{ token: "a".repeat(64), findingId: "mapped", severity: "P1", title: "Protect the guard", explanation: "Keep the current-head check.", file: "src/review.ts", wasSubmitted: true }]), "utf8");
    expect(await fixture.store.save({ ...fixture.session, scope })).toEqual({ _tag: "ok", value: undefined });

    const completed = await fixture.service.complete({
      profileId: fixture.profileId,
      sessionId: fixture.session.id,
      attemptId: fixture.attempt.id,
      result: {
        ...result(),
        priorFindingAssessments: [{ priorFindingToken: "a".repeat(64), disposition: "still_present", explanation: "The guard remains absent.", currentFindingId: "mapped" }],
      },
    });

    expect(completed).toMatchObject({
      _tag: "ok",
      value: { session: {} },
    });
    expect(JSON.parse(await readFile(scope.lifecyclePath, "utf8"))).toMatchObject([{ status: "still_present", draftPostability: "already_reported" }]);
  });
});

async function runningReview() {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-completion-"));
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
    service: new ReviewCompletionService(paths, () => at),
    store,
    profileId,
    session: started.session,
    attempt,
    resultPath: paths.attemptResultFile(profileId, started.session.id, started.attemptId),
    paths,
  };
}

function result() {
  return {
    changeSummary: "Protect the write boundary",
    verdict: "request_changes",
    summary: "One mapped finding needs a local draft.",
    findings: [{ id: "mapped", severity: "P1", title: "Protect the guard", file: "src/review.ts", lineStart: 12, diffSide: "new", explanation: "Keep the current-head check.", confidence: "high" }],
    validationPlan: ["pnpm test"],
    assumptions: [],
  };
}

function must<T>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" }): T {
  if (result._tag === "err") throw new Error("invalid fixture");
  return result.value;
}
