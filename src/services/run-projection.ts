import {
  parseSafeRunProjection,
  REVIEW_ACTIVITY_LIMIT,
  type ReviewActivityEvent,
  type SafeRunProjection,
} from "../domain/safe-run-projection";
import type { Result } from "../domain/result";

export {
  parseSafeRunProjection,
  type ReviewActivityEvent,
  type ReviewActivityStep,
  type ReviewRunMetadata,
  type SafeRunProjection,
} from "../domain/safe-run-projection";

/** Drop raw Flue events and expose only bounded renderer-safe lifecycle state. */
export function projectSafeRun(input: unknown): Result<SafeRunProjection, { readonly _tag: "InvalidRunProjection" }> {
  return parseSafeRunProjection(input);
}

export function appendRunActivity(
  projection: SafeRunProjection,
  event: ReviewActivityEvent,
): SafeRunProjection {
  const activity = [...(projection.activity ?? []), event].slice(-REVIEW_ACTIVITY_LIMIT);
  return { ...projection, activity };
}
