import { vi } from "vitest";

import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parsePullRequestNumber,
  parseReviewId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { ok, type Result } from "../../src/domain/result";

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
  requireCurrentSession: vi.fn(async () =>
    // SAFETY: the service only reads `session.key` and `profile.ghAccount`
    // from this stub; `review` is forwarded opaquely and never read.
    ok({
      profile: { ghAccount: "octocat" },
      review: {},
      session: { key: sessionKey },
    } as never),
  ),
});

// SAFETY: this literal is a well-formed ISO 8601 instant, satisfying the
// branded IsoTimestamp contract the service's `now` dependency expects.
export const now = () => "2026-01-01T00:00:00.000Z" as never;

export const makeRecentWrites = () => ({
  append: vi.fn(async () => ok(undefined)),
});
