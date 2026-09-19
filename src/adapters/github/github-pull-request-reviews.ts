import * as v from "valibot";

import type { CommandFailure } from "./command-runner";
import type { GhRequestRunner } from "./gh-request-runner";
import type { PullRequestRef } from "../../domain/pull-request";
import type { Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import { publishedReviewSchema } from "./github-wire-schemas";

/**
 * Asks the REST review and comment endpoints for `body_html` beside `body`, in
 * the same request, so `extractImageRewrites` can learn which images GitHub
 * proxied.
 */
export const fullJsonMediaType = "application/vnd.github.full+json";

/**
 * One `pulls/:n/reviews` page, left unclassified. Published feedback reports a
 * failed read as `get_reviews` and the pending-review read reports it as
 * `get_pending_review`, so the operation name belongs to each consumer rather
 * than to the read they share. Page completeness is read off `reviews.length`.
 */
export type PullRequestReviewsRead =
  | {
      readonly _tag: "Reviews";
      readonly reviews: v.InferOutput<typeof publishedReviewSchema>;
    }
  | { readonly _tag: "Unreadable"; readonly failure: CommandFailure }
  | { readonly _tag: "Unparsable" };

/** Splits one review-list response into the three outcomes both consumers classify. */
export function classifyPullRequestReviews(
  response: Result<unknown, CommandFailure>,
): PullRequestReviewsRead {
  if (response._tag === "err")
    return { _tag: "Unreadable", failure: response.error };
  const parsed = v.safeParse(publishedReviewSchema, response.value);
  return parsed.success
    ? { _tag: "Reviews", reviews: parsed.output }
    : { _tag: "Unparsable" };
}

/**
 * The one review-list read a cycle can hand to both consumers. It asks for the
 * full media type, which adds `body_html` and removes nothing, so it serves the
 * pending-review consumer as well as published feedback.
 */
export async function readPullRequestReviews(
  requests: GhRequestRunner,
  input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  },
): Promise<PullRequestReviewsRead> {
  return classifyPullRequestReviews(
    await requests.ghJson(input.profile, {
      kind: "rest",
      host: input.profile.githubHost,
      accept: fullJsonMediaType,
      path: `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews?per_page=100&page=1`,
    }),
  );
}
