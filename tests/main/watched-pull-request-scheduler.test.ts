import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeGitHubAdapter } from "../../src/adapters/github/fake-github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { WatchedPullRequestStore } from "../../src/adapters/storage/watched-pull-request-store";
import { parseIsoTimestamp } from "../../src/domain/ids";
import type { LogEntryInput } from "../../src/domain/log-entry";
import { ok, type Result } from "../../src/domain/result";
import {
  parseWatchedPullRequests,
  type WatchedPullRequest,
  type WatchedSnapshot,
} from "../../src/domain/watched-pull-request";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { startWatchedPullRequestScheduler } from "../../src/main/watched-pull-request-scheduler";
import type { DesktopNotificationEvent } from "../../src/services/desktop-notifier";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import { WatchedPullRequestService } from "../../src/services/watched-pull-request-service";

// Written out rather than imported, so the test pins the interval it passes.
const INTERVAL_MS = 3 * 60_000;

function mustParse<T, E>(result: Result<T, E>): T {
  if (result._tag === "err") throw new Error("invalid fixture");
  return result.value;
}

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const profile = mustParse(
  parseWorkspaceProfileConfig({
    id: "acme",
    label: "ACME",
    githubHost: "github.com",
    ghAccount: "octo-dev",
    workspaceRoots: [],
    rulePaths: [],
    repos: [],
  }),
);

function watched(
  snapshot: Partial<Record<keyof WatchedSnapshot, string>> = {},
): WatchedPullRequest {
  const [entry] = mustParse(
    parseWatchedPullRequests([
      {
        ref: { host: "github.com", owner: "acme", repo: "widgets", number: 7 },
        snapshot: {
          updatedAt: "2026-09-16T10:00:00.000Z",
          headSha: "a".repeat(40),
          reviewState: "review_pending",
          checks: "pending",
          state: "open",
          ...snapshot,
        },
        watchedAt: "2026-09-16T09:00:00.000Z",
      },
    ]),
  );
  if (entry === undefined) throw new Error("invalid fixture");
  return entry;
}

async function harness() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const root = await mkdtemp(join(tmpdir(), "patchdesk-watch-scheduler-"));
  roots.push(root);
  const store = new WatchedPullRequestStore(PatchdeskPaths.forTest(root));
  await store.save(profile.id, [watched()]);
  let remote: ReadonlyArray<WatchedPullRequest> = [watched()];
  const github = new FakeGitHubAdapter({
    get watchedPullRequests() {
      return remote;
    },
  });
  const notified: DesktopNotificationEvent[] = [];
  const changedProfiles: string[] = [];
  const logs: LogEntryInput[] = [];
  const coordinator = new ReviewOperationCoordinator();
  let notificationsOn = true;
  const service = new WatchedPullRequestService({
    profiles: { load: async () => ok(profile) },
    store,
    github,
    now: () => mustParse(parseIsoTimestamp("2026-09-17T10:00:00.000Z")),
    notifier: { notify: (event) => notified.push(event) },
    onChange: (profileId) => changedProfiles.push(profileId),
  });
  const start = () =>
    startWatchedPullRequestScheduler({
      profiles: [profile],
      watched: service,
      coordinator,
      intervalMinutes: 3,
      settings: async () =>
        ok({
          enabled: notificationsOn,
          preparationAndMerge: false,
          intervalMinutes: 3,
        }),
      enabled: true,
      logs: { write: (entry) => logs.push(entry) },
    });
  /** Waits for the tick that logged line number `count`, then for the scheduler to release it. */
  const ticks = async (count: number) => {
    await vi.waitFor(() => expect(logs.length).toBeGreaterThanOrEqual(count));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    store,
    github,
    notified,
    changedProfiles,
    logs,
    coordinator,
    start,
    ticks,
    setRemote: (next: ReadonlyArray<WatchedPullRequest>) => {
      remote = next;
    },
    turnNotificationsOff: () => {
      notificationsOn = false;
    },
  };
}

describe("watched pull request scheduler", () => {
  it("reads every watched pull request in one query per tick", async () => {
    const fixture = await harness();
    const scheduler = fixture.start();
    await fixture.ticks(1);
    vi.advanceTimersByTime(INTERVAL_MS);
    await fixture.ticks(2);
    await scheduler.stop();

    expect(fixture.github.calls.readWatchedPullRequests).toHaveLength(2);
    expect(fixture.notified).toEqual([]);
  });

  it("skips a tick while a GitHub write holds one of the profile's Reviews", async () => {
    const fixture = await harness();
    fixture.coordinator.acquire(`${profile.id}:some-review`);
    const scheduler = fixture.start();
    await fixture.ticks(1);
    fixture.coordinator.release(`${profile.id}:some-review`);
    vi.advanceTimersByTime(INTERVAL_MS);
    await fixture.ticks(2);
    await scheduler.stop();

    expect(fixture.logs.map((entry) => entry.message)).toEqual([
      "skipped",
      "polled",
    ]);
    expect(fixture.github.calls.readWatchedPullRequests).toHaveLength(1);
  });

  it("asks GitHub nothing while notifications are off", async () => {
    const fixture = await harness();
    fixture.turnNotificationsOff();
    const scheduler = fixture.start();
    await fixture.ticks(1);
    await scheduler.stop();

    expect(fixture.logs).toMatchObject([
      { message: "skipped", meta: { reason: "disabled" } },
    ]);
    expect(fixture.github.calls.readWatchedPullRequests).toEqual([]);
  });

  it("notifies a change once and not again after a restart", async () => {
    const fixture = await harness();
    fixture.setRemote([watched({ updatedAt: "2026-09-17T09:00:00.000Z" })]);
    const first = fixture.start();
    await fixture.ticks(1);
    await first.stop();
    const second = fixture.start();
    await fixture.ticks(2);
    await second.stop();

    expect(fixture.notified.map((event) => event._tag)).toEqual([
      "WatchedPullRequestChanged",
    ]);
    expect(fixture.notified[0]).toMatchObject({ change: "commented" });
    expect(fixture.changedProfiles).toEqual([profile.id]);
  });

  it("unwatches a pull request after its merged notification", async () => {
    const fixture = await harness();
    fixture.setRemote([
      watched({ updatedAt: "2026-09-17T09:00:00.000Z", state: "merged" }),
    ]);
    const scheduler = fixture.start();
    await fixture.ticks(1);
    await scheduler.stop();

    expect(fixture.notified).toMatchObject([{ change: "merged" }]);
    await expect(fixture.store.load(profile.id)).resolves.toEqual({
      _tag: "ok",
      value: [],
    });
  });
});
