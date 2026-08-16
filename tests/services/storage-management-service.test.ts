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
const sessionId = createReviewSessionId({
  profileId,
  host: "github.com" as never,
  owner: "centraldigital" as never,
  repo: "patchdesk" as never,
  prNumber: 42 as never,
  headSha: "a".repeat(40) as never,
});
const session = {
  id: sessionId,
  key: {
    profileId,
    host: "github.com",
    owner: "centraldigital",
    repo: "patchdesk",
    prNumber: 42,
    headSha: "a".repeat(40),
  },
  updatedAt: at,
} as unknown as ReviewSession;

function value<T>(result: Result<T, unknown>): T {
  if (result._tag === "ok") return result.value;
  throw new Error("Invalid test fixture");
}

afterEach(
  async () =>
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ),
);

async function fixture(
  options: {
    readonly review?: unknown;
    readonly reviewLoader?: (reviewId: string) => Result<unknown, unknown>;
    readonly analysis?: unknown;
    readonly walkthrough?: unknown;
    readonly merge?: unknown;
    readonly pending?: unknown;
    readonly direct?: unknown;
    readonly sessions?: ReadonlyArray<ReviewSession>;
    readonly quarantined?: ReadonlyArray<{
      readonly entryName: string;
      readonly quarantinedAt: string;
    }>;
    readonly removeSessionErrors?: number;
    readonly removeQuarantinedErrors?: number;
    readonly diagnostics?: unknown;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-storage-management-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  const retained = {
    ...session,
    ...(options.pending === undefined
      ? {}
      : { pendingReview: options.pending }),
    ...(options.direct === undefined
      ? {}
      : { directSummaryReview: options.direct }),
  };
  let removeSessionErrors = options.removeSessionErrors ?? 0;
  const removeSession = vi.fn(
    async (profile: unknown, sessionIdValue: unknown) => {
      void profile;
      void sessionIdValue;
      if (removeSessionErrors > 0) {
        removeSessionErrors -= 1;
        return err({
          _tag: "StorageFailure",
          operation: "write",
          reason: "io",
        } as never);
      }
      return ok(undefined);
    },
  );
  let removeQuarantinedErrors = options.removeQuarantinedErrors ?? 0;
  const removeQuarantined = vi.fn(
    async (profile: unknown, entryNameValue: unknown) => {
      void profile;
      void entryNameValue;
      if (removeQuarantinedErrors > 0) {
        removeQuarantinedErrors -= 1;
        return err({
          _tag: "StorageFailure",
          operation: "write",
          reason: "io",
        } as never);
      }
      return ok(undefined);
    },
  );
  const service = new StorageManagementService({
    profiles: {
      async load() {
        return ok({ id: profileId });
      },
    },
    sessions: {
      async listSessions() {
        return ok(options.sessions ?? [retained]);
      },
      async load() {
        return ok(retained);
      },
      async scanSessionEntries() {
        return ok({ sessions: [retained], invalidEntries: [] });
      },
    },
    reviews: {
      async load(_profile: unknown, reviewId: unknown) {
        if (options.reviewLoader !== undefined)
          return options.reviewLoader(String(reviewId));
        return options.review === undefined
          ? err({ reason: "not_found" } as never)
          : ok(options.review as never);
      },
    },
    insights: {
      async load(_profile: unknown, _review: unknown, type: string) {
        const value =
          type === "analysis" ? options.analysis : options.walkthrough;
        return value === undefined
          ? err({ reason: "not_found" } as never)
          : ok(value as never);
      },
    },
    mergeOperations: {
      async load() {
        return options.merge === undefined
          ? err({ reason: "not_found" } as never)
          : ok(options.merge as never);
      },
    },
    artifacts: {
      async listQuarantined() {
        return ok(options.quarantined ?? []);
      },
      async cacheBytes() {
        return ok(0);
      },
      async removeSession(profile: unknown, session: unknown) {
        return await removeSession(profile, session);
      },
      async removeQuarantined(profile: unknown, entryName: unknown) {
        return await removeQuarantined(profile, entryName);
      },
      async cacheChildren() {
        return ok([]);
      },
      async removeCacheChildren() {
        return ok(undefined);
      },
      async quarantine() {
        return ok({ entryName: "x" });
      },
      async quarantineInvalidEntry() {
        return ok({ entryName: "x" });
      },
    },
    paths,
    git: {},
    now: () => at,
    ...(options.diagnostics === undefined
      ? {}
      : { diagnostics: options.diagnostics }),
  } as never);
  return { service, removeSession, removeQuarantined, paths };
}

describe("StorageManagementService", () => {
  it("makes an unowned immutable session discardable", async () => {
    const value = await fixture();
    await expect(value.service.list(profileId)).resolves.toMatchObject({
      _tag: "ok",
      value: { sessions: [{ id: sessionId, canDiscard: true }] },
    });
    await expect(
      value.service.discard({ profileId, sessionId }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
    expect(value.removeSession).toHaveBeenCalledWith(profileId, sessionId);
  });

  it.each([
    [
      "current Open Review",
      {
        currentSessionId: sessionId,
        status: { _tag: "Open" },
      },
      undefined,
      undefined,
      undefined,
      undefined,
    ],
    [
      "active Analysis",
      undefined,
      { activeRun: { revision: { sessionId } } },
      undefined,
      undefined,
      undefined,
    ],
    [
      "active Walkthrough",
      undefined,
      undefined,
      { activeRun: { revision: { sessionId } } },
      undefined,
      undefined,
    ],
    [
      "unresolved merge",
      undefined,
      undefined,
      undefined,
      undefined,
      { state: { _tag: "OutcomeUnknown" } },
    ],
  ] as const)(
    "protects %s evidence",
    async (_label, review, analysis, walkthrough, _unused, merge) => {
      const value = await fixture({ review, analysis, walkthrough, merge });
      await expect(
        value.service.discard({ profileId, sessionId }),
      ).resolves.toEqual({ _tag: "err", error: { _tag: "SessionProtected" } });
      expect(value.removeSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["uncertain pending review", { _tag: "OutcomeUnknown" }, undefined],
    ["in-flight direct summary", undefined, { _tag: "WriteInFlight" }],
  ] as const)("protects %s writes", async (_label, pending, direct) => {
    const value = await fixture({ pending, direct });
    await expect(
      value.service.discard({ profileId, sessionId }),
    ).resolves.toEqual({ _tag: "err", error: { _tag: "SessionProtected" } });
  });

  it("protects an active preparation journal before touching durable state", async () => {
    const value = await fixture();
    await expect(
      ReviewPreparationJournal.begin(value.paths, profileId, sessionId),
    ).resolves.toMatchObject({ _tag: "ok" });
    await expect(
      value.service.discard({ profileId, sessionId }),
    ).resolves.toEqual({ _tag: "err", error: { _tag: "SessionProtected" } });
    expect(value.removeSession).not.toHaveBeenCalled();
  });

  describe("sweepRetained", () => {
    const terminalReview = {
      currentSessionId: sessionId,
      status: { _tag: "Terminal", state: "merged" },
    };
    const oldSession = {
      ...session,
      updatedAt: "2026-07-01T00:00:00.000Z",
    } as unknown as ReviewSession;

    it("removes a terminal session older than 14 days with its worktree", async () => {
      const value = await fixture({
        review: terminalReview,
        sessions: [oldSession],
      });
      await expect(
        value.service.sweepRetained(profileId, at),
      ).resolves.toMatchObject({ _tag: "ok" });
      expect(value.removeSession).toHaveBeenCalledWith(profileId, sessionId);
    });

    it("keeps a terminal session younger than 14 days", async () => {
      const value = await fixture({
        review: terminalReview,
        sessions: [session],
      });
      await expect(
        value.service.sweepRetained(profileId, at),
      ).resolves.toMatchObject({ _tag: "ok" });
      expect(value.removeSession).not.toHaveBeenCalled();
    });

    it("keeps the current session of an open review", async () => {
      const value = await fixture({
        review: { currentSessionId: sessionId, status: { _tag: "Open" } },
        sessions: [oldSession],
      });
      await expect(
        value.service.sweepRetained(profileId, at),
      ).resolves.toMatchObject({ _tag: "ok" });
      expect(value.removeSession).not.toHaveBeenCalled();
    });

    it("keeps a session with an active preparation journal", async () => {
      const value = await fixture({ sessions: [oldSession] });
      await expect(
        ReviewPreparationJournal.begin(value.paths, profileId, sessionId),
      ).resolves.toMatchObject({ _tag: "ok" });
      await expect(
        value.service.sweepRetained(profileId, at),
      ).resolves.toMatchObject({ _tag: "ok" });
      expect(value.removeSession).not.toHaveBeenCalled();
    });

    it("keeps a session with an active insight run", async () => {
      const value = await fixture({
        analysis: { activeRun: { revision: { sessionId } } },
        sessions: [oldSession],
      });
      await expect(
        value.service.sweepRetained(profileId, at),
      ).resolves.toMatchObject({ _tag: "ok" });
      expect(value.removeSession).not.toHaveBeenCalled();
    });

    it("keeps a session with a write in flight", async () => {
      const value = await fixture({
        sessions: [
          {
            ...oldSession,
            pendingReview: { _tag: "WriteInFlight" },
          } as unknown as ReviewSession,
        ],
      });
      await expect(
        value.service.sweepRetained(profileId, at),
      ).resolves.toMatchObject({ _tag: "ok" });
      expect(value.removeSession).not.toHaveBeenCalled();
    });

    it("removes an orphaned session older than 14 days", async () => {
      const value = await fixture({ sessions: [oldSession] });
      await expect(
        value.service.sweepRetained(profileId, at),
      ).resolves.toMatchObject({ _tag: "ok" });
      expect(value.removeSession).toHaveBeenCalledWith(profileId, sessionId);
    });

    it("removes a quarantine entry older than 30 days", async () => {
      const value = await fixture({
        quarantined: [
          {
            entryName: "x",
            quarantinedAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      });
      await expect(
        value.service.sweepRetained(profileId, at),
      ).resolves.toMatchObject({ _tag: "ok" });
      expect(value.removeQuarantined).toHaveBeenCalledWith(profileId, "x");
    });

    it("keeps a quarantine entry younger than 30 days", async () => {
      const value = await fixture({
        quarantined: [
          {
            entryName: "x",
            quarantinedAt: "2026-07-25T00:00:00.000Z",
          },
        ],
      });
      await expect(
        value.service.sweepRetained(profileId, at),
      ).resolves.toMatchObject({ _tag: "ok" });
      expect(value.removeQuarantined).not.toHaveBeenCalled();
    });

    it("keeps sweeping past per-item storage errors", async () => {
      const second = createReviewSessionId({
        profileId,
        host: "github.com" as never,
        owner: "centraldigital" as never,
        repo: "patchdesk" as never,
        prNumber: 43 as never,
        headSha: "b".repeat(40) as never,
      });
      const value = await fixture({
        removeSessionErrors: 1,
        sessions: [
          oldSession,
          {
            ...session,
            id: second,
            key: { ...session.key, prNumber: 43, headSha: "b".repeat(40) },
            updatedAt: "2026-07-01T00:00:00.000Z",
          } as unknown as ReviewSession,
        ],
        reviewLoader: () =>
          ok({ status: { _tag: "Terminal", state: "merged" } } as never),
      });
      await expect(
        value.service.sweepRetained(profileId, at),
      ).resolves.toMatchObject({ _tag: "ok" });
      expect(value.removeSession).toHaveBeenCalledTimes(2);
    });

    it("records a cleanup diagnostic for discarded sessions", async () => {
      const record = vi.fn(async () => ok(undefined));
      const value = await fixture({
        review: terminalReview,
        sessions: [oldSession],
        diagnostics: { record },
      });
      await expect(
        value.service.sweepRetained(profileId, at),
      ).resolves.toMatchObject({ _tag: "ok" });
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "cleanup",
          phase: "retention_sweep",
          sessionId,
        }),
      );
    });
  });
});
