import { expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";

import { UnifiedReviewMigration } from "../../src/services/unified-review-migration";
import type { Review } from "../../src/domain/review";
import type { ReviewSession } from "../../src/domain/review-session";
import { createReviewSession } from "../../src/domain/review-session";
import { ReviewSessionStore, parseStoredReviewSession } from "../../src/adapters/storage/review-session-store";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import { ReviewRemoteStore } from "../../src/adapters/storage/review-remote-store";
import { InsightStore } from "../../src/adapters/storage/insight-store";
import { createReviewSessionId, parseAbsolutePath, parseGitSha, parseWorkspaceProfileId, type ReviewSessionId } from "../../src/domain/ids";
import { err, ok } from "../../src/domain/result";

const profileResult = parseWorkspaceProfileId("cfw");
if (profileResult._tag === "err") throw new Error("fixture");
const profileId = profileResult.value;
const session = (id: string, updatedAt: string, state: "Created" | "Merged"): ReviewSession => ({ id: id as ReviewSessionId, key: { profileId, host: "github.com", owner: "centraldigital", repo: "patchdesk", prNumber: 42, headSha: `${id.slice(-1).repeat(40)}` as never }, state: { _tag: state }, createdAt: "2026-08-01T00:00:00.000Z" as never, updatedAt: updatedAt as never } as unknown as ReviewSession);

it("adopts one deterministic current session and is idempotent", async () => {
  const older = session("github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__aaaaaaaaaaaa", "2026-08-01T01:00:00.000Z", "Created");
  const terminal = session("github.com__centraldigital__patchdesk__pr-42__sha-bbbbbbbb__bbbbbbbbbbbb", "2026-08-01T00:00:00.000Z", "Merged");
  const sessions = [older, terminal];
  const saved: Array<{ readonly id: string; readonly currentSessionId: ReviewSessionId }> = [];
  const reviews = new Map<string, unknown>();
  const migration = new UnifiedReviewMigration(
    { async listSessions() { return ok(sessions); } },
    { async load(_profile, id) { return reviews.has(id) ? ok(reviews.get(id) as Review) : err({ _tag: "StorageFailure" as const, operation: "read" as const, reason: "not_found" as const }); }, async save(review: Review) { reviews.set(review.id, review); saved.push({ id: review.id, currentSessionId: review.currentSessionId }); return ok(undefined); } },
  );
  const first = await migration.migrateProfile(profileId);
  expect(first).toMatchObject({ _tag: "ok", value: { migrated: [{ currentSessionId: terminal.id }] } });
  const second = await migration.migrateProfile(profileId);
  expect(second).toMatchObject({ _tag: "ok", value: { migrated: [] } });
  expect(saved).toHaveLength(1);
});

it("selects the latest valid retained artifact per type across every session", async () => {
  const older = { ...session("github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__aaaaaaaaaaaa", "2026-08-01T01:00:00.000Z", "Created"), visibleResult: { changeSummary: "retained", verdict: "approve", summary: "summary", findings: [], validationPlan: [], assumptions: [] } } as ReviewSession;
  const newerInvalid = { ...session("github.com__centraldigital__patchdesk__pr-42__sha-bbbbbbbb__bbbbbbbbbbbb", "2026-08-01T02:00:00.000Z", "Created"), visibleResult: { invalid: true } } as unknown as ReviewSession;
  const records = new Map<string, unknown>();
  const migration = new UnifiedReviewMigration(
    { async listSessions() { return ok([older, newerInvalid]); } },
    { async load(_profile, id) { return records.has(id) ? ok(records.get(id) as Review) : err({ _tag: "StorageFailure" as const, operation: "read" as const, reason: "not_found" as const }); }, async save(review: Review) { records.set(review.id, review); return ok(undefined); } },
    { insights: { async load(_profile, _reviewId, type) { const value = records.get(type); return value === undefined ? err({ _tag: "StorageFailure" as const, operation: "read" as const, reason: "not_found" as const }) : ok(value as never); }, async save(_profile, record) { records.set(record.type, record); return ok(undefined); } } },
  );
  const migrated = await migration.migrateProfile(profileId);
  expect(migrated._tag).toBe("ok");
  expect(records.get("analysis")).toMatchObject({ retained: { revision: { sessionId: older.id }, value: { changeSummary: "retained" } } });
});

it("migrates real durable remote and Review artifacts before the marker, then resumes", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-migration-durable-"));
  const paths = PatchdeskPaths.forTest(root);
  const shaResult = parseGitSha("d".repeat(40));
  const patchPathResult = parseAbsolutePath(join(root, "patch.diff"));
  if (shaResult._tag === "err" || patchPathResult._tag === "err") throw new Error("fixture");
  await writeFile(patchPathResult.value, "", "utf8");
  const durableSession = createReviewSession({
    key: { profileId, host: "github.com" as never, owner: "centraldigital" as never, repo: "patchdesk" as never, prNumber: 42 as never, headSha: shaResult.value },
    pr: { headSha: shaResult.value, isDraft: false, isOpen: true },
    prContext: { title: "Durable migration", author: "maintainer", headBranch: "feature", baseBranch: "main" },
    patchPath: patchPathResult.value,
    worktree: { path: patchPathResult.value, headSha: shaResult.value },
    createdAt: "2026-08-01T00:00:00.000Z" as never,
  });
  const sessions = new ReviewSessionStore(paths);
  const reviews = new ReviewStore(paths);
  const remote = new ReviewRemoteStore(paths, reviews);
  const insights = new InsightStore(paths);
  expect((await sessions.save(durableSession))._tag).toBe("ok");
  let interrupted = true;
  const migration = new UnifiedReviewMigration(sessions, reviews, {
    paths,
    remote,
    insights,
    afterStage: async (stage) => {
      if (stage === "remote" && interrupted) {
        interrupted = false;
        throw new Error("interrupted after remote");
      }
    },
  });
  await expect(migration.migrateProfile(profileId)).rejects.toThrow("interrupted after remote");
  const resumed = await migration.migrateProfile(profileId);
  expect(resumed._tag).toBe("ok");
  if (resumed._tag === "ok") expect(resumed.value.migrated).toHaveLength(1);
  const reviewId = (resumed._tag === "ok" && resumed.value.migrated[0] !== undefined) ? resumed.value.migrated[0].id : undefined;
  expect(reviewId).toBeDefined();
  if (reviewId === undefined) return;
  const stored = await reviews.load(profileId, reviewId);
  expect(stored).toMatchObject({ _tag: "ok", value: { representedRemote: { headSha: shaResult.value } } });
  const snapshot = await remote.load({ profileId, reviewId });
  expect(snapshot._tag).toBe("ok");
  const marker = await (async () => {
    const { readJsonFile } = await import("../../src/adapters/storage/json-file");
    return readJsonFile(paths.reviewMigrationMarkerFile(profileId));
  })();
  expect(marker._tag).toBe("ok");
  const second = await migration.migrateProfile(profileId);
  expect(second).toMatchObject({ _tag: "ok", value: { migrated: [], existing: [{ id: reviewId }] } });
});

it("preserves legacy Walkthrough and progress fields for migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-migration-walkthrough-"));
  const paths = PatchdeskPaths.forTest(root);
  const sha = parseGitSha("e".repeat(40));
  const patchPath = parseAbsolutePath(join(root, "patch.diff"));
  if (sha._tag === "err" || patchPath._tag === "err") throw new Error("fixture");
  await writeFile(patchPath.value, "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n", "utf8");
  const candidate = {
    ...session("github.com__centraldigital__patchdesk__pr-42__sha-eeeeeeee__eeeeeeeeeeee", "2026-08-01T02:00:00.000Z", "Created"),
    schemaVersion: 4 as const,
    key: { ...session("github.com__centraldigital__patchdesk__pr-42__sha-eeeeeeee__eeeeeeeeeeee", "2026-08-01T02:00:00.000Z", "Created").key, headSha: sha.value },
    id: createReviewSessionId({ ...session("github.com__centraldigital__patchdesk__pr-42__sha-eeeeeeee__eeeeeeeeeeee", "2026-08-01T02:00:00.000Z", "Created").key, headSha: sha.value }),
    pr: { headSha: sha.value, isDraft: false, isOpen: true },
    patchPath: patchPath.value,
    scope: { kind: "full" as const },
    worktree: { path: patchPath.value, headSha: sha.value },
    walkthrough: { title: "Read this change", focus: "A focused change", chapters: [{ title: "Chapter", sections: [{ title: "Section", prose: "Explain the change", hunkIds: ["h1"] }] }] },
    walkthroughProgress: { reviewedSectionIds: ["section-1"], supportReviewed: true, currentSectionId: "section-1" },
  } as unknown as ReviewSession;
  const parsed = parseStoredReviewSession(candidate);
  expect(parsed).toMatchObject({ _tag: "ok", value: { walkthrough: candidate.walkthrough, walkthroughProgress: candidate.walkthroughProgress } });
  const sessions = new ReviewSessionStore(paths);
  expect(await sessions.save(candidate)).toMatchObject({ _tag: "ok" });
  const reviews = new ReviewStore(paths);
  const insights = new InsightStore(paths);
  const migration = new UnifiedReviewMigration(sessions, reviews, { insights });
  const migrated = await migration.migrateProfile(profileId);
  expect(migrated._tag).toBe("ok");
  const reviewId = migrated._tag === "ok" ? migrated.value.migrated[0]?.id : undefined;
  expect(reviewId).toBeDefined();
  if (reviewId === undefined) return;
  const retained = await insights.load(profileId, reviewId, "walkthrough");
  expect(retained).toMatchObject({ _tag: "ok", value: { retained: { value: { title: "Read this change" } }, walkthroughProgress: { reviewedSectionIds: ["section-1"], supportReviewed: true, currentSectionId: "section-1" } } });
});

it("writes the completion marker last and resumes after an interrupted stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-migration-"));
  const paths = PatchdeskPaths.forTest(root);
  const candidate = session("github.com__centraldigital__patchdesk__pr-42__sha-cccccccc__cccccccccccc", "2026-08-01T02:00:00.000Z", "Created");
  const reviews = new Map<string, Review>();
  let interrupted = true;
  const migration = new UnifiedReviewMigration(
    { async listSessions() { return ok([candidate]); } },
    { async load(_profile, id) { return reviews.has(id) ? ok(reviews.get(id) as Review) : err({ _tag: "StorageFailure" as const, operation: "read" as const, reason: "not_found" as const }); }, async save(review: Review) { reviews.set(review.id, review); return ok(undefined); } },
    { paths, afterReview: async () => { if (interrupted) { interrupted = false; throw new Error("interrupted"); } } },
  );
  await expect(migration.migrateProfile(profileId)).rejects.toThrow("interrupted");
  const resumed = await migration.migrateProfile(profileId);
  expect(resumed).toMatchObject({ _tag: "ok", value: { migrated: [], existing: [{ currentSessionId: candidate.id }] } });
  const second = await migration.migrateProfile(profileId);
  expect(second).toMatchObject({ _tag: "ok", value: { migrated: [], existing: [{ currentSessionId: candidate.id }], skipped: 0 } });
});
