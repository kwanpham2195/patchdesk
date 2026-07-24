import * as v from "valibot";

import {
  parseFindingId,
  parseRepoRelativePath,
  type FindingId,
  type RepoRelativePath,
} from "./ids";
import { err, ok, type Result } from "./result";

export const REVIEW_ACTIVITY_LIMIT = 40;
export const REVIEW_ACTIVITY_BYTES_LIMIT = 6_144;

export type ReviewActivityStep =
  | "preparing"
  | "inspecting"
  | "validating"
  | "drafting"
  | "complete"
  | "failed";

export type ReviewActivityEvent = {
  readonly at: string;
  readonly elapsedMs: number;
  readonly step: ReviewActivityStep;
  readonly label: string;
  readonly path?: RepoRelativePath;
  readonly findingId?: FindingId;
};

export type ReviewRunMetadata = {
  readonly agent: "Patchdesk review agent" | "Unknown agent";
  readonly model: string;
  readonly reasoning: "low" | "medium" | "high" | "Unknown reasoning level";
  readonly mode: "Full review" | "Review updates";
  readonly access: "Read-only repository inspection";
};

export type SafeRunProjection = {
  readonly status: "queued" | "connecting" | "running" | "completed" | "failed" | "disconnected";
  readonly elapsedMs: number;
  readonly step: ReviewActivityStep;
  readonly message?: string;
  readonly metadata?: ReviewRunMetadata;
  readonly activity?: ReadonlyArray<ReviewActivityEvent>;
};

export type InvalidSafeRunProjection = { readonly _tag: "InvalidRunProjection" };

const activitySchema = v.object({
  at: v.pipe(v.string(), v.isoTimestamp()),
  elapsedMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
  step: v.picklist(["preparing", "inspecting", "validating", "drafting", "complete", "failed"]),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
  path: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4_096))),
  findingId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
});

const metadataSchema = v.object({
  agent: v.picklist(["Patchdesk review agent", "Unknown agent"]),
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  reasoning: v.picklist(["low", "medium", "high", "Unknown reasoning level"]),
  mode: v.picklist(["Full review", "Review updates"]),
  access: v.literal("Read-only repository inspection"),
});

const projectionSchema = v.object({
  status: v.picklist(["queued", "connecting", "running", "completed", "failed", "disconnected"]),
  elapsedMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
  step: v.picklist(["preparing", "inspecting", "validating", "drafting", "complete", "failed"]),
  message: v.optional(v.pipe(v.string(), v.maxLength(160))),
  metadata: v.optional(metadataSchema),
  activity: v.optional(v.pipe(v.array(activitySchema), v.maxLength(REVIEW_ACTIVITY_LIMIT))),
});

/**
 * Parses the only run-state shape that may cross from Patchdesk's main process
 * to the isolated renderer. Unknown fields are deliberately projected away.
 */
export function parseSafeRunProjection(
  value: unknown,
): Result<SafeRunProjection, InvalidSafeRunProjection> {
  if (!isWithinSerializedLimit(value)) return err({ _tag: "InvalidRunProjection" });
  const parsed = v.safeParse(projectionSchema, value);
  if (!parsed.success) return err({ _tag: "InvalidRunProjection" });

  const activity = parsed.output.activity === undefined
    ? undefined
    : parseActivity(parsed.output.activity);
  if (activity?._tag === "err") return activity;

  return ok({
    status: parsed.output.status,
    elapsedMs: parsed.output.elapsedMs,
    step: parsed.output.step,
    ...(parsed.output.message === undefined ? {} : { message: parsed.output.message }),
    ...(parsed.output.metadata === undefined ? {} : { metadata: parsed.output.metadata }),
    ...(activity === undefined ? {} : { activity: activity.value }),
  });
}

function parseActivity(
  events: ReadonlyArray<v.InferOutput<typeof activitySchema>>,
): Result<ReadonlyArray<ReviewActivityEvent>, InvalidSafeRunProjection> {
  const parsed: Array<ReviewActivityEvent> = [];
  for (const event of events) {
    const path = event.path === undefined ? undefined : parseRepoRelativePath(event.path);
    const findingId = event.findingId === undefined ? undefined : parseFindingId(event.findingId);
    if ((path !== undefined && path._tag === "err") || (findingId !== undefined && findingId._tag === "err")) {
      return err({ _tag: "InvalidRunProjection" });
    }
    parsed.push({
      at: event.at,
      elapsedMs: event.elapsedMs,
      step: event.step,
      label: event.label,
      ...(path === undefined ? {} : { path: path.value }),
      ...(findingId === undefined ? {} : { findingId: findingId.value }),
    });
  }
  return ok(parsed);
}

function isWithinSerializedLimit(value: unknown): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= REVIEW_ACTIVITY_BYTES_LIMIT;
  } catch {
    return false;
  }
}
