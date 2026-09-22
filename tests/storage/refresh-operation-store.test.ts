import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RefreshOperationStore } from "../../src/adapters/storage/refresh-operation-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { createReview } from "../../src/domain/review";
import {
  createReviewSessionId,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function must<Value>(result: Result<Value, unknown>): Value {
  if (result._tag === "err") throw new Error("invalid fixture");
  return result.value;
}

const identity = {
  profileId: must(parseWorkspaceProfileId("acme")),
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("octo")),
  repo: must(parseGitHubRepoName("widgets")),
  prNumber: must(parsePullRequestNumber(7)),
};
const headSha = must(parseGitSha("a".repeat(40)));
const review = createReview({
  identity,
  currentSessionId: createReviewSessionId({
    ...identity,
    headSha,
    baseSha: must(parseGitSha("b".repeat(40))),
  }),
  headSha,
  createdAt: must(parseIsoTimestamp("2026-09-17T09:00:00.000Z")),
});
const operation = {
  operationId: "refresh-7",
  profileId: identity.profileId,
  reviewId: review.id,
  expectedUpdatedAt: review.updatedAt,
  startedAt: must(parseIsoTimestamp("2026-09-17T10:00:00.000Z")),
  state: { _tag: "Requested" as const },
};

async function store(): Promise<RefreshOperationStore> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-refresh-operation-"));
  roots.push(root);
  return new RefreshOperationStore(PatchdeskPaths.forTest(root));
}

describe("RefreshOperationStore", () => {
  it("retains active operations and permits a later begin only after a terminal state", async () => {
    const subject = await store();
    await expect(subject.begin(operation)).resolves.toEqual({
      _tag: "ok",
      value: undefined,
    });
    await expect(
      subject.begin({ ...operation, operationId: "refresh-8" }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "RefreshOperationExists" },
    });
    await expect(
      subject.save({ ...operation, state: { _tag: "Interrupted" } }),
    ).resolves.toEqual({
      _tag: "ok",
      value: undefined,
    });
    await expect(
      subject.begin({ ...operation, operationId: "refresh-8" }),
    ).resolves.toEqual({
      _tag: "ok",
      value: undefined,
    });
  });
});
