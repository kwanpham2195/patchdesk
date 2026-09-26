import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommandRunner } from "../../src/adapters/github/command-runner";
import { InsightStore } from "../../src/adapters/storage/insight-store";
import { LocalApplyOperationStore } from "../../src/adapters/storage/local-apply-operation-store";
import { MergeOperationStore } from "../../src/adapters/storage/merge-operation-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewArtifactStorage } from "../../src/adapters/storage/review-artifact-storage";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import { ReviewWriteOperationStore } from "../../src/adapters/storage/review-write-operation-store";
import { ViewedFilesStore } from "../../src/adapters/storage/viewed-files-store";
import {
  createLocalNoteId,
  parseContentHash,
  parseFindingId,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseInsightRunId,
  parseIsoTimestamp,
  parseRepoRelativePath,
  parseWorkspaceProfileId,
  type FindingId,
  type InsightRunId,
} from "../../src/domain/ids";
import {
  beginInsightRun,
  completeInsightRun,
} from "../../src/domain/insight-record";
import type { LogEntryInput } from "../../src/domain/log-entry";
import { ok, type Result } from "../../src/domain/result";
import type { ReviewResult } from "../../src/domain/review-result";
import type { LocalReviewSourceRequest } from "../../src/domain/review-source";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { createReadOnlyGitExecutor } from "../../src/main/local-api-stores";
import { LocalApplyService } from "../../src/services/local-apply-service";
import { LocalDraftService } from "../../src/services/local-draft-service";
import { LocalReviewOpening } from "../../src/services/local-review-opening";
import { LocalReviewRetention } from "../../src/services/local-review-retention";
import { LocalReviewRevisionService } from "../../src/services/local-review-revision-service";
import { LocalReviewSessionPreparation } from "../../src/services/local-review-session-preparation";
import { ReviewLifecycleGate } from "../../src/services/review-lifecycle-gate";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import type { ReviewWorkbenchProjection } from "../../src/services/review-workbench-projection";
import { ReviewWorkbenchProjectionService } from "../../src/services/review-workbench-projection";
import { ReviewWriteGate } from "../../src/services/review-write-gate";
import type { GitReadExecutor } from "../../src/services/review-worktree-service";
import { ReviewWorktreeService } from "../../src/services/review-worktree-service";

const roots: string[] = [];
export const now = value(parseIsoTimestamp("2026-09-25T00:00:00.000Z"));
export const profileId = value(parseWorkspaceProfileId("acme"));
const repository = {
  host: value(parseGitHubHost("github.com")),
  owner: value(parseGitHubOwner("octo-org")),
  repo: value(parseGitHubRepoName("patchdesk")),
};

export function value<T>(result: Result<T, unknown>): T {
  if (result._tag === "ok") return result.value;
  throw new Error("Invalid test fixture");
}

export async function cleanupLocalApplyRoots(): Promise<void> {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
}

/** Runs git for fixture setup and evidence only; the code under test runs git through the production executor. */
export function git(cwd: string, ...args: ReadonlyArray<string>): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
}

/** Intercepts one git invocation of the code under test, such as `apply`, around the real command. */
export type GitInterceptor = (
  argv: ReadonlyArray<string>,
  run: () => ReturnType<GitReadExecutor["run"]>,
) => ReturnType<GitReadExecutor["run"]>;

export type LocalApplyHarness = {
  readonly repositoryPath: string;
  readonly paths: PatchdeskPaths;
  readonly service: LocalApplyService;
  readonly opening: LocalReviewOpening;
  readonly reviews: ReviewStore;
  readonly operations: LocalApplyOperationStore;
  readonly insights: InsightStore;
  /** Add to draft, maintainer notes, and Remove over the same stores and Review coordinator; note ids count up from `note-fixture-1`. */
  readonly drafts: LocalDraftService;
  readonly coordinator: ReviewOperationCoordinator;
  readonly retention: LocalReviewRetention;
  readonly logs: ReadonlyArray<LogEntryInput>;
  readonly open: (
    request?: LocalReviewSourceRequest,
  ) => Promise<ReviewWorkbenchProjection>;
};

/** A checkout with one committed file, an Apply service over it, and every store on disk. */
export async function localApplyHarness(
  intercept?: GitInterceptor,
  seams: {
    /** Wraps the store the service writes through, to fail one transition. */
    readonly operations?: (
      store: LocalApplyOperationStore,
    ) => Pick<
      LocalApplyOperationStore,
      "load" | "begin" | "save" | "remove" | "listReviews"
    >;
    /** Wraps the open path the service prepares the next session through. */
    readonly opening?: (
      opening: LocalReviewOpening,
    ) => Pick<LocalReviewOpening, "openLocked">;
  } = {},
): Promise<LocalApplyHarness> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-local-apply-"));
  roots.push(root);
  const repositoryPath = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repositoryPath]);
  await writeFile(join(repositoryPath, "tracked.txt"), "one\n");
  git(repositoryPath, "add", "tracked.txt");
  git(repositoryPath, "commit", "-q", "-m", "root");
  const paths = PatchdeskPaths.forTest(join(root, "app"));
  const profiles = new ProfileStore(paths);
  await profiles.save(
    value(
      parseWorkspaceProfileConfig({
        id: profileId,
        label: "ACME",
        githubHost: "github.com",
        ghAccount: "fixture",
        workspaceRoots: [],
        rulePaths: [],
        repos: [{ ...repository, localPath: repositoryPath }],
      }),
    ),
  );
  const sessions = new ReviewSessionStore(paths);
  let notes = 0;
  const reviews = new ReviewStore(paths);
  const insights = new InsightStore(paths);
  const operations = new LocalApplyOperationStore(paths);
  const artifacts = new ReviewArtifactStorage(paths, () => now);
  const realGit = createReadOnlyGitExecutor(new CommandRunner());
  const revisions = new LocalReviewRevisionService(realGit, paths);
  const coordinator = new ReviewOperationCoordinator();
  const lifecycleGate = new ReviewLifecycleGate();
  const worktrees = new ReviewWorktreeService(
    paths,
    realGit,
    { environmentFor: async () => ok({}) },
    async () => undefined,
  );
  const retention = new LocalReviewRetention({
    paths,
    profiles,
    reviews,
    sessions,
    insights,
    mergeOperations: new MergeOperationStore(paths),
    localApplyOperations: operations,
    worktrees,
    artifacts,
    lifecycleGate,
    coordinator,
  });
  const opening = new LocalReviewOpening(
    new LocalReviewSessionPreparation({
      profiles,
      sessions,
      revisions,
      worktrees,
      artifacts,
      paths,
      lifecycleGate,
      now: () => now,
    }),
    new ReviewWorkbenchProjectionService(
      profiles,
      sessions,
      reviews,
      insights,
      paths,
      new ReviewWriteOperationStore(paths),
      new ViewedFilesStore(paths, { write: () => undefined }),
      operations,
    ),
    { reviews, artifacts, coordinator, retention },
    () => now,
  );
  const logs: LogEntryInput[] = [];
  const service = new LocalApplyService({
    gate: new ReviewWriteGate(
      profiles,
      reviews,
      sessions,
      // A local Review never reads a GitHub snapshot or observation journal.
      { load: async () => ok(undefined as never) },
      { load: async () => ok(undefined) },
      { revisions, reviews, now: () => now },
    ),
    operations: seams.operations?.(operations) ?? operations,
    insights,
    reviews,
    profiles,
    opening: seams.opening?.(opening) ?? opening,
    coordinator,
    git: {
      run: (argv, environment) =>
        intercept === undefined
          ? realGit.run(argv, environment)
          : intercept(argv, () => realGit.run(argv, environment)),
    },
    paths,
    logs: { write: (entry) => logs.push(entry) },
    now: () => now,
  });
  return {
    repositoryPath,
    paths,
    service,
    opening,
    reviews,
    operations,
    insights,
    drafts: new LocalDraftService({
      reviews,
      sessions,
      insights,
      coordinator,
      now: () => now,
      createNoteId: () => createLocalNoteId(`fixture-${String(++notes)}`),
    }),
    coordinator,
    retention,
    logs,
    open: async (request = { kind: "working_tree" }) =>
      value(await opening.open({ profileId, repository, request })),
  };
}

/** A mapped new-side Finding on `path` carrying replacement code. */
export function suggestionFinding(
  id: string,
  path: string,
  lines: { readonly start: number; readonly end: number },
  code: string,
): ReviewResult["findings"][number] {
  return {
    id: value(parseFindingId(id)),
    severity: "P2",
    title: `Fix ${id}`,
    file: value(parseRepoRelativePath(path)),
    lineStart: lines.start,
    lineEnd: lines.end,
    diffSide: "new",
    explanation: "The bound is off by one.",
    confidence: "high",
    mappingStatus: "mapped",
    suggestedReplacement: { code },
  };
}

/** Retains one Analysis result against the workbench's session, as a completed run would. */
export async function retainAnalysis(
  insights: InsightStore,
  workbench: ReviewWorkbenchProjection,
  findings: ReviewResult["findings"],
): Promise<InsightRunId> {
  const runId = value(
    parseInsightRunId(`insight-analysis-1-aaaaaaaaaaaa-${workbench.review.id}`),
  );
  const revision = {
    sessionId: workbench.session.id,
    headSha: workbench.session.key.headSha,
    patchHash: value(parseContentHash(workbench.revision.patchHash)),
  };
  const provenance = {
    provider: "pi" as const,
    model: "model",
    reasoning: "medium" as const,
    language: "en" as const,
  };
  value(
    await insights.mutate({
      profileId,
      reviewId: workbench.review.id,
      type: "analysis",
      now,
      operation: (record) =>
        beginInsightRun(record, {
          id: runId,
          revision,
          ...provenance,
          startedAt: now,
        }),
    }),
  );
  value(
    await insights.mutate({
      profileId,
      reviewId: workbench.review.id,
      type: "analysis",
      now,
      operation: (record) =>
        completeInsightRun(
          record,
          runId,
          {
            runId,
            revision,
            generatedAt: now,
            provenance,
            value: {
              changeSummary: "Adds a loop.",
              verdict: "comment",
              summary: "Check the bound.",
              findings,
              validationPlan: [],
              assumptions: [],
            },
          },
          now,
        ),
    }),
  );
  return runId;
}

/** The request an Apply of `findingIds` sends for the workbench it was shown on. */
export function applyRequest(
  workbench: ReviewWorkbenchProjection,
  runId: InsightRunId,
  findingIds: ReadonlyArray<string>,
): Parameters<LocalApplyService["apply"]>[0] {
  return {
    profileId,
    reviewId: workbench.review.id,
    runId,
    findingIds: findingIds.map((id): FindingId => value(parseFindingId(id))),
    expected: {
      sessionId: workbench.session.id,
      headSha: workbench.session.key.headSha,
      patchHash: value(parseContentHash(workbench.revision.patchHash)),
    },
  };
}
