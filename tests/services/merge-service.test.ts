import { describe, expect, it } from "vitest";

import type { GitHubMergeWriter } from "../../src/adapters/github/github-adapter";
import type { ReviewResult } from "../../src/domain/review-result";
import type { ReviewSession } from "../../src/domain/review-session";
import { mergePullRequest } from "../../src/services/merge-service";

const headSha = "abcdef1234567890abcdef1234567890abcdef12" as never;
const movedHeadSha = "fedcba9876543210fedcba9876543210fedcba98" as never;
const session = {
  id: "github.com__centraldigital__patchdesk__pr-1__sha-abcdef12__0123456789ab",
  key: { profileId: "cfw", host: "github.com", owner: "centraldigital", repo: "patchdesk", prNumber: 1, headSha },
  pr: { headSha, isDraft: false, isOpen: true },
  state: { _tag: "ReviewCompleted", attemptId: "001" },
  currentAttemptId: "001",
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
} as unknown as ReviewSession;
const result = { findings: [], changeSummary: "summary", verdict: "approve", summary: "summary", validationPlan: [], assumptions: [] } as unknown as ReviewResult;
const profile = { githubHost: "github.com", ghAccount: "pmquan2cfw" } as never;
const now = "2026-07-16T00:02:00.000Z" as never;

function gateway(input: { readonly head?: typeof headSha; readonly reviewState?: "approved" | "changes_requested" | "review_pending"; readonly mergeability?: "mergeable" | "conflicting"; readonly checks?: "success" | "failure" } = {}) {
  const writes: Array<string> = [];
  return { writes, gateway: {
    async getPullRequestChecks() { return { _tag: "ok" as const, value: { overall: input.checks === "failure" ? "failing" as const : "passing" as const, checks: [{ name: "unit", required: true as const, status: "completed" as const, conclusion: input.checks === "failure" ? "failure" as const : "success" as const }] } }; },
    async getPullRequest() { return { _tag: "ok" as const, value: { headSha: input.head ?? headSha, isOpen: true, isDraft: false, mergeability: input.mergeability ?? "mergeable", reviewState: input.reviewState ?? "approved" } }; },
    async mergePullRequest(value: Parameters<GitHubMergeWriter["mergePullRequest"]>[0]) { writes.push(value.method); return { _tag: "ok" as const, value: { mergeCommitSha: headSha } }; },
  } };
}

describe("merge service", () => {
  it("merges an eligible prepared snapshot without model findings", async () => {
    const success = gateway();

    const merged = await mergePullRequest({
      profile,
      session: { ...session, state: { _tag: "Created" } },
      gateway: success.gateway as never,
      method: "squash",
      supportedMethods: ["squash"],
      acknowledgedWarnings: true,
      now,
    });

    expect(merged).toMatchObject({
      _tag: "ok",
      value: { session: { state: { _tag: "Merged" } } },
    });
    expect(success.writes).toEqual(["squash"]);
  });

  it("does not issue a merge for unsupported methods, blockers, or a stale head", async () => {
    const unsupported = gateway();
    await expect(mergePullRequest({ profile, session, result, gateway: unsupported.gateway as never, method: "rebase", supportedMethods: ["squash"], acknowledgedWarnings: true, now })).resolves.toEqual({ _tag: "err", error: { _tag: "MergeMethodUnsupported" } });
    expect(unsupported.writes).toEqual([]);

    const blocked = gateway({ checks: "failure" });
    await expect(mergePullRequest({ profile, session, result, gateway: blocked.gateway as never, method: "squash", supportedMethods: ["squash"], acknowledgedWarnings: true, now })).resolves.toMatchObject({ _tag: "err", error: { _tag: "MergeBlocked", readiness: { blockers: ["required_check"] } } });
    expect(blocked.writes).toEqual([]);

    const stale = gateway({ head: movedHeadSha });
    await expect(mergePullRequest({ profile, session, result, gateway: stale.gateway as never, method: "squash", supportedMethods: ["squash"], acknowledgedWarnings: true, now })).resolves.toEqual({ _tag: "err", error: { _tag: "StaleHeadBlocksMerge", currentHeadSha: movedHeadSha } });
    expect(stale.writes).toEqual([]);
  });

  it("requires acknowledgement for request changes or P0/P1 findings, then records the terminal merge", async () => {
    const warning = gateway({ reviewState: "changes_requested" });
    await expect(mergePullRequest({ profile, session, result, gateway: warning.gateway as never, method: "squash", supportedMethods: ["squash", "merge"], acknowledgedWarnings: false, now })).resolves.toMatchObject({ _tag: "err", error: { _tag: "MergeAcknowledgementRequired", readiness: { warnings: ["request_changes"] } } });
    expect(warning.writes).toEqual([]);

    const success = gateway();
    const merged = await mergePullRequest({ profile, session, result, gateway: success.gateway as never, method: "squash", supportedMethods: ["squash", "merge"], acknowledgedWarnings: true, now });
    expect(merged).toMatchObject({ _tag: "ok", value: { session: { state: { _tag: "Merged" }, mergeDecision: { mergeCommitSha: headSha } } } });
    expect(success.writes).toEqual(["squash"]);
  });
});
