import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { createReviewSessionId, parseIsoTimestamp } from "../../src/domain/ids";
import type { ReviewSession } from "../../src/domain/review-session";
import type { Result } from "../../src/domain/result";
import { err, ok } from "../../src/domain/result";
import { ReviewPreparationJournal } from "../../src/services/review-preparation-journal";
import { StorageManagementService } from "../../src/services/storage-management-service";

const roots: string[] = [];
const profileId = "cfw" as never;
const at = value(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const sessionId = createReviewSessionId({ profileId, host: "github.com" as never, owner: "centraldigital" as never, repo: "patchdesk" as never, prNumber: 42 as never, headSha: "a".repeat(40) as never });
const session = { id: sessionId, key: { profileId, host: "github.com", owner: "centraldigital", repo: "patchdesk", prNumber: 42, headSha: "a".repeat(40) }, updatedAt: at } as unknown as ReviewSession;

function value<T>(result: Result<T, unknown>): T {
  if (result._tag === "ok") return result.value;
  throw new Error("Invalid test fixture");
}

afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(options: { readonly review?: unknown; readonly analysis?: unknown; readonly walkthrough?: unknown; readonly merge?: unknown; readonly pending?: unknown; readonly direct?: unknown } = {}) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-storage-management-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  const retained = { ...session, ...(options.pending === undefined ? {} : { pendingReview: options.pending }), ...(options.direct === undefined ? {} : { directSummaryReview: options.direct }) };
  const removeSession = vi.fn(
    async (profile: unknown, sessionIdValue: unknown) => {
      void profile;
      void sessionIdValue;
      return ok(undefined);
    },
  );
  const service = new StorageManagementService({
    profiles: { async load() { return ok({ id: profileId }); } },
    sessions: { async listSessions() { return ok([retained]); }, async load() { return ok(retained); }, async scanSessionEntries() { return ok({ sessions: [retained], invalidEntries: [] }); } },
    reviews: { async load() { return options.review === undefined ? err({ reason: "not_found" } as never) : ok(options.review as never); } },
    insights: { async load(_profile: unknown, _review: unknown, type: string) { const value = type === "analysis" ? options.analysis : options.walkthrough; return value === undefined ? err({ reason: "not_found" } as never) : ok(value as never); } },
    mergeOperations: { async load() { return options.merge === undefined ? err({ reason: "not_found" } as never) : ok(options.merge as never); } },
    artifacts: { async listQuarantined() { return ok([]); }, async cacheBytes() { return ok(0); }, async removeSession(profile: unknown, session: unknown) { return await removeSession(profile, session); }, async cacheChildren() { return ok([]); }, async removeCacheChildren() { return ok(undefined); }, async quarantine() { return ok({ entryName: "x" }); }, async quarantineInvalidEntry() { return ok({ entryName: "x" }); } },
    paths,
    git: {},
    now: () => at,
  } as never);
  return { service, removeSession, paths };
}

describe("StorageManagementService", () => {
  it("makes an unowned immutable session discardable", async () => {
    const value = await fixture();
    await expect(value.service.list(profileId)).resolves.toMatchObject({ _tag: "ok", value: { sessions: [{ id: sessionId, canDiscard: true }] } });
    await expect(value.service.discard({ profileId, sessionId })).resolves.toEqual({ _tag: "ok", value: undefined });
    expect(value.removeSession).toHaveBeenCalledWith(profileId, sessionId);
  });

  it.each([
    ["current Review", { currentSessionId: sessionId }, undefined, undefined, undefined, undefined],
    ["active Analysis", undefined, { activeRun: { revision: { sessionId } } }, undefined, undefined, undefined],
    ["active Walkthrough", undefined, undefined, { activeRun: { revision: { sessionId } } }, undefined, undefined],
    ["unresolved merge", undefined, undefined, undefined, undefined, { state: { _tag: "OutcomeUnknown" } }],
  ] as const)("protects %s evidence", async (_label, review, analysis, walkthrough, _unused, merge) => {
    const value = await fixture({ review, analysis, walkthrough, merge });
    await expect(value.service.discard({ profileId, sessionId })).resolves.toEqual({ _tag: "err", error: { _tag: "SessionProtected" } });
    expect(value.removeSession).not.toHaveBeenCalled();
  });

  it.each([
    ["uncertain pending review", { _tag: "OutcomeUnknown" }, undefined],
    ["in-flight direct summary", undefined, { _tag: "WriteInFlight" }],
  ] as const)("protects %s writes", async (_label, pending, direct) => {
    const value = await fixture({ pending, direct });
    await expect(value.service.discard({ profileId, sessionId })).resolves.toEqual({ _tag: "err", error: { _tag: "SessionProtected" } });
  });

  it("protects an active preparation journal before touching durable state", async () => {
    const value = await fixture();
    await expect(
      ReviewPreparationJournal.begin(value.paths, profileId, sessionId),
    ).resolves.toMatchObject({ _tag: "ok" });
    await expect(value.service.discard({ profileId, sessionId })).resolves.toEqual({ _tag: "err", error: { _tag: "SessionProtected" } });
    expect(value.removeSession).not.toHaveBeenCalled();
  });
});
