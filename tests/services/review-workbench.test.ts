import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import {
  createReviewBatch,
  discardWorkbenchAttempt,
  draftWriteBlocker,
  recoverOrphanedWorkbenchAttempt,
} from "../../src/services/review-workbench";
import { ReviewWorkbenchController } from "../../src/services/review-workbench-controller";
import { ReviewSessionPreparation } from "../../src/services/review-session-preparation";
import { ReviewWorkbenchProjectionService } from "../../src/services/review-workbench-projection";
import { ReviewWorktreeService } from "../../src/services/review-worktree-service";
import { ReviewContextService } from "../../src/services/review-context-service";
import type { ReviewAttempt } from "../../src/domain/review-attempt";
import type { ReviewResult } from "../../src/domain/review-result";
import type { ReviewSession } from "../../src/domain/review-session";

function must<T>(value: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" }): T {
  if (value._tag === "err") throw new Error("Invalid fixture");
  return value.value;
}

const session = {
  id: "github.com__centraldigital__patchdesk__pr-1__sha-abcdef12__0123456789ab",
  key: { headSha: "abcdef1234567890abcdef1234567890abcdef12" },
  state: { _tag: "ReviewCompleted", attemptId: "001" },
  currentAttemptId: "001",
} as unknown as ReviewSession;

const attempt = {
  id: "001",
  sessionId: session.id,
  state: { _tag: "Completed", resultPath: "/tmp/result.json" },
} as unknown as ReviewAttempt;

const result = {
  changeSummary: "Adds local review drafts.",
  verdict: "comment",
  summary: "One mapped finding and one unmapped finding.",
  findings: [
    {
      id: "mapped-finding",
      severity: "P1",
      title: "Mapped issue",
      file: "src/review.ts",
      lineStart: 12,
      diffSide: "new",
      explanation: "The mapped explanation.",
      suggestedComment: "Use the safe path.",
      confidence: "high",
      mappingStatus: "mapped",
    },
    {
      id: "unmapped-finding",
      severity: "P2",
      title: "Unmapped issue",
      explanation: "This needs human placement.",
      confidence: "medium",
      mappingStatus: "unmapped",
    },
  ],
  validationPlan: ["pnpm test"],
  assumptions: [],
} as unknown as ReviewResult;

describe("review workbench", () => {
  it("prepares a persisted session without starting a model attempt when opening a new direct review", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-workbench-"));
    try {
      const paths = PatchdeskPaths.forTest(root);
      const profile = must(parseWorkspaceProfileConfig({
        id: "cfw",
        label: "CFW",
        githubHost: "github.com",
        ghAccount: "fixture",
        ownerFilters: [],
        workspaceRoots: [],
        rulePaths: [],
        repos: [],
      }));
      const github = new FakeGitHubAdapter({
        pullRequest: {
          ref: { host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 42 },
          title: "Fixture review",
          author: "fixture",
          headBranch: "feature/review",
          baseBranch: "sit",
          baseSha: "0123456789abcdef0123456789abcdef01234567",
          headSha: "abcdef1234567890abcdef1234567890abcdef12",
          isDraft: false,
          isOpen: true,
          reviewState: "none",
          mergeability: "unknown",
          labels: [],
          updatedAt: "2026-07-16T00:00:00.000Z",
        } as never,
        comments: { threads: [] },
        checks: { overall: "passing", checks: [] },
        diff: "+++ b/src/review.ts\n+new line\n",
      });
      await new ProfileStore(paths).save(profile);
      const controller = new ReviewWorkbenchController(
        new ReviewSessionPreparation({
          profiles: new ProfileStore(paths),
          sessions: new ReviewSessionStore(paths),
          github,
          paths,
          now: () => "2026-07-16T00:00:00.000Z" as never,
          worktrees: new ReviewWorktreeService(paths, { async run() { return { _tag: "err" as const, error: { _tag: "GitReadFailed" as const } }; } }),
          context: new ReviewContextService(),
        }),
        new ReviewWorkbenchProjectionService(
          new ProfileStore(paths),
          new ReviewSessionStore(paths),
          github,
          () => "2026-07-16T00:00:00.000Z" as never,
        ),
      );

      const opened = await controller.open({
        profileId: "cfw",
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
      });

      expect(opened).toMatchObject({
        _tag: "ok",
        value: { state: "review_started" },
      });
      if (opened._tag === "err") return;
      // The projection is renderer-safe: no patch, worktree, or artifact paths cross.
      const serialized = JSON.stringify(opened.value);
      expect(serialized).not.toContain("patchPath");
      expect(serialized).not.toContain("worktree");
      expect(serialized).not.toContain(root);
      const patchPath = paths.patchFile(profile.id, opened.value.session.id);
      expect(await readFile(patchPath, "utf8")).toContain("src/review.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates included batch items only for mapped findings and keeps repository findings visible", () => {
    const batch = createReviewBatch({
      session,
      attempt,
      result,
      createdAt: "2026-07-16T00:02:00.000Z" as never,
    });

    expect(batch).toMatchObject({
      _tag: "ok",
      value: {
        batch: {
          state: { _tag: "Local" },
          items: [
            {
              _tag: "InlineComment",
              id: "mapped-finding",
              source: "finding",
              findingId: "mapped-finding",
              anchor: {
                path: "src/review.ts",
                startLine: 12,
                line: 12,
                side: "new",
              },
              include: true,
              postability: "postable",
              body: "Use the safe path.",
            },
          ],
        },
      },
    });
    if (batch._tag === "ok") {
      expect(batch.value.repositoryFindings.map((finding) => finding.id)).toEqual([
        "unmapped-finding",
      ]);
    }
  });

  it("blocks every future write path when the session head is stale", () => {
    expect(draftWriteBlocker(session, session.key.headSha)).toBeUndefined();
    expect(draftWriteBlocker(session, "fedcba9876543210fedcba9876543210fedcba98" as never)).toEqual({
      _tag: "StaleHeadBlocksWrite",
    });
    expect(draftWriteBlocker({ ...session, state: { _tag: "Stale", reason: "head_changed" } }, session.key.headSha)).toEqual({
      _tag: "StaleHeadBlocksWrite",
    });
  });

  it("discards a starting attempt locally without signaling an external workflow", () => {
    const running = {
      ...session,
      state: { _tag: "Running", attemptId: "001" },
    } as ReviewSession;
    const discarded = discardWorkbenchAttempt({
      session: running,
      attempt: { ...attempt, state: { _tag: "Starting" } } as ReviewAttempt,
      discardedAt: "2026-07-16T00:03:00.000Z" as never,
    });

    expect(discarded).toMatchObject({
      _tag: "ok",
      value: {
        session: { state: { _tag: "Discarded", attemptId: "001" } },
        attempt: { state: { _tag: "Discarded" } },
      },
    });
  });

  it("marks an orphaned starting attempt stale and failed after Patchdesk restarts", () => {
    const running = {
      ...session,
      state: { _tag: "Running", attemptId: "001" },
    } as ReviewSession;
    const recovered = recoverOrphanedWorkbenchAttempt({
      session: running,
      attempt: { ...attempt, state: { _tag: "Starting" } } as ReviewAttempt,
      recoveredAt: "2026-07-16T00:04:00.000Z" as never,
    });

    expect(recovered).toMatchObject({
      _tag: "ok",
      value: {
        session: { state: { _tag: "Stale", reason: "orphaned_run" } },
        attempt: { state: { _tag: "Failed", error: { category: "flue" } } },
      },
    });
  });
});
