import { afterEach, describe, expect, it } from "vitest";

import {
  createAgentRunRequestId,
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseLocalBranchName,
} from "../../src/domain/ids";
import { ok } from "../../src/domain/result";
import { AgentRunRequestService } from "../../src/services/agent-run-request-service";
import type { DesktopNotificationEvent } from "../../src/services/desktop-notifier";
import type { InsightInvoker } from "../../src/services/insight-run-coordinator";
import {
  analysisResult,
  cleanupRoots,
  fixture,
  must,
  now,
  profileId,
  settled,
} from "./insight-run-fixture";

afterEach(cleanupRoots);

const host = must(parseGitHubHost("github.com"));
const profiles = [
  {
    id: profileId,
    label: "Personal",
    githubHost: host,
    ghAccount: "fixture",
    workspaceRoots: [],
    rulePaths: [],
    repos: [
      {
        host,
        owner: must(parseGitHubOwner("octo-org")),
        repo: must(parseGitHubRepoName("patchdesk")),
        localPath: must(parseAbsolutePath("/Users/me/src/patchdesk")),
      },
    ],
  },
];

/** Completes only after `release`, so a test can link the run to a request before it settles. */
function gatedInvoker() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const invoker: InsightInvoker = {
    async invoke() {
      await gate;
      return ok(analysisResult);
    },
  };
  return { invoker, release: () => release() };
}

/** A local Review on the configured checkout, the real coordinator, and what it posts. */
async function localRunFixture(invoker: InsightInvoker) {
  const events: DesktopNotificationEvent[] = [];
  const value = await fixture(invoker, {
    localSource: {
      kind: "working_tree",
      branch: must(parseLocalBranchName("feat/x")),
    },
    profiles,
    notifier: { notify: (event) => events.push(event) },
  });
  const runInput = {
    profileId,
    reviewId: value.review.id,
    type: "analysis" as const,
    model: "model",
    reasoning: "medium" as const,
    language: "en" as const,
  };
  /** Waits for the run to settle and release the Review lock the notification is posted under. */
  const settle = async (runId: string): Promise<void> => {
    await settled(value.coordinator, value.review.id, runId);
    await value.operations.withReviewLock(
      profileId,
      value.review.id,
      async () => undefined,
    );
  };
  return { ...value, events, runInput, settle };
}

describe("InsightRunCoordinator settled notification for a local Review (#496)", () => {
  it("names the run by its source title and checkout folder", async () => {
    const { invoker, release } = gatedInvoker();
    const value = await localRunFixture(invoker);

    const started = must(await value.coordinator.start(value.runInput));
    release();
    await value.settle(started.runId);

    expect(value.events).toEqual([
      {
        _tag: "InsightSettled",
        reviewId: value.review.id,
        insightType: "analysis",
        outcome: "completed",
        localTitle: "Working tree on feat/x in patchdesk",
        requestedByAgent: false,
      },
    ]);
  });

  it("marks a run the maintainer started from an agent's request", async () => {
    const { invoker, release } = gatedInvoker();
    const value = await localRunFixture(invoker);
    const requests = new AgentRunRequestService({
      reviews: value.reviews,
      insights: value.insights,
      profiles: { list: async () => ok(profiles) },
      coordinator: value.operations,
      now: () => now,
      createRequestId: () => createAgentRunRequestId("request-1"),
    });
    must(
      await requests.request({
        profileId,
        reviewId: value.review.id,
        sessionId: value.session.id,
        type: "analysis",
      }),
    );

    const started = must(
      await requests.startRun(value.coordinator, value.runInput),
    );
    release();
    await value.settle(started.runId);

    expect(value.events).toMatchObject([
      {
        _tag: "InsightSettled",
        outcome: "completed",
        localTitle: "Working tree on feat/x in patchdesk",
        requestedByAgent: true,
      },
    ]);
  });
});
