import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ReviewSessionStore,
  parseStoredReviewSession,
} from "../../src/adapters/storage/review-session-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { createReviewSession } from "../../src/domain/review-session";
import {
  createReviewSessionId,
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
import type { Result } from "../../src/domain/result";

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("Invalid fixture");
  return result.value;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const current = {
  schemaVersion: 5,
  id: "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__439aa21713b5",
  key: {
    profileId: "cfw",
    host: "github.com",
    owner: "centraldigital",
    repo: "patchdesk",
    prNumber: 42,
    headSha: "abcdef1234567890abcdef1234567890abcdef12",
  },
  pr: {
    headSha: "abcdef1234567890abcdef1234567890abcdef12",
    baseSha: "1234567890abcdef1234567890abcdef12345678",
    isDraft: false,
    isOpen: true,
  },
  patchPath: "/tmp/patch.diff",
  worktree: {
    path: "/tmp/worktree",
    headSha: "abcdef1234567890abcdef1234567890abcdef12",
  },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

describe("ReviewSession storage", () => {
  it("round-trips the current receipt-bearing schema and rejects every older schema", () => {
    const receiptState = {
      ...current,
      pendingReview: { _tag: "None" },
      findingReviewReceipts: [],
      directSummaryReview: {
        _tag: "Confirmed",
        receipt: {
          reviewId: "9001",
          event: "COMMENT",
          headSha: current.key.headSha,
          submittedAt: current.updatedAt,
        },
      },
    };
    expect(parseStoredReviewSession(receiptState)).toMatchObject({
      _tag: "ok",
      value: {
        schemaVersion: 5,
        pendingReview: { _tag: "None" },
        directSummaryReview: { _tag: "Confirmed" },
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
      },
    });
    for (const schemaVersion of [2, 3, 4])
      expect(
        parseStoredReviewSession({ ...current, schemaVersion }),
      ).toMatchObject({ _tag: "err" });
  });

  it("rejects unknown current-schema fields instead of migrating removed state", () => {
    const removedFields = [
      "ba" + "tch",
      "batch" + "Content",
      "current" + "AttemptId",
      "visible" + "Result",
      "scope",
    ];
    for (const field of removedFields) {
      expect(
        parseStoredReviewSession({ ...current, [field]: {} }),
      ).toMatchObject({ _tag: "err" });
    }
  });

  it("round-trips a stored canonicalPatchHash", () => {
    const canonicalPatchHash =
      "625e3b6a" + "0".repeat(56);
    const parsed = parseStoredReviewSession({
      ...current,
      canonicalPatchHash,
    });
    expect(parsed).toMatchObject({
      _tag: "ok",
      value: { canonicalPatchHash },
    });
  });

  it("omits canonicalPatchHash from the parsed value when the field is absent", () => {
    const parsed = parseStoredReviewSession(current);
    expect(parsed._tag).toBe("ok");
    if (parsed._tag !== "ok") return;
    expect(parsed.value.canonicalPatchHash).toBeUndefined();
    expect("canonicalPatchHash" in parsed.value).toBe(false);
  });

  it("parses a session with no canonicalPatchHash key at all without quarantining it", () => {
    // Back-compat guard: existing sessions written before this field
    // existed must keep parsing as valid so they heal in place instead
    // of being moved to .quarantine and losing their pendingReview draft.
    expect("canonicalPatchHash" in current).toBe(false);
    const parsed = parseStoredReviewSession(current);
    expect(parsed).toMatchObject({ _tag: "ok" });
  });

  it("persists canonicalPatchHash through ReviewSessionStore.save() and .load()", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-session-store-"));
    roots.push(root);
    const paths = PatchdeskPaths.forTest(root);
    const store = new ReviewSessionStore(paths);
    const profileId = must(parseWorkspaceProfileId("cfw"));
    const key = {
      profileId,
      host: must(parseGitHubHost("github.com")),
      owner: must(parseGitHubOwner("centraldigital")),
      repo: must(parseGitHubRepoName("patchdesk")),
      prNumber: must(parsePullRequestNumber(42)),
      headSha: must(parseGitSha("a".repeat(40))),
    };
    const sessionId = createReviewSessionId(key);
    const canonicalPatchHash = must(
      parseContentHash("625e3b6a" + "0".repeat(56)),
    );
    const session = createReviewSession({
      key,
      pr: { headSha: key.headSha, isDraft: false, isOpen: true },
      patchPath: must(
        parseAbsolutePath(paths.patchFile(profileId, sessionId)),
      ),
      canonicalPatchHash,
      worktree: {
        path: must(
          parseAbsolutePath(paths.worktreeDirectory(profileId, sessionId)),
        ),
        headSha: key.headSha,
      },
      createdAt: must(parseIsoTimestamp("2026-08-01T00:00:00.000Z")),
    });

    await expect(store.save(session)).resolves.toMatchObject({ _tag: "ok" });
    await expect(store.load(profileId, session.id)).resolves.toMatchObject({
      _tag: "ok",
      value: { canonicalPatchHash },
    });
  });
});
