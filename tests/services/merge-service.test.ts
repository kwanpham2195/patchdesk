import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function gateway(input: { readonly head?: typeof headSha; readonly base?: typeof headSha; readonly policyBase?: typeof headSha; readonly reviewDecision?: "approved" | "changes_requested" | "review_required" | "unknown"; readonly mergeability?: "mergeable" | "conflicting"; readonly checks?: "success" | "failure"; readonly complete?: boolean } = {}) {
  const writes: Array<string> = [];
  return { writes, gateway: {
    async getMergePolicy() { return { _tag: "ok" as const, value: { pr: { host: "github.com" as never, owner: "centraldigital" as never, repo: "patchdesk" as never, number: 1 as never }, headSha: input.head ?? headSha, baseSha: input.policyBase ?? input.base ?? headSha, isOpen: true, isDraft: false, mergeability: input.mergeability ?? "mergeable", reviewDecision: input.reviewDecision ?? "approved", checks: { overall: input.checks === "failure" ? "failing" as const : "passing" as const, checks: [{ name: "unit", required: true as const, status: "completed" as const, conclusion: input.checks === "failure" ? "failure" as const : "success" as const }] }, complete: input.complete ?? true, ...(input.complete === false ? { incompleteReason: "permission" as const } : {}) } }; },
    async getPullRequest() { return { _tag: "ok" as const, value: { ref: { host: "github.com" as never, owner: "centraldigital" as never, repo: "patchdesk" as never, number: 1 as never }, headSha: input.head ?? headSha, baseSha: input.base ?? headSha, isOpen: true, isDraft: false, title: "Fixture", author: "fixture", headBranch: "feature", baseBranch: "main", reviewState: "none" as const, mergeability: "mergeable" as const, labels: [], changedFileCount: 0, updatedAt: now } }; },
    async getPullRequestDiff() { return { _tag: "ok" as const, value: "" }; },
    async mergePullRequest(value: Parameters<GitHubMergeWriter["mergePullRequest"]>[0]) { writes.push(value.method); return { _tag: "ok" as const, value: { mergeCommitSha: headSha } }; },
  } };
}

async function representedSession(): Promise<ReviewSession> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-merge-service-"));
  roots.push(root);
  const patchPath = join(root, "review.patch");
  await writeFile(patchPath, "", "utf8");
  return { ...session, pr: { ...session.pr, baseSha: headSha }, patchPath } as unknown as ReviewSession;
}

describe("merge service", () => {
  it("merges an eligible prepared snapshot without model findings", async () => {
    const success = gateway();

    const merged = await mergePullRequest({
      profile,
      session: { ...(await representedSession()), state: { _tag: "Created" } },
      gateway: success.gateway as never,
      method: "squash",
      supportedMethods: ["squash"],
      acknowledgedWarningCodes: [],
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
    await expect(mergePullRequest({ profile, session: await representedSession(), result, gateway: unsupported.gateway as never, method: "rebase", supportedMethods: ["squash"], acknowledgedWarningCodes: [], now })).resolves.toEqual({ _tag: "err", error: { _tag: "MergeMethodUnsupported" } });
    expect(unsupported.writes).toEqual([]);

    const blocked = gateway({ checks: "failure" });
    await expect(mergePullRequest({ profile, session: await representedSession(), result, gateway: blocked.gateway as never, method: "squash", supportedMethods: ["squash"], acknowledgedWarningCodes: [], now })).resolves.toMatchObject({ _tag: "err", error: { _tag: "MergeBlocked", readiness: { blockers: ["required_check"] } } });
    expect(blocked.writes).toEqual([]);

    const stale = gateway({ head: movedHeadSha });
    await expect(mergePullRequest({ profile, session: await representedSession(), result, gateway: stale.gateway as never, method: "squash", supportedMethods: ["squash"], acknowledgedWarningCodes: [], now })).resolves.toEqual({ _tag: "err", error: { _tag: "RevisionChangedBlocksMerge" } });
    expect(stale.writes).toEqual([]);
  });

  it("does not let an unrelated warning acknowledge an analysis finding", async () => {
    const protectedProfile = { githubHost: "github.com", ghAccount: "fixture", analysisMergePolicy: "require_acknowledgement" };
    const findings = { ...result, findings: [{ severity: "P1" }] };
    const blocked = gateway();

    const merged = await mergePullRequest({ profile: protectedProfile as never, session: await representedSession(), result: findings as never, gateway: blocked.gateway as never, method: "squash", supportedMethods: ["squash"], acknowledgedWarningCodes: ["request_changes"], now });
    expect(merged).toMatchObject({ _tag: "err", error: { _tag: "MergeAcknowledgementRequired" } });
    if (merged._tag === "err" && merged.error._tag === "MergeAcknowledgementRequired") expect(merged.error.readiness.warnings).toContain("analysis_finding");
    expect(blocked.writes).toEqual([]);
  });

  it("rejects a stale warning acknowledgement when the current warning set is empty", async () => {
    const ready = gateway();

    await expect(mergePullRequest({ profile, session: await representedSession(), gateway: ready.gateway as never, method: "squash", supportedMethods: ["squash"], acknowledgedWarningCodes: ["request_changes"], now })).resolves.toMatchObject({ _tag: "err", error: { _tag: "MergeAcknowledgementRequired", readiness: { warnings: [] } } });
    expect(ready.writes).toEqual([]);
  });

  it("does not merge when the canonical base identity changed", async () => {
    const changed = gateway({ base: movedHeadSha });

    await expect(mergePullRequest({ profile, session: await representedSession(), gateway: changed.gateway as never, method: "squash", supportedMethods: ["squash"], acknowledgedWarningCodes: [], now })).resolves.toEqual({ _tag: "err", error: { _tag: "RevisionChangedBlocksMerge" } });
    expect(changed.writes).toEqual([]);
  });

  it("does not merge when the base changes after canonical proof but before final readiness", async () => {
    const changed = gateway({ policyBase: movedHeadSha });

    await expect(mergePullRequest({ profile, session: await representedSession(), gateway: changed.gateway as never, method: "squash", supportedMethods: ["squash"], acknowledgedWarningCodes: [], now })).resolves.toEqual({ _tag: "err", error: { _tag: "RevisionChangedBlocksMerge" } });
    expect(changed.writes).toEqual([]);
  });

  it("requires acknowledgement for request changes or P0/P1 findings, then records the terminal merge", async () => {
    const warning = gateway({ reviewDecision: "changes_requested" });
    await expect(mergePullRequest({ profile, session: await representedSession(), result, gateway: warning.gateway as never, method: "squash", supportedMethods: ["squash", "merge"], acknowledgedWarningCodes: [], now })).resolves.toMatchObject({ _tag: "err", error: { _tag: "MergeAcknowledgementRequired", readiness: { warnings: ["request_changes"] } } });
    expect(warning.writes).toEqual([]);

    const success = gateway({ reviewDecision: "changes_requested" });
    const merged = await mergePullRequest({ profile, session: await representedSession(), result, gateway: success.gateway as never, method: "squash", supportedMethods: ["squash", "merge"], acknowledgedWarningCodes: ["request_changes"], now });
    expect(merged).toMatchObject({ _tag: "ok", value: { session: { state: { _tag: "Merged" }, mergeDecision: { mergeCommitSha: headSha } } } });
    expect(success.writes).toEqual(["squash"]);
  });

  it("never writes when fresh policy evidence is incomplete or requires review", async () => {
    const incomplete = gateway({ complete: false });
    await expect(mergePullRequest({ profile, session: await representedSession(), gateway: incomplete.gateway as never, method: "squash", supportedMethods: ["squash"], acknowledgedWarningCodes: [], now })).resolves.toMatchObject({ _tag: "err", error: { _tag: "MergeBlocked", readiness: { blockers: ["mergeability_unknown"] } } });
    expect(incomplete.writes).toEqual([]);

    const review = gateway({ reviewDecision: "review_required" });
    await expect(mergePullRequest({ profile, session: await representedSession(), gateway: review.gateway as never, method: "squash", supportedMethods: ["squash"], acknowledgedWarningCodes: [], now })).resolves.toMatchObject({ _tag: "err", error: { _tag: "MergeBlocked", readiness: { blockers: ["github_review"] } } });
    expect(review.writes).toEqual([]);
  });
});
