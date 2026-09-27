import type { InferOutput } from "valibot";

import { COMMAND_OUTPUT_CAP_BYTES } from "../../adapters/github/command-runner";
import type { ReviewSessionStore } from "../../adapters/storage/review-session-store";
import type { ReviewStore } from "../../adapters/storage/review-store";
import { definedProps } from "../../domain/defined-props";
import {
  parseAbsolutePath,
  parseLocalBranchName,
  parseReviewId,
  parseReviewSessionId,
  type AbsolutePath,
  type ReviewId,
} from "../../domain/ids";
import { err, ok, type Result } from "../../domain/result";
import { parseLocalReviewSourceRequest } from "../../domain/review-source";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import type { McpToolRefusal } from "../../mcp/socket-protocol";
import type { mcpToolManifest } from "../../mcp/tool-manifest";
import type {
  AgentRunRequestFailure,
  AgentRunRequestReply,
  AgentRunRequestService,
} from "../../services/agent-run-request-service";
import type { DashboardController } from "../../services/dashboard-controller";
import {
  checkAgentIntentText,
  type AgentIntentFailure,
  type LocalChangeIntentService,
} from "../../services/local-change-intent-service";
import type {
  LocalDraftService,
  LocalFeedback,
} from "../../services/local-draft-service";
import type { LocalFeedbackPageFailure } from "../../services/local-feedback-page";
import type {
  LocalReviewAgentOpenRequest,
  LocalReviewAgentRefreshFailure,
  LocalReviewBaseRequired,
  LocalReviewOpening,
  LocalReviewPrepared,
} from "../../services/local-review-opening";
import type { CheckoutSharedReviews } from "../../services/local-shared-review-list";
import { localSnapshotUntrackedLimits } from "../../services/local-untracked-size";
import type {
  InsightReading,
  InsightReadingFailure,
  ReviewInsightReader,
} from "../../services/review-insight-reading";
import {
  describeOpenedLocalReview,
  type LocalReviewOpened,
} from "../../services/review-session-description";

/**
 * What `review_local` answers. The intent fields are present when the call
 * sent an intent; a refused intent is reported beside the opened Review,
 * because the Review exists either way (#513).
 */
export type ReviewLocalResult = LocalReviewOpened & {
  /** The shared Review's base branch; absent for a commit Review. */
  readonly baseBranch?: string;
  /** True when Patchdesk inferred `baseBranch`; false when the agent named it or an open Review of the branch supplied it. */
  readonly baseInferred?: boolean;
  readonly intentRecorded?: boolean;
  readonly intentKept?: boolean;
  readonly intentRefused?: AgentIntentFailure["reason"];
  readonly intentMessage?: string;
};

export type McpReviewToolServices = {
  readonly dashboard: Pick<DashboardController, "savedProfiles">;
  readonly localReviewOpening: Pick<
    LocalReviewOpening,
    | "listCheckouts"
    | "findCheckout"
    | "listSharedReviews"
    | "openForAgent"
    | "prepareForAgent"
  >;
  readonly localChangeIntent: Pick<
    LocalChangeIntentService,
    "recordAgentIntent"
  >;
  readonly localDrafts: Pick<LocalDraftService, "feedback">;
  readonly agentRunRequests: Pick<AgentRunRequestService, "request">;
  readonly insightReader: Pick<ReviewInsightReader, "read">;
  readonly sessions: Pick<ReviewSessionStore, "load">;
  readonly reviews: Pick<ReviewStore, "load">;
};

/** Refusals whose message names the checkout's state, built by `localReviewRefusal`. */
type DetailedLocalReason =
  | "untracked_too_large"
  | "patch_too_large"
  | "checkout_missing";

type ServiceReason =
  | Exclude<LocalReviewAgentRefreshFailure["reason"], DetailedLocalReason>
  | LocalReviewBaseRequired["reason"]
  | AgentIntentFailure["reason"]
  | InsightReadingFailure["reason"]
  | LocalFeedbackPageFailure["reason"]
  | AgentRunRequestFailure["reason"]
  | "no_profile";

const refusalMessages = {
  no_profile:
    "No workspace profile is saved in Patchdesk. Open Patchdesk and set up a profile first.",
  invalid_input: "The arguments are not valid for this tool.",
  not_found: "The active Patchdesk profile has no Review with that reviewId.",
  repository_not_local:
    "The repository has no local checkout in the active Patchdesk profile.",
  checkout_not_found:
    "The directory is not inside a checkout of a repository in the active Patchdesk profile. Call list_repositories to see the checkouts, or ask the maintainer to add the repository with its local path.",
  base_required:
    "The checkout has no other local branch behind HEAD to compare with, and no Review of this branch is open. Pass base, the local branch this change should be compared with.",
  revision_not_found:
    "Git could not find the base branch or the commit in the checkout, or the base shares no history with HEAD. Check the name with git branch, or omit base to reuse or infer one.",
  unmerged_index:
    "The checkout has unmerged paths. Finish or abort the merge, then try again.",
  branch_mismatch: "The checkout is now on another branch than the Review.",
  in_progress:
    "Another Patchdesk command holds this Review. Retry when it finishes.",
  rate_limited:
    "This Review was refreshed less than 10 seconds ago. Retry after retryAfterMs.",
  terminal: "This Review is closed.",
  not_applicable:
    "These tools read shared and commit local Reviews only: this is a pull request Review, or a working-tree or branch Review from before the shared Review. Call review_local for the current one.",
  intent_exists:
    "The Review already has a different Change intent, which Patchdesk keeps. Ask the maintainer to change it in Patchdesk if yours should replace it.",
  change_intent_sensitive:
    "The intent holds what looks like a credential, which Patchdesk never stores. Remove it and try again.",
  stale_cursor:
    "The feedback changed since this cursor was issued. Call get_feedback again without a cursor.",
  stale_session:
    "sessionId is not the Review's current session. Call get_insight or review_local for the current sessionId, then ask again.",
  request_not_awaiting: "That run request is no longer awaiting approval.",
  storage: "Patchdesk could not read or write its local storage.",
  github_read: "Patchdesk could not read GitHub.",
  github_auth: "Patchdesk is not signed in to GitHub.",
  head_changed: "The Review's head changed while it was read. Try again.",
  revision_conflict: "The Review changed while it was read. Try again.",
  not_fresh: "The Review changed while it was read. Try again.",
} as const satisfies { readonly [Reason in ServiceReason]: string };

function refusal(reason: ServiceReason): McpToolRefusal {
  return { error: reason, message: refusalMessages[reason] };
}

/**
 * An open or refresh refusal; `branch_mismatch` names the branch the checkout
 * is on, `rate_limited` carries when to retry, `untracked_too_large` names
 * the limit it is over and the untracked paths to ignore,
 * `patch_too_large` names the largest changed files, and `checkout_missing`
 * names the configured path that is gone.
 */
function localReviewRefusal(
  failure: LocalReviewAgentRefreshFailure | LocalReviewBaseRequired,
): McpToolRefusal {
  if (failure.reason === "untracked_too_large")
    return {
      error: "untracked_too_large",
      message: `The working tree has more than ${
        failure.exceededLimit === "files"
          ? `${localSnapshotUntrackedLimits.files.toLocaleString("en-US")} untracked files`
          : `${localSnapshotUntrackedLimits.bytes / (1024 * 1024)} MiB of untracked files`
      }, more than Patchdesk snapshots. ${
        failure.largestPaths.length === 0
          ? "Add large untracked directories, such as dependencies or build output,"
          : `The largest untracked paths are ${failure.largestPaths.join(", ")}. Add them`
      } to .gitignore or remove them, then try again.`,
    };
  if (
    failure.reason === "revision_not_found" &&
    failure.savedBaseBranch !== undefined
  )
    return {
      error: "revision_not_found",
      message: `The saved Review uses base branch ${failure.savedBaseBranch}, which no longer exists locally. Pass base with the local branch to compare this change with.`,
    };
  if (failure.reason === "checkout_missing")
    return {
      error: "checkout_missing",
      message: `The repository's checkout at ${failure.localPath} no longer exists. If it moved, ask the maintainer to update its path in Patchdesk: in Settings → Workspace, under Repositories, add the folder that holds it now if it is not listed, then untick the repository and tick it again. Then call again.`,
    };
  if (failure.reason === "patch_too_large")
    return {
      error: "patch_too_large",
      message: `The patch is larger than the ${COMMAND_OUTPUT_CAP_BYTES / (1024 * 1024)} MiB Patchdesk reads from git. ${
        failure.largestFiles.length === 0
          ? "Leave large generated files out of the change"
          : `The files with the most changes are ${failure.largestFiles.join(", ")}. Leave generated ones out of the change`
      }, or review it in smaller parts, then try again.`,
    };
  if (failure.reason === "rate_limited")
    return { ...refusal("rate_limited"), retryAfterMs: failure.retryAfterMs };
  if (failure.reason !== "branch_mismatch") return refusal(failure.reason);
  return {
    error: "branch_mismatch",
    message:
      failure.currentBranch === undefined
        ? "The checkout's HEAD is detached, so it is not on the branch this Review reads. Check that branch out again, then retry."
        : `The checkout is now on branch ${failure.currentBranch}, not the branch this Review reads. Check that branch out again, or call review_local to review ${failure.currentBranch}.`,
  };
}

/**
 * The active profile at call time, read without the first-run `gh`
 * detection, and every saved profile for the `profile_changed` check.
 */
export async function readActiveProfile(
  services: Pick<McpReviewToolServices, "dashboard">,
): Promise<
  Result<
    {
      readonly active: WorkspaceProfileConfig;
      readonly saved: ReadonlyArray<WorkspaceProfileConfig>;
    },
    McpToolRefusal
  >
> {
  const profiles = await services.dashboard.savedProfiles();
  return profiles._tag === "ok"
    ? profiles
    : err(refusal(profiles.error.reason));
}

/** `profile_changed` when another saved profile holds the Review (ADR 0052 "Profile switch"), else `not_found`. */
async function missingReviewRefusal(
  services: McpReviewToolServices,
  profiles: {
    readonly active: WorkspaceProfileConfig;
    readonly saved: ReadonlyArray<WorkspaceProfileConfig>;
  },
  reviewId: ReviewId,
): Promise<McpToolRefusal> {
  for (const other of profiles.saved) {
    if (other.id === profiles.active.id) continue;
    const loaded = await services.reviews.load(other.id, reviewId);
    if (loaded._tag === "ok")
      return {
        error: "profile_changed",
        message: `This Review belongs to another workspace profile; the active profile is ${profiles.active.label}. Ask the maintainer to switch profile in Patchdesk.`,
      };
  }
  return refusal("not_found");
}

type ToolInput<Name extends keyof typeof mcpToolManifest> = InferOutput<
  (typeof mcpToolManifest)[Name]["inputSchema"]
>;

/** `list_local_reviews`: `LocalReviewOpening.listSharedReviews`, the list the open dialog's bases come from. It writes nothing. */
export async function listLocalReviews(
  services: McpReviewToolServices,
  input: ToolInput<"list_local_reviews">,
): Promise<Result<CheckoutSharedReviews, McpToolRefusal>> {
  const profiles = await readActiveProfile(services);
  if (profiles._tag === "err") return profiles;
  const directory = parseAbsolutePath(input.cwd);
  if (directory._tag === "err") return err(refusal("invalid_input"));
  const listed = await services.localReviewOpening.listSharedReviews(
    profiles.value.active.id,
    directory.value,
  );
  return listed._tag === "ok" ? listed : err(localReviewRefusal(listed.error));
}

/** `review_local`: `LocalReviewOpening.openForAgent`, which returns an existing Review unmoved and creates a missing one as the open-local route does. */
export async function reviewLocal(
  services: McpReviewToolServices,
  input: ToolInput<"review_local">,
): Promise<Result<ReviewLocalResult, McpToolRefusal>> {
  const profiles = await readActiveProfile(services);
  if (profiles._tag === "err") return profiles;
  const profileId = profiles.value.active.id;
  const directory = parseAbsolutePath(input.cwd);
  if (directory._tag === "err") return err(refusal("invalid_input"));
  const intent =
    input.intent === undefined ? undefined : checkAgentIntentText(input.intent);
  if (intent?._tag === "err") return err(refusal(intent.error.reason));
  const found = await services.localReviewOpening.findCheckout(
    profileId,
    directory.value,
  );
  if (found._tag === "err") return err(localReviewRefusal(found.error));
  const request = agentSourceRequest(input, found.value.checkout);
  if (request === undefined) return err(refusal("invalid_input"));
  const { host, owner, repo } = found.value.repository;
  const opened = await services.localReviewOpening.openForAgent({
    profileId,
    repository: { host, owner, repo },
    request,
  });
  if (opened._tag === "err") return err(localReviewRefusal(opened.error));
  const { workbench, baseInferred } = opened.value;
  const { source } = workbench.session.key;
  const base =
    source.kind === "local_branch"
      ? { baseBranch: source.baseBranch, baseInferred }
      : undefined;
  const recorded =
    input.intent === undefined
      ? undefined
      : await services.localChangeIntent.recordAgentIntent({
          profileId,
          reviewId: workbench.review.id,
          markdown: input.intent,
        });
  const described = await describeOpenedLocalReview(
    services.sessions,
    workbench,
  );
  if (described._tag === "err") return err(refusal("storage"));
  if (recorded === undefined) return ok({ ...described.value, ...base });
  return ok({
    ...described.value,
    ...base,
    ...(recorded._tag === "ok"
      ? { intentRecorded: true, intentKept: recorded.value.intentKept }
      : {
          intentRecorded: false,
          intentRefused: recorded.error.reason,
          intentMessage: refusalMessages[recorded.error.reason],
        }),
  });
}

/**
 * The source `review_local` names: the shared Review, with the base the
 * agent passed if any, or one commit. Undefined for a base beside a commit,
 * or a base or commit git would refuse as a name.
 */
function agentSourceRequest(
  input: ToolInput<"review_local">,
  checkout: AbsolutePath,
): LocalReviewAgentOpenRequest["request"] | undefined {
  const source = input.source ?? { kind: "local_branch" };
  if (source.kind === "commit") {
    if (input.base !== undefined) return undefined;
    const commit = parseLocalReviewSourceRequest({
      kind: "commit",
      commit: source.commit,
      checkout,
    });
    return commit?.kind === "commit" ? commit : undefined;
  }
  if (input.base === undefined) return { kind: "local_branch", checkout };
  const baseBranch = parseLocalBranchName(input.base);
  return baseBranch._tag === "ok"
    ? { kind: "local_branch", baseBranch: baseBranch.value, checkout }
    : undefined;
}

/** `refresh_review`: `LocalReviewOpening.prepareForAgent`, which prepares the checkout's content without moving the Review. */
export async function refreshReview(
  services: McpReviewToolServices,
  input: ToolInput<"refresh_review">,
): Promise<Result<LocalReviewPrepared, McpToolRefusal>> {
  const profiles = await readActiveProfile(services);
  if (profiles._tag === "err") return profiles;
  const reviewId = parseReviewId(input.reviewId);
  if (reviewId._tag === "err") return err(refusal("invalid_input"));
  const prepared = await services.localReviewOpening.prepareForAgent(
    profiles.value.active.id,
    reviewId.value,
  );
  if (prepared._tag === "ok") return prepared;
  return err(
    prepared.error.reason === "not_found"
      ? await missingReviewRefusal(services, profiles.value, reviewId.value)
      : localReviewRefusal(prepared.error),
  );
}

/** `get_insight`: reads through `ReviewInsightReader`, over the projection the workbench displays. */
export async function getInsight(
  services: McpReviewToolServices,
  input: ToolInput<"get_insight">,
): Promise<Result<InsightReading, McpToolRefusal>> {
  const profiles = await readActiveProfile(services);
  if (profiles._tag === "err") return profiles;
  const reviewId = parseReviewId(input.reviewId);
  if (reviewId._tag === "err") return err(refusal("invalid_input"));
  const read = await services.insightReader.read({
    profileId: profiles.value.active.id,
    reviewId: reviewId.value,
    type: input.type,
  });
  if (read._tag === "ok") return read;
  return err(
    read.error.reason === "not_found"
      ? await missingReviewRefusal(services, profiles.value, reviewId.value)
      : refusal(read.error.reason),
  );
}

/** `get_feedback`: one page of `LocalDraftService.feedback`, the read Copy as agent prompt renders from. */
export async function getFeedback(
  services: McpReviewToolServices,
  input: ToolInput<"get_feedback">,
): Promise<Result<LocalFeedback, McpToolRefusal>> {
  const profiles = await readActiveProfile(services);
  if (profiles._tag === "err") return profiles;
  const reviewId = parseReviewId(input.reviewId);
  if (reviewId._tag === "err") return err(refusal("invalid_input"));
  const feedback = await services.localDrafts.feedback(
    profiles.value.active.id,
    reviewId.value,
    input.cursor,
  );
  if (feedback._tag === "ok") return feedback;
  return err(
    feedback.error.reason === "not_found"
      ? await missingReviewRefusal(services, profiles.value, reviewId.value)
      : refusal(feedback.error.reason),
  );
}

/** `run_insight`: `AgentRunRequestService.request`, which records a request the maintainer approves in the app. */
export async function runInsight(
  services: McpReviewToolServices,
  input: ToolInput<"run_insight">,
  context: { readonly clientName?: string },
): Promise<Result<AgentRunRequestReply, McpToolRefusal>> {
  const profiles = await readActiveProfile(services);
  if (profiles._tag === "err") return profiles;
  const reviewId = parseReviewId(input.reviewId);
  const sessionId = parseReviewSessionId(input.sessionId);
  if (reviewId._tag === "err" || sessionId._tag === "err")
    return err(refusal("invalid_input"));
  const requested = await services.agentRunRequests.request({
    profileId: profiles.value.active.id,
    reviewId: reviewId.value,
    sessionId: sessionId.value,
    type: input.type,
    ...definedProps({ clientName: context.clientName }),
  });
  if (requested._tag === "ok") return requested;
  return err(
    requested.error.reason === "not_found"
      ? await missingReviewRefusal(services, profiles.value, reviewId.value)
      : refusal(requested.error.reason),
  );
}
