import type { InsightStore } from "#src/adapters/storage/insight-store";
import type { ReviewStore } from "#src/adapters/storage/review-store";
import type { AgentRunRequest } from "#src/domain/agent-run-request";
import { definedProps } from "#src/domain/defined-props";
import {
  checkoutFolderName,
  type AbsolutePath,
  type GitHubHost,
  type GitHubOwner,
  type GitHubRepoName,
  type IsoTimestamp,
  type PullRequestNumber,
  type ReviewId,
  type WorkspaceProfileId,
} from "#src/domain/ids";
import { KeyedMutex } from "#src/domain/keyed-mutex";
import type { LocalRepositoryRegistration } from "#src/domain/local-repository";
import { err, ok, type Result } from "#src/domain/result";
import { isLocalReview, type Review } from "#src/domain/review";
import type { LocalReviewSource } from "#src/domain/review-source";
import { missingCheckout } from "./local-checkout";
import type { InsightSlotStatus } from "./insight-slot-status";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";
import type { LocalRepositoryService } from "./local-repository-service";

/** How many rows the sidebar shows; a repository's local row counts once. */
const SIDEBAR_ROW_LIMIT = 20;

/**
 * The state a pull request finished in, dated with the moment Patchdesk
 * observed it. The date travels with the state so the row can say when it was
 * seen instead of implying the state is live.
 */
type SidebarTerminalState = {
  readonly state: "merged" | "closed";
  readonly observedAt: IsoTimestamp;
};

/** One visited pull request, as the sidebar renders it. */
type SidebarPullRequestRow = {
  readonly reviewId: ReviewId;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
  readonly number: PullRequestNumber;
  readonly title?: string;
  /** What the column orders and date-groups by. A guess is allowed here. */
  readonly sortedAt: IsoTimestamp;
  /**
   * When the maintainer last opened this pull request in Patchdesk, absent on a
   * record stored before Patchdesk recorded opens. The row prints an age only
   * from this, so it can never date a visit that never happened.
   */
  readonly lastOpenedAt?: IsoTimestamp;
  /** Absent while the pull request is still open. */
  readonly terminal?: SidebarTerminalState;
};

/**
 * One checkout of a repository with at least one visited local Review (#479,
 * #489). A click opens the shared Review of the branch checked out there at
 * that moment (#555), so the row names no source and no branch. `reviewIds` holds
 * every local Review of that checkout, so the row reads as selected while any
 * of them is open.
 */
type SidebarLocalRepositoryRow = {
  /** The linked worktree the row opens, and its folder name; absent for the configured checkout. */
  readonly checkout?: AbsolutePath;
  readonly checkoutName?: string;
  readonly reviewIds: ReadonlyArray<ReviewId>;
  /** The newest of the repository's local Reviews' ordering instants. */
  readonly sortedAt: IsoTimestamp;
  /** The newest recorded open among them; absent when none was recorded. */
  readonly lastOpenedAt?: IsoTimestamp;
  /** Present while one of them has an agent run request awaiting approval or its approved run active (ADR 0052 "Sidebar marker"). */
  readonly agent?: true;
  /**
   * Present when the folder the row reads no longer exists: the registration's
   * checkout (`repository`, which can be relocated) or a linked worktree's own
   * folder (`worktree`, which cannot: a moved worktree is a new source, ADR
   * 0051 and 0058). The row then opens `reviewId`, the newest of its Reviews,
   * from storage without reading the checkout.
   */
  readonly checkoutMissing?: {
    readonly reviewId: ReviewId;
    readonly path?: AbsolutePath;
    readonly scope: "repository" | "worktree";
  };
} & (
  | {
      readonly host: GitHubHost;
      readonly owner: GitHubOwner;
      readonly repo: GitHubRepoName;
    }
  | { readonly localRepositoryId: string; readonly displayName: string }
);

/** The sidebar's rows, plus how many stored Reviews could not be read. */
export type SidebarListing = {
  readonly rows: ReadonlyArray<
    SidebarPullRequestRow | SidebarLocalRepositoryRow
  >;
  readonly unreadable: number;
};

export type SidebarListingFailure = { readonly reason: "storage" };

export type SidebarListingDependencies = {
  readonly repositories: Pick<LocalRepositoryService, "list">;
  readonly reviews: Pick<ReviewStore, "list">;
  readonly insights: Pick<InsightStore, "load">;
  /** Current-format slots answer for a type that has one; the legacy record is fenced off. */
  readonly slots: Pick<InsightSlotStatus, "hasSlot" | "activeRun">;
  readonly diagnostics: Pick<ReviewDiagnosticService, "record">;
};

/**
 * Projects one workspace profile's visited Reviews into the sidebar's rows,
 * most recently opened first: one row per pull request, and one per
 * repository checkout for its local Reviews, whatever their branch or source.
 *
 * `ReviewStore.list` has no index: it opens every review file under the
 * profile, so this runs on demand for one profile rather than eagerly or
 * across every profile.
 */
export class SidebarListingService {
  private readonly slotReads = new KeyedMutex();

  constructor(private readonly dependencies: SidebarListingDependencies) {}

  async list(
    profileId: WorkspaceProfileId,
  ): Promise<Result<SidebarListing, SidebarListingFailure>> {
    const listing = await this.dependencies.reviews.list(profileId);
    if (listing._tag === "err") return err({ reason: "storage" });

    const { reviews, unreadable } = listing.value;
    if (unreadable > 0) await this.recordUnreadable(profileId, unreadable);

    const pullRequestRows: SidebarPullRequestRow[] = [];
    const localReviews = new Map<string, LocalReviewGroup>();
    for (const review of reviews) {
      if (!isLocalReview(review)) {
        const row = pullRequestRow(review);
        if (row !== undefined) pullRequestRows.push(row);
        continue;
      }
      const { identityKey, source } = review.identity;
      // Working-tree and branch Reviews stored before the shared Review (#555) are not listed.
      if (source.kind === "working_tree" || source.kind === "branch") continue;
      const key = JSON.stringify([identityKey, source.checkout ?? null]);
      localReviews.set(key, [review, ...(localReviews.get(key) ?? [])]);
    }
    const groups = [...localReviews.values()];
    const registrations = groups.some(
      (group) => group[0].identity.identityKey.kind === "local",
    )
      ? await this.dependencies.repositories.list(profileId)
      : ok([]);
    if (registrations._tag === "err") return err({ reason: "storage" });
    const [activity, worktreeGone] = await Promise.all([
      Promise.all(
        groups.map((group) => this.hasAgentActivity(profileId, group)),
      ),
      Promise.all(
        groups.map(async (group) => {
          const { checkout } = group[0].identity.source;
          return (
            checkout !== undefined &&
            (await missingCheckout(checkout)) !== undefined
          );
        }),
      ),
    ]);
    const localRows: SidebarLocalRepositoryRow[] = [];
    for (const [index, group] of groups.entries()) {
      const agent = activity[index];
      if (agent === undefined || agent._tag === "err")
        return err({ reason: "storage" });
      const row = localRepositoryRow(
        group,
        registrations.value,
        worktreeGone[index] === true,
      );
      if (row._tag === "err") return row;
      localRows.push({
        ...row.value,
        ...definedProps({ agent: agent.value ? (true as const) : undefined }),
      });
    }
    const rows = [...pullRequestRows, ...localRows]
      .sort((left, right) => right.sortedAt.localeCompare(left.sortedAt))
      .slice(0, SIDEBAR_ROW_LIMIT);
    return ok({ rows, unreadable });
  }

  /** Whether any of the Reviews has an agent run request awaiting approval, or an approved one whose run is still active. A failed slot lookup or read fails the listing: it cannot say no run is active. */
  private async hasAgentActivity(
    profileId: WorkspaceProfileId,
    reviews: LocalReviewGroup,
  ): Promise<Result<boolean, SidebarListingFailure>> {
    const approved: Array<{
      readonly reviewId: ReviewId;
      readonly request: Extract<AgentRunRequest, { status: "approved" }>;
    }> = [];
    for (const review of reviews)
      for (const request of review.agentRunRequests ?? []) {
        if (request.sessionId !== review.currentSessionId) continue;
        if (request.status === "awaiting_approval") return ok(true);
        if (request.status === "approved")
          approved.push({ reviewId: review.id, request });
      }
    const active = await Promise.all(
      approved.map(async ({ reviewId, request }) => {
        const key = { profileId, reviewId, type: request.type };
        const slotted = await this.dependencies.slots.hasSlot(key);
        if (slotted._tag === "err") return err({ reason: "storage" as const });
        if (slotted.value)
          // One lane for every row: slot reads go through the artifact worker, which refuses more than four pending reads.
          return this.slotReads.run("sidebar", async () => {
            const run = await this.dependencies.slots.activeRun(key);
            if (run._tag === "err") return err({ reason: "storage" as const });
            const activeRunId: string | undefined = run.value?.runId;
            return ok(
              activeRunId !== undefined && activeRunId === request.runId,
            );
          });
        const record = await this.dependencies.insights.load(
          profileId,
          reviewId,
          request.type,
        );
        return ok(
          record._tag === "ok" && record.value.activeRun?.id === request.runId,
        );
      }),
    );
    const failure = active.find((result) => result._tag === "err");
    if (failure !== undefined) return err({ reason: "storage" });
    return ok(active.some((result) => result._tag === "ok" && result.value));
  }

  private async recordUnreadable(
    profileId: WorkspaceProfileId,
    unreadable: number,
  ): Promise<void> {
    try {
      await this.dependencies.diagnostics.record({
        profileId,
        category: "recovery",
        phase: "sidebar-listing-unreadable",
        retryable: true,
        detail: `unreadable_reviews=${unreadable}`,
      });
    } catch {
      // Diagnostics are best effort and never become an unhandled rejection.
    }
  }
}

function pullRequestRow(review: Review): SidebarPullRequestRow | undefined {
  const { source, identityKey } = review.identity;
  if (source.kind !== "pull_request" || identityKey.kind !== "github")
    return undefined;
  const { owner, repo } = identityKey;
  return {
    reviewId: review.id,
    owner,
    repo,
    number: source.prNumber,
    // An empty stored title is no title: the renderer's row schema requires
    // a non-empty string, and one such row must not fail the whole parse.
    ...definedProps({
      title: review.title === "" ? undefined : review.title,
      terminal: terminalState(review),
      lastOpenedAt: review.lastOpenedAt,
    }),
    sortedAt: sortedAt(review),
  };
}

type LocalReviewGroup = readonly [
  Review<LocalReviewSource>,
  ...ReadonlyArray<Review<LocalReviewSource>>,
];

/** One checkout's local Reviews as one row, dated by the newest of them. */
function localRepositoryRow(
  reviews: LocalReviewGroup,
  registrations: ReadonlyArray<LocalRepositoryRegistration>,
  worktreeGone: boolean,
): Result<SidebarLocalRepositoryRow, SidebarListingFailure> {
  const [first, ...rest] = reviews;
  const newest = rest.reduce(
    (latest, review) => (sortedAt(review) > sortedAt(latest) ? review : latest),
    first,
  );
  const lastOpenedAt = reviews
    .flatMap((review) => review.lastOpenedAt ?? [])
    .reduce<IsoTimestamp | undefined>(
      (latest, opened) =>
        latest === undefined || opened > latest ? opened : latest,
      undefined,
    );
  const { identityKey, source } = newest.identity;
  let checkoutMissing: SidebarLocalRepositoryRow["checkoutMissing"] =
    worktreeGone && source.checkout !== undefined
      ? { reviewId: newest.id, path: source.checkout, scope: "worktree" }
      : undefined;
  let repository:
    | {
        readonly host: GitHubHost;
        readonly owner: GitHubOwner;
        readonly repo: GitHubRepoName;
      }
    | { readonly localRepositoryId: string; readonly displayName: string };
  if (identityKey.kind === "github") {
    repository = {
      host: identityKey.host,
      owner: identityKey.owner,
      repo: identityKey.repo,
    };
  } else {
    const registration = registrations.find(
      (entry) => entry.id === identityKey.localRepositoryId,
    );
    if (registration === undefined) return err({ reason: "storage" });
    if (registration.state === "missing" && checkoutMissing === undefined)
      checkoutMissing = {
        reviewId: newest.id,
        scope: "repository",
        ...definedProps({ path: registration.configuredRoot }),
      };
    repository = {
      localRepositoryId: registration.id,
      displayName: registration.displayName,
    };
  }
  return ok({
    ...repository,
    reviewIds: reviews.map((review) => review.id),
    sortedAt: sortedAt(newest),
    ...definedProps({
      checkoutMissing,
      lastOpenedAt,
      checkout: source.checkout,
      checkoutName:
        source.checkout === undefined
          ? undefined
          : checkoutFolderName(source.checkout),
    }),
  });
}

/**
 * Where a row sits in the list. `updatedAt` stands in for a Review written
 * before `lastOpenedAt` shipped, so a record from an earlier build still lands
 * somewhere sensible. GitHub activity bumps `updatedAt`, so this instant is a
 * guess about the visit and never reaches the row as an age.
 */
function sortedAt(review: Review): IsoTimestamp {
  return review.lastOpenedAt ?? review.updatedAt;
}

/**
 * The Terminal state already stored on the Review, or nothing while it is
 * Open. This reads what the record holds and calls no one: a row never
 * recomputes a pull request's state.
 */
function terminalState(review: Review): SidebarTerminalState | undefined {
  const { status } = review;
  if (status._tag !== "Terminal") return undefined;
  return { state: status.state, observedAt: status.observedAt };
}
