import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { InsightStore } from "../../src/adapters/storage/insight-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { createInsightRecord, type InsightRecord } from "../../src/domain/insight-record";
import { createReviewId, parseFindingId, parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parseInsightRunId, parseIsoTimestamp, parsePullRequestNumber, parseWorkspaceProfileId } from "../../src/domain/ids";
import { ok, type Result } from "../../src/domain/result";

const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "ok") return result.value;
  throw new Error("fixture");
};
const profileId = must(parseWorkspaceProfileId("cfw"));
const otherProfileId = must(parseWorkspaceProfileId("other"));
const reviewId = createReviewId({ profileId, host: must(parseGitHubHost("github.com")), owner: must(parseGitHubOwner("centraldigital")), repo: must(parseGitHubRepoName("patchdesk")), prNumber: must(parsePullRequestNumber(42)) });
const now = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const findingId = must(parseFindingId("finding-1"));
const runId = must(parseInsightRunId(`insight-analysis-1-${"a".repeat(12)}-${reviewId}`));

describe("InsightStore", () => {
  it("round-trips one type and isolates profile paths", async () => {
    const paths = PatchdeskPaths.forTest(await mkdtemp(join("/tmp", "patchdesk-insight-")));
    const store = new InsightStore(paths);
    const record = createInsightRecord({ reviewId, type: "analysis", updatedAt: now });
    expect((await store.save(profileId, record))._tag).toBe("ok");
    expect((await store.load(profileId, reviewId, "analysis"))).toMatchObject({ _tag: "ok", value: { reviewId, type: "analysis", nextToken: 1 } });
    expect((await store.load(otherProfileId, reviewId, "analysis"))).toMatchObject({ _tag: "err", error: { reason: "not_found" } });
  });

  it("round-trips validated finding dismissals", async () => {
    const paths = PatchdeskPaths.forTest(await mkdtemp(join("/tmp", "patchdesk-insight-")));
    const store = new InsightStore(paths);
    const record: InsightRecord<unknown> = {
      ...createInsightRecord({ reviewId, type: "analysis", updatedAt: now }),
      dismissals: [{ findingId, reason: "Not applicable.", dismissedAt: now }],
    };
    expect((await store.save(profileId, record))._tag).toBe("ok");
    expect(await store.load(profileId, reviewId, "analysis")).toMatchObject({ _tag: "ok", value: { dismissals: [{ findingId: "finding-1", reason: "Not applicable." }] } });
  });

  it("creates and reloads through a serialized mutation", async () => {
    const paths = PatchdeskPaths.forTest(await mkdtemp(join("/tmp", "patchdesk-insight-")));
    const store = new InsightStore(paths);
    const result = await store.mutate({ profileId, reviewId, type: "walkthrough", now, operation: (current) => ok({ ...current, nextToken: current.nextToken + 1, updatedAt: now }) });
    expect(result).toMatchObject({ _tag: "ok", value: { type: "walkthrough", nextToken: 2 } });
  });

  it("round-trips safe failure diagnostics and keeps legacy failures readable", async () => {
    const root = await mkdtemp(join("/tmp", "patchdesk-insight-"));
    const paths = PatchdeskPaths.forTest(root);
    const store = new InsightStore(paths);
    const record: InsightRecord<unknown> = {
      ...createInsightRecord({ reviewId, type: "analysis", updatedAt: now }),
      replacementFailure: { runId, reason: "failed", category: "rate_limited", model: "fixture-model", reasoning: "high", retryable: true, failedAt: now },
    };
    expect(await store.save(profileId, record)).toMatchObject({ _tag: "ok" });
    expect(await store.load(profileId, reviewId, "analysis")).toMatchObject({ _tag: "ok", value: { replacementFailure: { category: "rate_limited", model: "fixture-model", reasoning: "high" } } });
    await writeFile(paths.insightFile(profileId, reviewId, "walkthrough"), JSON.stringify({ schemaVersion: 1, reviewId, type: "walkthrough", nextToken: 1, replacementFailure: { runId, reason: "failed", retryable: true, failedAt: now }, updatedAt: now }), "utf8");
    expect(await store.load(profileId, reviewId, "walkthrough")).toMatchObject({ _tag: "ok", value: { replacementFailure: { runId: expect.any(String) } } });
  });

  it("preserves run state when typed retained content is absent", async () => {
    const paths = PatchdeskPaths.forTest(await mkdtemp(join("/tmp", "patchdesk-insight-")));
    const store = new InsightStore(paths);
    const sessionId = "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__000000000000";
    await mkdir(paths.insightDirectory(profileId, reviewId), { recursive: true });
    await writeFile(paths.insightFile(profileId, reviewId, "analysis"), JSON.stringify({
      schemaVersion: 1,
      reviewId,
      type: "analysis",
      nextToken: 2,
      activeRun: { id: runId, type: "analysis", revision: { sessionId, headSha: "a".repeat(40), patchHash: "b".repeat(64) }, token: 1, model: "fixture-model", reasoning: "medium", status: "queued", startedAt: now },
      replacementFailure: { runId, reason: "failed", category: "unexpected_failure", retryable: true, failedAt: now },
      updatedAt: now,
    }), "utf8");

    const loaded = await store.loadTyped(profileId, reviewId, "analysis", () => {
      throw new Error("retained parser must not run");
    });
    expect(loaded).toMatchObject({ _tag: "ok", value: { activeRun: { id: runId }, replacementFailure: { runId, category: "unexpected_failure" } } });
  });

  it("rejects malformed stored JSON", async () => {
    const paths = PatchdeskPaths.forTest(await mkdtemp(join("/tmp", "patchdesk-insight-")));
    const store = new InsightStore(paths);
    await mkdir(paths.insightDirectory(profileId, reviewId), { recursive: true });
    await writeFile(paths.insightFile(profileId, reviewId, "analysis"), JSON.stringify({ schemaVersion: 1, reviewId, type: "analysis", nextToken: 0 }), "utf8");
    expect(await store.load(profileId, reviewId, "analysis")).toMatchObject({ _tag: "err", error: { reason: "invalid_stored_value" } });
  });
});
