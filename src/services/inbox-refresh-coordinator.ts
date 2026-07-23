import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { Result } from "../domain/result";
import type { MaintainerInbox, MaintainerInboxService } from "./maintainer-inbox-service";

type ReadOnlyInbox = Pick<MaintainerInboxService, "list">;

/**
 * Coalesces concurrent inbox scans for one profile. Its narrow dependency is
 * deliberately read-only: refreshing cannot prepare, restart, or mutate reviews.
 */
export class InboxRefreshCoordinator {
  private readonly inFlight = new Map<
    WorkspaceProfileConfig["id"],
    Promise<Result<MaintainerInbox, never>>
  >();

  constructor(private readonly inbox: ReadOnlyInbox) {}

  refresh(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<MaintainerInbox, never>> {
    const existing = this.inFlight.get(profile.id);
    if (existing !== undefined) return existing;

    const request = this.inbox.list(profile).finally(() => {
      this.inFlight.delete(profile.id);
    });
    this.inFlight.set(profile.id, request);
    return request;
  }
}
