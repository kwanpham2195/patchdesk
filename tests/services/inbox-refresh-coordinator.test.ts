import { describe, expect, it, vi } from "vitest";

import { InboxRefreshCoordinator } from "../../src/services/inbox-refresh-coordinator";
import type { MaintainerInbox } from "../../src/services/maintainer-inbox-service";
import type { WorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { ok } from "../../src/domain/result";

// SAFETY: InboxRefreshCoordinator reads only the profile id to separate
// in-flight requests; these fixtures provide that sole dependency.
const profile = { id: "cfw" } as WorkspaceProfileConfig;
// SAFETY: InboxRefreshCoordinator reads only the profile id to separate
// in-flight requests; these fixtures provide that sole dependency.
const secondProfile = { id: "other" } as WorkspaceProfileConfig;
const inbox = {
  scope: "open",
  page: 1,
  rows: [],
  repositories: [],
  dataFreshness: "fresh",
  snapshot: { state: "current" },
  directEntryAvailable: true,
} satisfies MaintainerInbox;

describe("inbox refresh coordinator", () => {
  it("shares one read-only inbox scan for concurrent callers in the same profile", async () => {
    let resolveScan:
      | ((value: ReturnType<typeof ok<MaintainerInbox>>) => void)
      | undefined;
    const scan = new Promise<ReturnType<typeof ok<MaintainerInbox>>>(
      (resolve) => {
        resolveScan = resolve;
      },
    );
    const list = vi.fn(() => scan);
    const coordinator = new InboxRefreshCoordinator({ list });

    const automatic = coordinator.refresh(profile);
    const manual = coordinator.refresh(profile);

    expect(list).toHaveBeenCalledTimes(1);
    expect(automatic).toBe(manual);
    resolveScan?.(ok(inbox));
    await expect(manual).resolves.toEqual(ok(inbox));

    await coordinator.refresh(profile);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps scans isolated per profile", async () => {
    const list = vi.fn(async () => ok(inbox));
    const coordinator = new InboxRefreshCoordinator({ list });

    await Promise.all([
      coordinator.refresh(profile),
      coordinator.refresh(secondProfile),
    ]);

    expect(list).toHaveBeenCalledTimes(2);
  });
});

it("does not coalesce different page tokens for the same profile", async () => {
  let resolveFirst:
    | ((value: ReturnType<typeof ok<MaintainerInbox>>) => void)
    | undefined;
  const first = new Promise<ReturnType<typeof ok<MaintainerInbox>>>(
    (resolve) => {
      resolveFirst = resolve;
    },
  );
  const list = vi.fn(
    (_: WorkspaceProfileConfig, page?: { readonly pageToken?: string }) =>
      page?.pageToken === undefined ? first : Promise.resolve(ok(inbox)),
  );
  const coordinator = new InboxRefreshCoordinator({ list });

  const firstPage = coordinator.refresh(profile, { scope: "open" });
  const nextPage = coordinator.refresh(profile, {
    scope: "open",
    pageToken: "opaque-next-page",
  });

  expect(list).toHaveBeenCalledTimes(2);
  resolveFirst?.(ok(inbox));
  await expect(Promise.all([firstPage, nextPage])).resolves.toEqual([
    ok(inbox),
    ok(inbox),
  ]);
});
