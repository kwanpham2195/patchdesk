import { describe, expect, it, vi } from "vitest";

import { InboxRefreshCoordinator } from "../../src/services/inbox-refresh-coordinator";
import type { MaintainerInbox } from "../../src/services/maintainer-inbox-service";
import type { WorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { ok } from "../../src/domain/result";

const profile = { id: "cfw" } as WorkspaceProfileConfig;
const secondProfile = { id: "other" } as WorkspaceProfileConfig;
const inbox = {
  rows: [],
  repositories: [],
  dataFreshness: "fresh",
  snapshot: { state: "current" },
  directEntryAvailable: true,
} as MaintainerInbox;

describe("inbox refresh coordinator", () => {
  it("shares one read-only inbox scan for concurrent callers in the same profile", async () => {
    let resolveScan: ((value: ReturnType<typeof ok<MaintainerInbox>>) => void) | undefined;
    const scan = new Promise<ReturnType<typeof ok<MaintainerInbox>>>((resolve) => {
      resolveScan = resolve;
    });
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

    await Promise.all([coordinator.refresh(profile), coordinator.refresh(secondProfile)]);

    expect(list).toHaveBeenCalledTimes(2);
  });
});
