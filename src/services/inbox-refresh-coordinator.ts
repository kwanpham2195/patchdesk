import {
  DEFAULT_INBOX_PAGE_SIZE,
  type InboxPageRequest,
} from "../domain/maintainer-inbox";
import type { Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type {
  InboxPageRequestFailure,
  InboxRepositoryRef,
  MaintainerInbox,
  MaintainerInboxService,
} from "./maintainer-inbox-service";

type ReadOnlyInbox = Pick<MaintainerInboxService, "list">;

/** Coalesces only matching profile, repository, filter, size, and opaque-token inbox reads. */
export class InboxRefreshCoordinator {
  private readonly inFlight = new Map<
    string,
    Promise<Result<MaintainerInbox, InboxPageRequestFailure>>
  >();

  constructor(private readonly inbox: ReadOnlyInbox) {}

  refresh(
    profile: WorkspaceProfileConfig,
    repository: InboxRepositoryRef,
    page: InboxPageRequest = {
      filter: { state: "open" },
      pageSize: DEFAULT_INBOX_PAGE_SIZE,
    },
  ): Promise<Result<MaintainerInbox, InboxPageRequestFailure>> {
    const key = `${profile.id}:${repository.host}/${repository.owner}/${repository.repo}:${page.filter.state}:${page.pageSize}:${page.pageToken ?? "first"}`;
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing;
    const request = this.inbox.list(profile, repository, page).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return request;
  }
}
