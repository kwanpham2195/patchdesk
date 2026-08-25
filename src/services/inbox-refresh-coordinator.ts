import type { InboxPageRequest } from "../domain/maintainer-inbox";
import type { Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type {
  InboxPageRequestFailure,
  MaintainerInbox,
  MaintainerInboxService,
} from "./maintainer-inbox-service";

type ReadOnlyInbox = Pick<MaintainerInboxService, "list">;

/** Coalesces only matching profile, scope, and opaque-token inbox reads. */
export class InboxRefreshCoordinator {
  private readonly inFlight = new Map<
    string,
    Promise<Result<MaintainerInbox, InboxPageRequestFailure>>
  >();

  constructor(private readonly inbox: ReadOnlyInbox) {}

  refresh(
    profile: WorkspaceProfileConfig,
    page: InboxPageRequest = { scope: "open" },
  ): Promise<Result<MaintainerInbox, InboxPageRequestFailure>> {
    const key = `${profile.id}:${page.scope}:${page.pageToken ?? "first"}`;
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing;
    const request = this.inbox.list(profile, page).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return request;
  }
}
