import {
  DEFAULT_INBOX_PAGE_SIZE,
  type InboxPageRequest,
} from "../domain/maintainer-inbox";
import type { Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { normalizeInboxLabels } from "./maintainer-inbox-service";
import type {
  InboxPageRequestFailure,
  InboxRepositoryRef,
  MaintainerInbox,
  MaintainerInboxService,
} from "./maintainer-inbox-service";

type ReadOnlyInbox = Pick<MaintainerInboxService, "list">;

/** Coalesces only matching profile, repository, filter, size, and opaque-token
 * inbox reads. The filter half of that means every field of `InboxFilter` —
 * the state, label list, review/check qualifiers, and the "Awaiting review
 * from you" preset — so two reads that differ only by one of them never share
 * one in-flight promise. */
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
    // The label list is normalized with the service's own
    // `normalizeInboxLabels` (sorted and deduplicated) so that `["b","a"]` and
    // `["a","b"]` — the same GitHub search, and the same page token — share a
    // key rather than issuing two reads.
    const labels = normalizeInboxLabels(page.filter.labels).join(",");
    const awaitingMyReview = page.filter.awaitingMyReview === true ? "1" : "0";
    const reviewState = page.filter.reviewState ?? "any";
    const checkStatus = page.filter.checkStatus ?? "any";
    const key = `${profile.id}:${repository.host}/${repository.owner}/${repository.repo}:${page.filter.state}:${labels}:${awaitingMyReview}:${reviewState}:${checkStatus}:${page.pageSize}:${page.pageToken ?? "first"}`;
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing;
    const request = this.inbox.list(profile, repository, page).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return request;
  }
}
