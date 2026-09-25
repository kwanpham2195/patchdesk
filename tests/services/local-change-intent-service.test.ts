import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import { createReview } from "../../src/domain/review";
import { LocalChangeIntentService } from "../../src/services/local-change-intent-service";
import {
  cleanupLocalApplyRoots,
  localApplyHarness,
  now,
  profileId,
  value,
} from "./local-apply-fixture";

afterEach(cleanupLocalApplyRoots);

const intent = { kind: "text", markdown: "Add a guard to recovery." } as const;

async function intentHarness() {
  const harness = await localApplyHarness();
  const workbench = await harness.open();
  const service = new LocalChangeIntentService({
    reviews: harness.reviews,
    coordinator: harness.coordinator,
    now: () => now,
  });
  return { harness, workbench, reviewId: workbench.review.id, service };
}

describe("LocalChangeIntentService.set", () => {
  it("stores the intent on the local Review, then clears it", async () => {
    const { harness, reviewId, service } = await intentHarness();

    expect(await service.set({ profileId, reviewId, intent })).toEqual({
      _tag: "ok",
      value: {
        changeIntent: {
          intent,
          setting: {
            kind: "text",
            sha256: createHash("sha256").update(intent.markdown).digest("hex"),
          },
        },
      },
    });
    expect(
      value(await harness.reviews.load(profileId, reviewId)).changeIntent,
    ).toEqual(intent);

    expect(
      await service.set({ profileId, reviewId, intent: undefined }),
    ).toEqual({ _tag: "ok", value: { changeIntent: null } });
    expect(
      value(await harness.reviews.load(profileId, reviewId)),
    ).not.toHaveProperty("changeIntent");
  });

  it("refuses while another operation holds the Review, and stores nothing", async () => {
    const { harness, reviewId, service } = await intentHarness();
    harness.coordinator.acquire(`${profileId}:${reviewId}`);

    expect(await service.set({ profileId, reviewId, intent })).toEqual({
      _tag: "err",
      error: { reason: "in_progress" },
    });
    expect(
      value(await harness.reviews.load(profileId, reviewId)),
    ).not.toHaveProperty("changeIntent");
  });

  it("refuses text holding a credential, and stores nothing", async () => {
    const { harness, reviewId, service } = await intentHarness();

    expect(
      await service.set({
        profileId,
        reviewId,
        intent: { kind: "text", markdown: `Call with ghp_${"a".repeat(36)}.` },
      }),
    ).toEqual({ _tag: "err", error: { reason: "change_intent_sensitive" } });
    expect(
      value(await harness.reviews.load(profileId, reviewId)),
    ).not.toHaveProperty("changeIntent");
  });

  it("refuses a pull request Review", async () => {
    const { harness, workbench, service } = await intentHarness();
    const pullRequest = createReview({
      identity: {
        profileId,
        host: value(parseGitHubHost("github.com")),
        owner: value(parseGitHubOwner("octo-org")),
        repo: value(parseGitHubRepoName("patchdesk")),
        source: {
          kind: "pull_request",
          prNumber: value(parsePullRequestNumber(42)),
        },
      },
      currentSessionId: workbench.session.id,
      headSha: workbench.session.key.headSha,
      createdAt: now,
    });
    value(await harness.reviews.save(pullRequest));

    expect(
      await service.set({ profileId, reviewId: pullRequest.id, intent }),
    ).toEqual({ _tag: "err", error: { reason: "not_applicable" } });
  });
});
