import * as v from "valibot";

import { definedProps } from "./defined-props";
import { parseWorkspaceProfileId, type WorkspaceProfileId } from "./ids";

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
  retryable: v.boolean(),
  durationMs: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(86_400_000)),
  ),
  detail: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
});

const diagnosticMetadataSchema = v.strictObject({
  title: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
});

type ReviewDiagnosticCategory = v.InferOutput<typeof diagnosticCategorySchema>;

export type ReviewDiagnosticEvent = v.InferOutput<typeof diagnosticEventSchema>;

export type ReviewDiagnosticMetadata = v.InferOutput<
  typeof diagnosticMetadataSchema
>;

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
  readonly retryable: boolean;
  readonly durationMs?: number;
  readonly detail?: string;
};

export const REVIEW_DIAGNOSTIC_MAX_EVENTS = 200;
export const REVIEW_DIAGNOSTIC_MAX_DETAIL_LENGTH = 512;
export const REVIEW_DIAGNOSTIC_MAX_FILE_BYTES = 256_000;
const REDACTED_DETAIL = "[redacted diagnostic detail]";

/** Parse one persisted diagnostic event before it enters service state. */
function parseReviewDiagnosticEvent(
  input: unknown,
): ReviewDiagnosticEvent | undefined {
  const parsed = v.safeParse(diagnosticEventSchema, input);
  return parsed.success ? parsed.output : undefined;
}

/** Reparse and project persisted diagnostics into a safe profile-scoped event. */
export function sanitizeReviewDiagnosticEvent(
  input: unknown,
  expectedProfileId: WorkspaceProfileId,
  maxDetailLength = REVIEW_DIAGNOSTIC_MAX_DETAIL_LENGTH,
): ReviewDiagnosticEvent | undefined {
  const parsed = parseReviewDiagnosticEvent(input);
  if (parsed === undefined) return undefined;
  const parsedProfile = parseWorkspaceProfileId(parsed.profileId);
  if (parsedProfile._tag === "err" || parsedProfile.value !== expectedProfileId)
    return undefined;
  const normalized = normalizeReviewDiagnostic(
    {
      incidentId: sanitizeDiagnosticField(parsed.incidentId, 120),
      at: parsed.at,
      category: parsed.category,
      phase: sanitizeDiagnosticField(parsed.phase, 80),
      profileId: expectedProfileId,
      ...definedProps({
        sessionId:
          parsed.sessionId === undefined
            ? undefined
            : sanitizeDiagnosticIdentifier(parsed.sessionId, 180),
      }),
      retryable: parsed.retryable,
      ...definedProps({
        durationMs: parsed.durationMs,
        detail: parsed.detail,
      }),
    },
    maxDetailLength,
  );
  return parseReviewDiagnosticEvent(normalized);
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
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) return undefined;

  // Detail is caller-controlled and may contain untrusted PR text, so reject
  // the whole field when any high-risk shape is present instead of attempting
  // to preserve an incomplete fragment of a secret, path, diff, or stack.
  const unsafe = [
    /(?:^|[\s"'():=,]|\[)\/(?:[^\s/]+(?:\/[^\s/]*)*)?(?=$|[\s,;:)\]}])/,
    /(?:^|[\s"'():=,]|\[)\/?[A-Za-z]:[\\/][^\s]*(?=$|[\s,;:)\]}])/,
    /(?:^|[\s"'():=,]|\[)\\\\[^\s\\/]+(?:[\\/][^\s\\/]*)*(?=$|[\s,;:)\]}])/,
    /(?:^|[^A-Za-z0-9])file:(?:\/\/)?[^\s]*/i,
    /(?:^|\s)(?:diff --git|---\s|\+\+\+\s|@@[^@]*@@)/im,
    /\b(?:pr|pull request|title|description|body)\b/i,
    /\b(?:bearer|basic|authorization|api[_-]?key|token|password|secret)\b(?:\s*[:=]\s*|\s+)\S+/i,
    /(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]+/,
    /(?:^|[\s"'():=,]|\[)(?:Error(?:\s+\[[A-Z0-9_]+\])?|error|TypeError|RangeError|[A-Za-z_$][A-Za-z0-9_$]*(?:Error|Exception))(?:\s*:\s*|\s+)\S/im,
    /(?:^|[\s"'():=,]|\[)(?:cause|error|message|reason|exception|failure)\s*[:=]\s*\S+/i,
    /(?:^|[\s"'():=,]|\[)at\s+[^\s]+(?:\s+|\()/im,
    /(?:raw\s+stack|stack\s+trace)/i,
  ];
  if (unsafe.some((pattern) => pattern.test(normalized)))
    return REDACTED_DETAIL;

  return normalized.slice(
    0,
    Math.min(Math.max(1, maxLength), REVIEW_DIAGNOSTIC_MAX_DETAIL_LENGTH),
  );
}

function sanitizeDiagnosticField(input: string, maxLength: number): string {
  const safe =
    redactDiagnosticDetail(input, maxLength) ?? "[redacted diagnostic field]";
  return safe.slice(0, maxLength);
}

function sanitizeDiagnosticIdentifier(
  input: string,
  maxLength: number,
): string {
  const safe = sanitizeDiagnosticField(input, maxLength);
  return safe.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, maxLength);
}

/** Build a redacted diagnostic event from a trusted service input. */
export function normalizeReviewDiagnostic(
  input: ReviewDiagnosticInput,
  maxDetailLength = 512,
): ReviewDiagnosticEvent {
  const detail =
    input.detail === undefined
      ? undefined
      : redactDiagnosticDetail(input.detail, maxDetailLength);
  return {
    schemaVersion: 1,
    incidentId: sanitizeDiagnosticIdentifier(input.incidentId, 120),
    at: input.at,
    category: input.category,
    phase: sanitizeDiagnosticField(input.phase, 80),
    profileId: input.profileId.slice(0, 160),
    ...definedProps({
      sessionId:
        input.sessionId === undefined
          ? undefined
          : sanitizeDiagnosticIdentifier(input.sessionId, 180),
    }),
    retryable: input.retryable,
    ...definedProps({
      durationMs:
        input.durationMs === undefined
          ? undefined
          : Math.max(0, Math.min(input.durationMs, 86_400_000)),
      detail,
    }),
  };
}
