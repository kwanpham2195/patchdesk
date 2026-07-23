import * as v from "valibot";

import { err, ok, type Result } from "../domain/result";

const ACTIVITY_LIMIT = 8;
const ACTIVITY_BYTES_LIMIT = 6_144;

export type ReviewActivityStep =
  | "preparing"
  | "inspecting"
  | "validating"
  | "drafting"
  | "complete"
  | "failed";

export type ReviewActivityEvent = {
  readonly elapsedMs: number;
  readonly step: ReviewActivityStep;
  readonly label: string;
};

export type SafeRunProjection = {
  readonly status: "queued" | "connecting" | "running" | "completed" | "failed" | "disconnected";
  readonly elapsedMs: number;
  readonly step: ReviewActivityStep;
  readonly message?: string;
  readonly activity?: ReadonlyArray<ReviewActivityEvent>;
};

const activitySchema = v.strictObject({
  elapsedMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
  step: v.picklist(["preparing", "inspecting", "validating", "drafting", "complete", "failed"]),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
});

const schema = v.strictObject({
  status: v.picklist(["queued", "connecting", "running", "completed", "failed", "disconnected"]),
  elapsedMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
  step: v.picklist(["preparing", "inspecting", "validating", "drafting", "complete", "failed"]),
  message: v.optional(v.pipe(v.string(), v.maxLength(160))),
  activity: v.pipe(v.array(activitySchema), v.maxLength(ACTIVITY_LIMIT)),
});

/** Drop raw Flue events and expose only bounded renderer-safe lifecycle state. */
export function projectSafeRun(input: unknown): Result<SafeRunProjection, { readonly _tag: "InvalidRunProjection" }> {
  const parsed = v.safeParse(schema, input);
  if (!parsed.success || JSON.stringify(input).length > ACTIVITY_BYTES_LIMIT) {
    return err({ _tag: "InvalidRunProjection" });
  }
  return ok({
    status: parsed.output.status,
    elapsedMs: parsed.output.elapsedMs,
    step: parsed.output.step,
    activity: parsed.output.activity,
    ...(parsed.output.message === undefined ? {} : { message: parsed.output.message }),
  });
}

export function appendRunActivity(
  projection: SafeRunProjection,
  event: ReviewActivityEvent,
): SafeRunProjection {
  const activity = [...(projection.activity ?? []), event].slice(-ACTIVITY_LIMIT);
  return { ...projection, activity };
}
