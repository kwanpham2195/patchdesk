import { expect, it } from "vitest";

import { UnifiedReviewMigration } from "../../src/services/unified-review-migration";
import type { Review } from "../../src/domain/review";
import type { ReviewSession } from "../../src/domain/review-session";
import { parseWorkspaceProfileId, type ReviewSessionId } from "../../src/domain/ids";
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
