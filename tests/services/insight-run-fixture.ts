import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { InsightStore } from "../../src/adapters/storage/insight-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { ReviewStore } from "../../src/adapters/storage/review-store";
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
import type { InsightType } from "../../src/domain/insight-record";
import { createReview } from "../../src/domain/review";
import {
  createLocalReviewSession,
  createReviewSession,
  type ReviewSession,
} from "../../src/domain/review-session";
import type { LocalReviewSource } from "../../src/domain/review-source";
import type { WorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { ok, type Result } from "../../src/domain/result";
import type { DesktopNotifier } from "../../src/services/desktop-notifier";
import type { BriefReachComputer } from "../../src/services/brief-reach-service";
import { CommandRunner } from "../../src/adapters/github/command-runner";
import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import { createReadOnlyGitExecutor } from "../../src/main/local-api-stores";
import type { InsightProviderCatalog } from "../../src/services/insight-provider-catalog";
import { ReviewContextPackService } from "../../src/services/review-context-pack-service";
import { ReviewContextService } from "../../src/services/review-context-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import {
  InsightRunCoordinator,
  type InsightInvoker,
  type InsightRunResponse,
} from "../../src/services/insight-run-coordinator";

const roots: string[] = [];
export const must = <T>(value: Result<T, unknown>): T => {
  if (value._tag === "ok") return value.value;
  throw new Error("fixture value is invalid");
};
export const profileId = must(parseWorkspaceProfileId("acme"));
export const headSha = must(parseGitSha("a".repeat(40)));
export const baseSha = must(parseGitSha("b".repeat(40)));
export const now = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
export const analysisResult = {
  changeSummary: "Adds one guarded change.",
  verdict: "approve" as const,
  summary: "Check the guard.",
  findings: [],
  validationPlan: [],
  assumptions: [],
};

/** Each importing suite registers this in its own `afterEach`. */
export async function cleanupRoots(): Promise<void> {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
}

/**
 * The context pack the Insight run builds on demand, over a real
 * `ReviewContextService` and a real temp directory, so a test can assert
 * what landed on disk. `commentReads` and `checkReads` count the GitHub reads
 * a build costs: one build reads each once, a reused pack reads not at all.
 */
export function contextPackFixture(
  paths: PatchdeskPaths,
  github: Pick<
    FakeGitHubAdapter,
    "getPullRequestComments" | "getPullRequestChecks"
  > = new FakeGitHubAdapter({
    comments: { threads: [], complete: true },
    checks: { overall: "unknown", checks: [] },
  }),
) {
  const counted = { commentReads: 0, checkReads: 0 };
  return {
    counted,
    service: new ReviewContextPackService({
      profiles: {
        async load() {
          return ok({
            id: profileId,
            label: "Fixture",
            githubHost: must(parseGitHubHost("github.com")),
            ghAccount: "fixture",
            workspaceRoots: [],
            rulePaths: [],
            repos: [],
          });
        },
      },
      github: {
        async getPullRequestComments(input) {
          counted.commentReads += 1;
          return github.getPullRequestComments(input);
        },
        async getPullRequestChecks(input) {
          counted.checkReads += 1;
          return github.getPullRequestChecks(input);
        },
      },
      context: new ReviewContextService(),
      paths,
      git: createReadOnlyGitExecutor(new CommandRunner()),
    }),
  };
}

type FixtureOptions = {
  operations?: ReviewOperationCoordinator;
  reach?: BriefReachComputer;
  providerCatalog?: InsightProviderCatalog;
  notifier?: DesktopNotifier;
  github?: Pick<
    FakeGitHubAdapter,
    "getPullRequestComments" | "getPullRequestChecks"
  >;
  /** Seeds a local Review on this source instead of pull request #42. */
  localSource?: LocalReviewSource;
  /** The saved profiles a local run's notification names its checkout from. */
  profiles?: ReadonlyArray<WorkspaceProfileConfig>;
};

export async function fixture(
  invoker: InsightInvoker,
  {
    operations = new ReviewOperationCoordinator(),
    reach,
    providerCatalog,
    notifier,
    github,
    localSource,
    profiles = [],
  }: FixtureOptions = {},
) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-insight-current-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  const sessions = new ReviewSessionStore(paths);
  const reviews = new ReviewStore(paths);
  const insights = new InsightStore(paths);
  const identity = {
    profileId,
    host: must(parseGitHubHost("github.com")),
    owner: must(parseGitHubOwner("octo-org")),
    repo: must(parseGitHubRepoName("patchdesk")),
  };
  // SAFETY: "placeholder" only needs to satisfy the ReviewSessionId-branded
  // parameter type; both paths are recomputed from the real session id below.
  const placeholderId = "placeholder" as never;
  const placeholderPaths = {
    patchPath: must(
      parseAbsolutePath(paths.patchFile(profileId, placeholderId)),
    ),
    worktree: {
      path: must(
        parseAbsolutePath(paths.worktreeDirectory(profileId, placeholderId)),
      ),
      headSha,
    },
  };
  const seeded: ReviewSession =
    localSource === undefined
      ? createReviewSession({
          key: {
            ...identity,
            source: {
              kind: "pull_request",
              prNumber: must(parsePullRequestNumber(42)),
            },
            headSha,
            baseSha,
          },
          pr: { headSha, baseSha, isDraft: false, isOpen: true },
          prContext: {
            title: "Guard recovery",
            description: "Adds a guard to recovery.",
            author: "fixture",
            headBranch: "feature",
            baseBranch: "main",
          },
          ...placeholderPaths,
          createdAt: now,
        })
      : createLocalReviewSession({
          key: { ...identity, source: localSource, headSha, baseSha },
          canonicalPatchHash: must(parseContentHash("c".repeat(64))),
          ...placeholderPaths,
          createdAt: now,
        });
  const session: ReviewSession = {
    ...seeded,
    patchPath: must(parseAbsolutePath(paths.patchFile(profileId, seeded.id))),
    worktree: {
      path: must(
        parseAbsolutePath(paths.worktreeDirectory(profileId, seeded.id)),
      ),
      headSha,
    },
  };
  await mkdir(dirname(session.patchPath), { recursive: true });
  // A real hunk header, not just a `diff --git` line: the Brief's Reach block
  // reads added and removed lines, and a line outside a hunk is neither.
  await writeFile(
    session.patchPath,
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+guard\n",
    "utf8",
  );
  await sessions.save(session);
  const review = createReview({
    identity: { ...identity, source: session.key.source },
    currentSessionId: session.id,
    headSha,
    createdAt: now,
  });
  await reviews.save(review);
  const contextPack = contextPackFixture(paths, github);
  const coordinator = new InsightRunCoordinator(
    reviews,
    sessions,
    insights,
    paths,
    {
      async get() {
        return ok({ models: [{ id: "model", label: "Model" }] });
      },
    },
    { analysis: invoker, walkthrough: invoker, brief: invoker },
    operations,
    contextPack.service,
    () => now,
    undefined,
    providerCatalog,
    reach,
    notifier === undefined
      ? undefined
      : { notifier, profiles: { list: async () => ok(profiles) } },
  );
  return {
    coordinator,
    insights,
    reviews,
    sessions,
    review,
    session,
    paths,
    operations,
    contextPack: contextPack.counted,
  };
}

export async function settled(
  coordinator: InsightRunCoordinator,
  reviewId: string,
  runId: string,
  type: InsightType = "analysis",
): Promise<InsightRunResponse> {
  for (let retry = 0; retry < 100; retry += 1) {
    const state = await coordinator.observe({
      profileId,
      // SAFETY: every caller of settled() passes a reviewId/runId that a prior parseReviewId /
      // coordinator.start() call in this same test already produced as a valid branded id; these
      // casts just re-label an already-valid string for this test-only polling helper.
      reviewId: reviewId as never,
      type,
      // SAFETY: same as above — runId was already produced as a valid branded id earlier in this
      // same test.
      runId: runId as never,
    });
    if (
      state._tag === "ok" &&
      state.value.status !== "queued" &&
      state.value.status !== "running" &&
      state.value.status !== "cancelling"
    )
      return state.value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Insight did not settle");
}
