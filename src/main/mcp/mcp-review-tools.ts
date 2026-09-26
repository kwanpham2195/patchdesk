import type { InferOutput } from "valibot";

import type { ReviewSessionStore } from "../../adapters/storage/review-session-store";
import type { ReviewStore } from "../../adapters/storage/review-store";
import { parseChangeIntent } from "../../domain/change-intent";
import { definedProps } from "../../domain/defined-props";
import {
  parseAbsolutePath,
  parseReviewId,
  type ReviewId,
} from "../../domain/ids";
import { err, ok, type Result } from "../../domain/result";
import { parseLocalReviewSourceRequest } from "../../domain/review-source";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import type { McpToolRefusal } from "../../mcp/socket-protocol";
import type { mcpToolManifest } from "../../mcp/tool-manifest";
import type { DashboardController } from "../../services/dashboard-controller";
import type {
  AgentIntentFailure,
  LocalChangeIntentService,
} from "../../services/local-change-intent-service";
import type {
  LocalDraftService,
  LocalFeedback,
} from "../../services/local-draft-service";
import type { LocalFeedbackPageFailure } from "../../services/local-feedback-page";
import type {
  LocalReviewOpenFailure,
  LocalReviewOpening,
} from "../../services/local-review-opening";
import type {
  InsightReading,
  InsightReadingFailure,
  ReviewInsightReader,
} from "../../services/review-insight-reading";
import {
  describeOpenedLocalReview,
  type LocalReviewOpened,
} from "../../services/review-session-description";

/** What `review_local` answers; `intentKept` is present when the call sent an intent. */
export type ReviewLocalResult = LocalReviewOpened & {
  readonly intentKept?: boolean;
};

export type McpReviewToolServices = {
  readonly dashboard: Pick<DashboardController, "savedProfiles">;
  readonly localReviewOpening: Pick<
    LocalReviewOpening,
    "listCheckouts" | "findCheckout" | "open"
  >;
  readonly localChangeIntent: Pick<
    LocalChangeIntentService,
    "recordAgentIntent"
  >;
  readonly localDrafts: Pick<LocalDraftService, "feedback">;
  readonly insightReader: Pick<ReviewInsightReader, "read">;
  readonly sessions: Pick<ReviewSessionStore, "load">;
  readonly reviews: Pick<ReviewStore, "load">;
};

type ServiceReason =
  | LocalReviewOpenFailure["reason"]
  | AgentIntentFailure["reason"]
  | InsightReadingFailure["reason"]
  | LocalFeedbackPageFailure["reason"]
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
  revision_not_found:
    "Git could not find that branch or commit in the checkout.",
  unmerged_index:
    "The checkout has unmerged paths. Finish or abort the merge, then try again.",
  branch_mismatch: "The checkout is now on another branch than the Review.",
  in_progress:
    "Another Patchdesk command holds this Review. Retry when it finishes.",
  terminal: "This Review is closed.",
  not_applicable:
    "This is a pull request Review. These tools read local Reviews only.",
  intent_exists:
    "The Review already has a different Change intent, which Patchdesk keeps. Call review_local without intent, or ask the maintainer to change it in Patchdesk.",
  change_intent_sensitive:
    "The intent holds what looks like a credential, which Patchdesk never stores. Remove it and try again.",
  stale_cursor:
    "The feedback changed since this cursor was issued. Call get_feedback again without a cursor.",
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

/** `review_local`: the open goes through `LocalReviewOpening.open`, the service the open-local route calls. */
export async function reviewLocal(
  services: McpReviewToolServices,
  input: ToolInput<"review_local">,
): Promise<Result<ReviewLocalResult, McpToolRefusal>> {
  const profiles = await readActiveProfile(services);
  if (profiles._tag === "err") return profiles;
  const profileId = profiles.value.active.id;
  const directory = parseAbsolutePath(input.cwd);
  const intent =
    input.intent === undefined
      ? undefined
      : parseChangeIntent({ kind: "text", markdown: input.intent });
  if (directory._tag === "err" || intent?._tag === "err")
    return err(refusal("invalid_input"));
  const found = await services.localReviewOpening.findCheckout(
    profileId,
    directory.value,
  );
  if (found._tag === "err") return err(refusal(found.error.reason));
  const request = parseLocalReviewSourceRequest({
    ...(input.source ?? { kind: "working_tree" }),
    checkout: found.value.checkout,
  });
  if (request === undefined) return err(refusal("invalid_input"));
  const { host, owner, repo } = found.value.repository;
  const opened = await services.localReviewOpening.open({
    profileId,
    repository: { host, owner, repo },
    request,
  });
  if (opened._tag === "err") return err(refusal(opened.error.reason));
  const recorded =
    input.intent === undefined
      ? undefined
      : await services.localChangeIntent.recordAgentIntent({
          profileId,
          reviewId: opened.value.review.id,
          markdown: input.intent,
        });
  if (recorded?._tag === "err") return err(refusal(recorded.error.reason));
  const described = await describeOpenedLocalReview(
    services.sessions,
    opened.value,
  );
  if (described._tag === "err") return err(refusal("storage"));
  return ok({
    ...described.value,
    ...definedProps({ intentKept: recorded?.value.intentKept }),
  });
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
