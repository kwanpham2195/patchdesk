import { vi } from "vitest";

import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { ok, type Result } from "../../src/domain/result";
import type { ReviewWriteOperation } from "../../src/domain/review-write-operation";

/**
 * The fixture preamble the three pull request metadata write suites share —
 * `label-service.test.ts`, `assignee-service.test.ts` and
 * `reviewer-service.test.ts` — matching the production consolidation in
 * `src/services/pull-request-metadata-write.ts`.
 *
 * Only genuinely identical setup lives here. Each suite keeps its own
 * gateway builder, its own command builder, and every assertion, because
 * those are the parts that describe the write under test rather than the
 * Review it is written against.
 */

export const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "ok") return result.value;
  throw new Error("fixture");
};

export const profileId = must(parseWorkspaceProfileId("cfw"));
export const reviewId = must(
  parseReviewId("cfw__centraldigital__patchdesk__pr-42__review-abcdef123456"),
);
export const headSha = must(parseGitSha("1".repeat(40)));
export const sessionId = must(
  parseReviewSessionId(
    "github.com__centraldigital__patchdesk__pr-42__sha-11111111__base-22222222__abcdef123456",
  ),
);
export const sessionKey = {
  profileId,
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
  prNumber: must(parsePullRequestNumber(42)),
  headSha,
};

/** Minimal current-session gate: every command passes against the fixture review. */
export const makeGate = () => ({
  requireCurrentSession: vi.fn(async () => {
    // SAFETY: metadata services read only the profile account and parsed session identity supplied by this fixture.
    const currentSession = {
      profile: { ghAccount: "octocat" },
      review: {},
      session: { id: sessionId, key: sessionKey },
    } as never;
    return ok(currentSession);
  }),
});

const nowValue = must(parseIsoTimestamp("2026-01-01T00:00:00.000Z"));
export const now = () => nowValue;

export const makeRecentWrites = () => {
  return { append: vi.fn(async () => ok(undefined)) };
};

export const makeReviewWriteOperations = () => {
  let operation: ReviewWriteOperation | undefined;
  return {
    load: vi.fn(async () => ok(operation)),
    begin: vi.fn(async (next: ReviewWriteOperation) => {
      if (operation !== undefined)
        return {
          _tag: "err" as const,
          error: { _tag: "ReviewWriteOperationExists" as const },
        };
      operation = next;
      return ok(undefined);
    }),
    markOutcomeUnknown: vi.fn(async (next: ReviewWriteOperation) => {
      operation = next;
      return ok(undefined);
    }),
    confirm: vi.fn(async (next: ReviewWriteOperation) => {
      operation = next;
      return ok(undefined);
    }),
    reject: vi.fn(async () => {
      operation = undefined;
      return ok(undefined);
    }),
    remove: vi.fn(async () => {
      operation = undefined;
      return ok(undefined);
    }),
  };
};
