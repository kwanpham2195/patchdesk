import * as v from "valibot";

import type { WorkspaceProfileId } from "./ids";

const diagnosticCategorySchema = v.picklist([
  "preparation",
  "run",
  "recovery",
  "migration",
  "cleanup",
  "walkthrough",
]);

const diagnosticEventSchema = v.strictObject({
  schemaVersion: v.literal(1),
  incidentId: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  at: v.pipe(v.string(), v.isoTimestamp()),
  category: diagnosticCategorySchema,
  phase: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  profileId: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
  sessionId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(180))),
  attemptId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(180))),
  retryable: v.boolean(),
  durationMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(86_400_000))),
  detail: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
});

const diagnosticMetadataSchema = v.strictObject({
  title: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
});

export type ReviewDiagnosticCategory = v.InferOutput<typeof diagnosticCategorySchema>;

export type ReviewDiagnosticEvent = v.InferOutput<typeof diagnosticEventSchema>;

export type ReviewDiagnosticMetadata = v.InferOutput<typeof diagnosticMetadataSchema>;

export type ReviewSupportBundle = {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly profileId: WorkspaceProfileId;
  readonly sessionId?: string;
  readonly metadata?: ReviewDiagnosticMetadata;
  readonly events: ReadonlyArray<ReviewDiagnosticEvent>;
};

export type ReviewDiagnosticInput = {
  readonly incidentId: string;
  readonly at: string;
  readonly category: ReviewDiagnosticCategory;
  readonly phase: string;
  readonly profileId: WorkspaceProfileId;
  readonly sessionId?: string;
  readonly attemptId?: string;
  readonly retryable: boolean;
  readonly durationMs?: number;
  readonly detail?: string;
};

export type InvalidReviewDiagnostic = {
  readonly _tag: "InvalidReviewDiagnostic";
};

export const REVIEW_DIAGNOSTIC_MAX_EVENTS = 200;
export const REVIEW_DIAGNOSTIC_MAX_DETAIL_LENGTH = 512;
export const REVIEW_DIAGNOSTIC_MAX_FILE_BYTES = 256_000;
const REDACTED_DETAIL = "[redacted diagnostic detail]";

/** Parse one persisted diagnostic event before it enters service state. */
export function parseReviewDiagnosticEvent(
  input: unknown,
): ReviewDiagnosticEvent | undefined {
  const parsed = v.safeParse(diagnosticEventSchema, input);
  return parsed.success ? parsed.output : undefined;
}

/** Parse optional support metadata at the service boundary. */
export function parseReviewDiagnosticMetadata(
  input: unknown,
): ReviewDiagnosticMetadata | undefined {
  const parsed = v.safeParse(diagnosticMetadataSchema, input);
  return parsed.success ? parsed.output : undefined;
}

/**
 * Remove paths, credentials, diff bodies, and stack detail before diagnostic
 * text is persisted or included in a support bundle.
 */
export function redactDiagnosticDetail(
  input: string,
  maxLength = REVIEW_DIAGNOSTIC_MAX_DETAIL_LENGTH,
): string | undefined {
  const normalized = Array.from(input, (character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 32 || code === 127) ? " " : character;
  }).join("").replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return undefined;

  // Detail is caller-controlled and may contain untrusted PR text, so reject
  // the whole field when any high-risk shape is present instead of attempting
  // to preserve an incomplete fragment of a secret, path, diff, or stack.
  const unsafe = [
    /(?:^|\s)\/(?:[A-Za-z0-9._-]+\/)+[^\s]*/,
    /(?:^|\s)[A-Za-z]:[\\/][^\s]*/,
    /(?:diff --git|^---\s|^\+\+\+\s|@@[^@]*@@)/im,
    /\b(?:pr|pull request|title|description|body)\b/i,
    /\b(?:bearer|basic|authorization|api[_-]?key|token|password|secret)\s*[:=]/i,
    /(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]+/,
    /(?:^|\s)(?:Error\b|at\s+[^ ]+\s*\()/m,
    /(?:raw\s+stack|stack\s+trace)/i,
  ];
  if (unsafe.some((pattern) => pattern.test(normalized))) return REDACTED_DETAIL;

  return normalized.slice(0, Math.min(Math.max(1, maxLength), REVIEW_DIAGNOSTIC_MAX_DETAIL_LENGTH));
}

/** Build a redacted diagnostic event from a trusted service input. */
export function normalizeReviewDiagnostic(
  input: ReviewDiagnosticInput,
  maxDetailLength = 512,
): ReviewDiagnosticEvent {
  const detail = input.detail === undefined ? undefined : redactDiagnosticDetail(input.detail, maxDetailLength);
  return {
    schemaVersion: 1,
    incidentId: input.incidentId.slice(0, 120),
    at: input.at,
    category: input.category,
    phase: input.phase.slice(0, 80),
    profileId: input.profileId.slice(0, 160),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId.slice(0, 180) }),
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId.slice(0, 180) }),
    retryable: input.retryable,
    ...(input.durationMs === undefined ? {} : { durationMs: Math.max(0, Math.min(input.durationMs, 86_400_000)) }),
    ...(detail === undefined ? {} : { detail }),
  };
}
