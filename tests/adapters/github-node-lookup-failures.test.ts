import { describe, expect, it } from "vitest";

import {
  noChildProcesses,
  routedTransport,
  type CannedAnswer,
} from "./github-transport-doubles";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitHubThreadId,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import type { PullRequestRef } from "../../src/domain/pull-request";
import type { Result } from "../../src/domain/result";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { StubCredentials } from "./stub-github-credentials";

/**
 * What a failed node lookup means to `getReviewThreadTarget` and
 * `getReviewCommentTarget`. Both answer a membership question a write path
 * then acts on: `{ found: false }` says the node is not part of this pull
 * request, and `InlineConversationService` turns that into `not_found` — a
 * conversation command refused as if the comment were gone.
 *
 * Only GitHub answering NOT_FOUND establishes that. A forbidden, rate-limited,
 * unavailable, or timed-out lookup establishes nothing, and has to reach the
 * caller as the read failure it is (ADR 0024, ADR 0035, issue #276 step T2).
 */

function mustParse<T, E>(result: Result<T, E>): T {
  if (result._tag === "err") throw new Error("Expected test value to parse");
  return result.value;
}

const profile = mustParse(
  parseWorkspaceProfileConfig({
    id: "cfw",
    label: "CFW",
    githubHost: "github.com",
    ghAccount: "pmquan2cfw",
    workspaceRoots: [],
    rulePaths: [],
    repos: [],
  }),
);

const pr: PullRequestRef = {
  host: mustParse(parseGitHubHost("github.com")),
  owner: mustParse(parseGitHubOwner("centraldigital")),
  repo: mustParse(parseGitHubRepoName("patchdesk")),
  number: mustParse(parsePullRequestNumber(42)),
};

const threadId = mustParse(parseGitHubThreadId("PRRT_thread"));

/** Every lookup this file makes is answered the same way, however often it is asked. */
function adapterAnswering(answer: CannedAnswer): GitHubAdapter {
  return new GitHubAdapter(
    noChildProcesses(),
    new StubCredentials(),
    routedTransport(() => answer),
  );
}

/** The failure a GraphQL `errors[0].type` of NOT_FOUND is classified into. */
const nodeGone: CannedAnswer = { _tag: "CommandNotFound" };

/** An IP-allow-list refusal: a FORBIDDEN error whose message names the list. */
const ipAllowListRefusal: CannedAnswer = {
  _tag: "CommandForbidden",
  reason: "ip_allow_list",
};

const rateLimited: CannedAnswer = { _tag: "CommandRateLimited" };

describe("a review thread lookup GitHub refused to answer", () => {
  it("reports a node GitHub says does not exist as not a member", async () => {
    const adapter = adapterAnswering(nodeGone);

    await expect(
      adapter.getReviewThreadTarget({ profile, pr, threadId }),
    ).resolves.toEqual({ _tag: "ok", value: { found: false } });
  });

  it("reports a forbidden lookup as forbidden rather than as not a member", async () => {
    const adapter = adapterAnswering(ipAllowListRefusal);

    await expect(
      adapter.getReviewThreadTarget({ profile, pr, threadId }),
    ).resolves.toEqual({
      _tag: "err",
      error: {
        _tag: "GitHubForbidden",
        operation: "get_thread_target",
        reason: "ip_allow_list",
      },
    });
  });

  it("reports a rate-limited lookup as rate limited rather than as not a member", async () => {
    const adapter = adapterAnswering(rateLimited);

    await expect(
      adapter.getReviewThreadTarget({ profile, pr, threadId }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "GitHubRateLimited", operation: "get_thread_target" },
    });
  });

  it("reports a lookup that never reached GitHub as a read failure", async () => {
    const adapter = adapterAnswering({ _tag: "CommandUnavailable" });

    await expect(
      adapter.getReviewThreadTarget({ profile, pr, threadId }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "GitHubReadFailed", operation: "get_thread_target" },
    });
  });

  it("reports a lookup that timed out as a read failure", async () => {
    const adapter = adapterAnswering({ _tag: "CommandTimedOut" });

    await expect(
      adapter.getReviewThreadTarget({ profile, pr, threadId }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "GitHubReadFailed", operation: "get_thread_target" },
    });
  });
});

describe("a review comment lookup GitHub refused to answer", () => {
  it("reports a node GitHub says does not exist as not a member", async () => {
    const adapter = adapterAnswering(nodeGone);

    await expect(
      adapter.getReviewCommentTarget({ profile, pr, commentId: "PRRC_gone" }),
    ).resolves.toEqual({ _tag: "ok", value: { found: false } });
  });

  it("reports a forbidden lookup as forbidden rather than as not a member", async () => {
    const adapter = adapterAnswering(ipAllowListRefusal);

    await expect(
      adapter.getReviewCommentTarget({ profile, pr, commentId: "PRRC_1" }),
    ).resolves.toEqual({
      _tag: "err",
      error: {
        _tag: "GitHubForbidden",
        operation: "get_comment_target",
        reason: "ip_allow_list",
      },
    });
  });

  it("reports a lookup that never reached GitHub as a read failure", async () => {
    const adapter = adapterAnswering({ _tag: "CommandUnavailable" });

    await expect(
      adapter.getReviewCommentTarget({ profile, pr, commentId: "PRRC_1" }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "GitHubReadFailed", operation: "get_comment_target" },
    });
  });
});
