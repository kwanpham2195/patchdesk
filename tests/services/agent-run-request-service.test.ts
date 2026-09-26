import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InsightStore } from "../../src/adapters/storage/insight-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import {
  createAgentRunRequestId,
  createReviewId,
  createReviewSessionId,
  parseContentHash,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseInsightRunId,
  parseIsoTimestamp,
  parseLocalBranchName,
  parseWorkspaceProfileId,
  type InsightRunId,
} from "../../src/domain/ids";
import { beginInsightRun } from "../../src/domain/insight-record";
import { err, ok, type Result } from "../../src/domain/result";
import { createReview, type ReviewIdentity } from "../../src/domain/review";
import type { LocalReviewSource } from "../../src/domain/review-source";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { AgentRunRequestService } from "../../src/services/agent-run-request-service";
import type { DesktopNotificationEvent } from "../../src/services/desktop-notifier";
import type {
  InsightCoordinatorFailure,
  InsightCoordinatorInput,
  InsightRunResponse,
} from "../../src/services/insight-run-coordinator";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("Invalid fixture");
  return result.value;
}

const profileId = must(parseWorkspaceProfileId("acme"));
const identity: ReviewIdentity<LocalReviewSource> = {
  profileId,
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("octo-org")),
  repo: must(parseGitHubRepoName("patchdesk")),
  source: {
    kind: "working_tree",
    branch: must(parseLocalBranchName("feat/x")),
  },
};
const reviewId = createReviewId(identity);
const headSha = must(parseGitSha("1".repeat(40)));
const baseSha = must(parseGitSha("b".repeat(40)));
const sessionId = createReviewSessionId({ ...identity, headSha, baseSha });
const now = must(parseIsoTimestamp("2026-09-26T10:00:00.000Z"));
const runId = must(parseInsightRunId("insight-analysis-1-111111111111-run"));
const analysis = { profileId, reviewId, sessionId, type: "analysis" } as const;
const runInput = {
  profileId,
  reviewId,
  type: "analysis",
  provider: "codex-cli-account",
  model: "gpt-6-luna",
  reasoning: "medium",
  language: "en",
} as const satisfies InsightCoordinatorInput;

let root: string;
let paths: PatchdeskPaths;
let events: DesktopNotificationEvent[];
let service: AgentRunRequestService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-run-request-"));
  paths = PatchdeskPaths.forTest(root);
  must(
    await new ReviewStore(paths).save(
      createReview({
        identity,
        currentSessionId: sessionId,
        headSha,
        createdAt: now,
      }),
    ),
  );
  const profile = must(
    parseWorkspaceProfileConfig({
      id: "acme",
      label: "ACME",
      githubHost: "github.com",
      ghAccount: "fixture",
      workspaceRoots: [],
      rulePaths: [],
      repos: [
        {
          host: "github.com",
          owner: "octo-org",
          repo: "patchdesk",
          localPath: "/src/patchdesk",
        },
      ],
    }),
  );
  events = [];
  let issued = 0;
  service = new AgentRunRequestService({
    reviews: new ReviewStore(paths),
    insights: new InsightStore(paths),
    profiles: { list: async () => ok([profile]) },
    coordinator: new ReviewOperationCoordinator(),
    notifier: { notify: (event) => events.push(event) },
    now: () => now,
    createRequestId: () =>
      createAgentRunRequestId(`request-${String((issued += 1))}`),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A start that begins the run in the Insight store, as the coordinator's does. */
function startingRuns(started: InsightRunId) {
  return {
    start: async (
      input: InsightCoordinatorInput,
    ): Promise<Result<InsightRunResponse, InsightCoordinatorFailure>> => {
      must(
        await new InsightStore(paths).mutate({
          profileId: input.profileId,
          reviewId: input.reviewId,
          type: input.type,
          now,
          operation: (record) =>
            beginInsightRun(record, {
              id: started,
              revision: {
                sessionId,
                headSha,
                patchHash: must(parseContentHash("c".repeat(64))),
              },
              provider: "codex-cli-account",
              model: "gpt-6-luna",
              reasoning: "medium",
              language: "en",
              startedAt: now,
            }),
        }),
      );
      return ok({ runId: started, type: input.type, status: "queued" });
    },
  };
}

describe("AgentRunRequestService", () => {
  it("records an awaiting request and posts one notification naming the source and checkout folder", async () => {
    const requested = await service.request({
      ...analysis,
      clientName: "claude-code",
    });

    expect(requested).toEqual(
      ok({
        reviewId,
        sessionId,
        type: "analysis",
        status: "awaiting_approval",
        requestId: "agent-request-request-1",
      }),
    );
    expect(events).toEqual([
      {
        _tag: "AgentRunRequested",
        reviewId,
        insightType: "analysis",
        localTitle: "Working tree on feat/x in patchdesk",
      },
    ]);
    const stored = must(await new ReviewStore(paths).load(profileId, reviewId));
    expect(stored.agentRunRequests).toEqual([
      expect.objectContaining({
        requestedAt: now,
        clientName: "claude-code",
        status: "awaiting_approval",
      }),
    ]);
  });

  it("answers a repeated request with the existing id and posts nothing more", async () => {
    await service.request(analysis);

    const repeated = await service.request(analysis);

    expect(repeated).toMatchObject(
      ok({ status: "awaiting_approval", requestId: "agent-request-request-1" }),
    );
    expect(events).toHaveLength(1);
  });

  it("keeps a declined request final for the session and posts nothing for a new ask", async () => {
    const requested = must(await service.request(analysis));
    if (requested.requestId === undefined) throw new Error("no request");

    const declined = await service.decline({
      profileId,
      reviewId,
      requestId: requested.requestId,
    });
    const askedAgain = await service.request(analysis);

    expect(declined).toMatchObject(ok({ request: { status: "declined" } }));
    expect(askedAgain).toMatchObject(
      ok({ status: "declined", requestId: requested.requestId }),
    );
    expect(events).toHaveLength(1);
  });

  it("refuses a request for a session the Review is not on, recording and posting nothing", async () => {
    const refused = await service.request({
      ...analysis,
      sessionId: createReviewSessionId({
        ...identity,
        headSha: must(parseGitSha("2".repeat(40))),
        baseSha,
      }),
    });

    expect(refused).toEqual(err({ reason: "stale_session" }));
    expect(events).toEqual([]);
    const stored = must(await new ReviewStore(paths).load(profileId, reviewId));
    expect(stored.agentRunRequests).toBeUndefined();
  });

  it("approves through the start, linking the run, and answers the next request with it while it runs", async () => {
    const requested = must(await service.request(analysis));
    if (requested.requestId === undefined) throw new Error("no request");

    const approved = await service.approve(startingRuns(runId), {
      ...runInput,
      requestId: requested.requestId,
    });
    const askedAgain = await service.request(analysis);

    expect(approved).toMatchObject(ok({ runId, status: "queued" }));
    expect(askedAgain).toMatchObject(
      ok({ status: "approved", requestId: requested.requestId, runId }),
    );
    expect(events).toHaveLength(1);
  });

  it("leaves the request awaiting when the start is refused", async () => {
    const requested = must(await service.request(analysis));
    if (requested.requestId === undefined) throw new Error("no request");

    const approved = await service.approve(
      { start: async () => err("model_unavailable" as const) },
      { ...runInput, requestId: requested.requestId },
    );

    expect(approved).toEqual(err("model_unavailable"));
    const stored = must(await new ReviewStore(paths).load(profileId, reviewId));
    expect(stored.agentRunRequests).toEqual([
      expect.objectContaining({ status: "awaiting_approval" }),
    ]);
  });

  it("records a new request once an approved run has settled, which needs a new approval", async () => {
    const requested = must(await service.request(analysis));
    if (requested.requestId === undefined) throw new Error("no request");
    await service.approve(
      { start: async () => ok({ runId, type: "analysis", status: "queued" }) },
      { ...runInput, requestId: requested.requestId },
    );

    const askedAgain = await service.request(analysis);

    expect(askedAgain).toMatchObject(
      ok({ status: "awaiting_approval", requestId: "agent-request-request-2" }),
    );
    expect(events).toHaveLength(2);
  });
});
