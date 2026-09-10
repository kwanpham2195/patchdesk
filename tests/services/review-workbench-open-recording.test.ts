import { describe, expect, it, vi } from "vitest";

import type { Review } from "../../src/domain/review";
import { err, ok } from "../../src/domain/result";
import {
  at,
  fixture,
  profileId,
  projection,
  review,
  reviewId,
  sessionId,
} from "./review-workbench-controller-fixture";

/**
 * When `ReviewWorkbenchController` stamps `lastOpenedAt` on the durable Review,
 * which is what orders the sidebar's visited pull requests. Only the
 * maintainer's own open counts, and it counts exactly once.
 */
describe("ReviewWorkbenchController open recording", () => {
  it("records the open on the durable Review with the pull request title", async () => {
    const openedAt = "2026-09-10T09:00:00.000Z";
    const value = fixture({
      sessions: {
        load: vi.fn(async () =>
          ok({ id: sessionId, prContext: { title: "Add the sidebar" } }),
        ),
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(openedAt));
    try {
      await expect(
        value.controller.open({
          profileId,
          host: "github.com",
          owner: "centraldigital",
          repo: "patchdesk",
          number: 42,
        }),
      ).resolves.toEqual({ _tag: "ok", value: projection });
    } finally {
      vi.useRealTimers();
    }

    expect(value.lifecycle.reviews.save).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Add the sidebar",
        lastOpenedAt: openedAt,
        updatedAt: openedAt,
      }),
      at,
    );
  });

  it("records the open with the projection's title when the sidebar reaches a Review through load", async () => {
    const openedAt = "2026-09-10T09:00:00.000Z";
    const value = fixture();
    value.project.loadRepresented.mockResolvedValue(
      // SAFETY: the controller returns this projection to its caller
      // untouched and reads only the pull request title from it, so this
      // narrowing of ReviewWorkbenchProjection is all the test needs.
      ok({ pullRequest: { title: "Add the sidebar" } }) as never,
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(openedAt));
    try {
      await expect(
        value.controller.load({ profileId, reviewId, recordOpen: true }),
      ).resolves.toMatchObject({ _tag: "ok" });
    } finally {
      vi.useRealTimers();
    }

    expect(value.lifecycle.reviews.save).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Add the sidebar",
        lastOpenedAt: openedAt,
        updatedAt: openedAt,
      }),
      at,
    );
  });

  it("records nothing when load refreshes the workbench already on screen", async () => {
    // The reloads after a publish, a merge, an Insight run or a recovery all
    // reach `load` without claiming an open, and must not reorder the column.
    const value = fixture();

    await expect(
      value.controller.load({ profileId, reviewId }),
    ).resolves.toEqual({ _tag: "ok", value: projection });
    expect(value.lifecycle.reviews.save).not.toHaveBeenCalled();
  });

  it("saves once when an unusable Review is restarted and reopened", async () => {
    // `createFreshReview` already stamped and saved the open, so projecting
    // must not record it a second time under a fresh clock.
    const reviews = {
      load: vi.fn(async () => ok(review)),
      save: vi.fn(async () => ok(undefined)),
    };
    const value = fixture({
      reviews,
      sessions: {
        load: vi.fn(async () =>
          err({
            _tag: "StorageFailure" as const,
            operation: "read" as const,
            reason: "not_found" as const,
          }),
        ),
      },
    });

    await expect(
      value.controller.open({
        profileId,
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
      }),
    ).resolves.toEqual({ _tag: "ok", value: projection });
    expect(value.preparation.prepare).toHaveBeenCalledOnce();
    expect(reviews.save).toHaveBeenCalledOnce();
  });

  it("records the open on a Review whose first snapshot never landed", async () => {
    // A record left without a represented snapshot takes openUnlocked's other
    // existing-Review exit, which projected without ever recording the open.
    const openedAt = "2026-09-10T09:30:00.000Z";
    const { representedRemote: _unrepresented, ...withoutSnapshot } = review;
    const reviews = {
      load: vi
        .fn()
        .mockResolvedValueOnce(ok(withoutSnapshot))
        .mockResolvedValue(ok(review)),
      save: vi.fn(async () => ok(undefined)),
    };
    const value = fixture({
      reviews,
      sessions: {
        load: vi.fn(async () =>
          ok({ id: sessionId, prContext: { title: "Add the sidebar" } }),
        ),
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(openedAt));
    try {
      await expect(
        value.controller.open({
          profileId,
          host: "github.com",
          owner: "centraldigital",
          repo: "patchdesk",
          number: 42,
        }),
      ).resolves.toEqual({ _tag: "ok", value: projection });
    } finally {
      vi.useRealTimers();
    }

    expect(reviews.save).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Add the sidebar",
        lastOpenedAt: openedAt,
      }),
      at,
    );
  });

  it("records nothing when a closed Review refuses a merged open", async () => {
    // Recording before the Terminal check would rank a pull request the
    // maintainer could not open first in the sidebar.
    const closed: Review = {
      ...review,
      status: { _tag: "Terminal", state: "closed", observedAt: at },
    };
    const value = fixture({
      reviews: {
        load: vi.fn(async () => ok(closed)),
        save: vi.fn(async () => ok(undefined)),
      },
    });

    await expect(
      value.controller.openMerged({
        profileId,
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
      }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "terminal" } });
    expect(value.lifecycle.reviews.save).not.toHaveBeenCalled();
  });

  it("opens anyway when recording the open loses the compare-and-set", async () => {
    const logs = { write: vi.fn() };
    const value = fixture({
      reviews: {
        load: vi.fn(async () => ok(review)),
        save: vi.fn(async () =>
          err({ _tag: "ReviewConflict", reason: "stale_revision" }),
        ),
      },
      logs,
    });

    await expect(
      value.controller.open({
        profileId,
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
      }),
    ).resolves.toEqual({ _tag: "ok", value: projection });
    expect(value.lifecycle.reviews.save).toHaveBeenCalledOnce();
    expect(logs.write).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "review-workbench", level: "warn" }),
    );
  });
});
