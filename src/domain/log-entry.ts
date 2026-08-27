import * as v from "valibot";

import { definedProps } from "./defined-props";
import { rawJsonValueSchema, type RawJsonValue } from "./json";

/**
 * Unified local log stream entry. Unlike diagnostics (bounded, whole-line
 * redaction, support-bundle oriented), log entries are machine-local debug
 * evidence: paths and error detail survive, but credential shapes are masked
 * inline and sensitive meta keys are dropped. Never persist credentials.
 */

const logLevelSchema = v.picklist(["debug", "info", "warn", "error"]);
const logProcessSchema = v.picklist(["main", "renderer"]);

const logEntrySchema = v.strictObject({
  schemaVersion: v.literal(1),
  seq: v.pipe(v.number(), v.integer(), v.minValue(0)),
  at: v.pipe(v.string(), v.isoTimestamp()),
  process: logProcessSchema,
  level: logLevelSchema,
  topic: v.pipe(v.string(), v.minLength(1), v.maxLength(48)),
  message: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  meta: v.optional(v.record(v.string(), rawJsonValueSchema)),
  profileId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(180))),
  sessionId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(180))),
  correlationId: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  ),
});

export type LogLevel = v.InferOutput<typeof logLevelSchema>;
export type LogProcess = v.InferOutput<typeof logProcessSchema>;
export type LogEntry = v.InferOutput<typeof logEntrySchema>;

/**
 * Diagnostic detail a caller attaches to a log entry. Values are the JSON
 * value grammar, because the entry is persisted to the log file as JSON and
 * anything outside that grammar cannot survive the round trip. A caller with
 * nothing for a key passes `undefined`; the key is dropped on the way in.
 */
export type LogMetaInput = Readonly<Record<string, RawJsonValue | undefined>>;

/**
 * Meta after sanitizing: sensitive keys dropped, credential shapes masked,
 * depth and string length bounded. Every surviving key holds a JSON value.
 */
export type LogMeta = Readonly<Record<string, RawJsonValue>>;

export type LogEntryInput = {
  readonly process: LogProcess;
  readonly level: LogLevel;
  readonly topic: string;
  readonly message: string;
  readonly meta?: LogMetaInput;
  readonly profileId?: string;
  readonly sessionId?: string;
  readonly correlationId?: string;
};

export const LOG_MAX_TOPIC_LENGTH = 48;
export const LOG_MAX_MESSAGE_LENGTH = 512;
export const LOG_MAX_IDENTIFIER_LENGTH = 180;
export const LOG_MAX_CORRELATION_ID_LENGTH = 120;
export const LOG_MAX_META_DEPTH = 3;
export const LOG_MAX_META_STRING_LENGTH = 512;

const SENSITIVE_META_KEY =
  /^(?:authorization|token|password|secret|credential|api[_-]?key|set-cookie|cookie)$/i;

/** Credential shapes are masked inline; everything else (paths, errors, stacks) survives in the local log. */
const SECRET_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly replacement: string;
}> = [
  {
    pattern: /(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]+/g,
    replacement: "[redacted]",
  },
  {
    pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
    replacement: "$1 [redacted]",
  },
  {
    pattern:
      /\b(authorization|api[_-]?key|access[_-]?token|token|password|passwd|secret)\b(?:\s*[:=]\s*|\s+)\S+/gi,
    replacement: "$1 [redacted]",
  },
];

/** Parse one persisted or renderer-supplied entry before it enters service state. */
export function parseLogEntry(input: unknown): LogEntry | undefined {
  const parsed = v.safeParse(logEntrySchema, input);
  return parsed.success ? parsed.output : undefined;
}

/** Build a redacted, truncated entry from a trusted service input. */
export function normalizeLogEntry(
  input: LogEntryInput & { readonly seq: number; readonly at: string },
): LogEntry {
  return {
    schemaVersion: 1,
    seq: input.seq,
    at: input.at,
    process: input.process,
    level: input.level,
    topic: sanitizeLogField(input.topic, LOG_MAX_TOPIC_LENGTH),
    message: sanitizeLogField(input.message, LOG_MAX_MESSAGE_LENGTH),
    ...definedProps({
      meta: sanitizeLogMeta(input.meta),
      profileId:
        input.profileId === undefined
          ? undefined
          : sanitizeLogIdentifier(input.profileId),
      sessionId:
        input.sessionId === undefined
          ? undefined
          : sanitizeLogIdentifier(input.sessionId),
      correlationId:
        input.correlationId === undefined
          ? undefined
          : sanitizeLogIdentifier(
              input.correlationId,
              LOG_MAX_CORRELATION_ID_LENGTH,
            ),
    }),
  };
}

/** Re-sanitize a parsed entry so reads never trust persisted bytes. */
export function sanitizeLogEntry(input: LogEntry): LogEntry {
  return normalizeLogEntry({
    seq: input.seq,
    at: input.at,
    process: input.process,
    level: input.level,
    topic: input.topic,
    message: input.message,
    ...definedProps({
      meta: input.meta,
      profileId: input.profileId,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
    }),
  });
}

/** Mask credential shapes; keep field names and the rest of the line intact. */
export function maskLogSecrets(input: string): string {
  let masked = input;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    masked = masked.replace(pattern, replacement);
  }
  return masked;
}

function sanitizeLogField(input: string, maxLength: number): string {
  const collapsed = Array.from(input, (character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 32 || code === 127) ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const masked = maskLogSecrets(collapsed);
  return masked.slice(
    0,
    Math.min(Math.max(1, maxLength), LOG_MAX_MESSAGE_LENGTH),
  );
}

function sanitizeLogIdentifier(
  input: string,
  maxLength = LOG_MAX_IDENTIFIER_LENGTH,
): string {
  const safe = maskLogSecrets(input).slice(0, maxLength);
  return safe.replace(/[^A-Za-z0-9._:-]/g, "_");
}

/**
 * Decode one arbitrary value — a thrown exception, a rejection reason, any
 * value a caller was handed — into the JSON grammar log meta is made of.
 * Call it where such a value enters, so `LogMetaInput` stays a JSON contract
 * instead of every caller's `unknown` leaking through it. Returns `undefined`
 * for a value with no JSON representation, so the key can be dropped.
 */
export function loggableMetaValue(value: unknown): RawJsonValue | undefined {
  return sanitizeMetaValue(value, 0);
}

/** Recursively sanitize meta: drop sensitive keys, mask secrets, bound depth and string length. */
export function sanitizeLogMeta(
  input: unknown,
  depth = 0,
): LogMeta | undefined {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    depth > LOG_MAX_META_DEPTH
  ) {
    return undefined;
  }
  const output: Record<string, RawJsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_META_KEY.test(key)) continue;
    const sanitized = sanitizeMetaValue(value, depth);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return Object.keys(output).length === 0 ? undefined : output;
}

function sanitizeMetaValue(
  value: unknown,
  depth: number,
): RawJsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return sanitizeMetaString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "object") {
    if (value instanceof Error) {
      // `instanceof Error` proves nothing about `name`, `message` and `stack`.
      // They are declared `string`, but anything can be thrown and anything
      // can reject a promise, so `electron-main.ts`'s two crash handlers reach
      // this branch holding whatever the process handed them. Each field is
      // decoded rather than assumed, so recording a crash cannot itself throw.
      const { stack } = value;
      return definedProps({
        name: sanitizeMetaValue(value.name, depth + 1),
        message: sanitizeMetaValue(value.message, depth + 1),
        stack:
          typeof stack === "string"
            ? sanitizeMetaString(stack.slice(0, 1_000))
            : sanitizeMetaValue(stack, depth + 1),
      });
    }
    if (Array.isArray(value)) {
      return value
        .slice(0, 20)
        .map((item) => sanitizeMetaValue(item, depth + 1))
        .filter((item) => item !== undefined);
    }
    return sanitizeLogMeta(value, depth + 1);
  }
  return undefined;
}

/** Collapse whitespace, mask credential shapes, and bound one meta string. */
function sanitizeMetaString(value: string): string {
  const collapsed = maskLogSecrets(value).replace(/\s+/g, " ").trim();
  return collapsed.slice(0, LOG_MAX_META_STRING_LENGTH);
}
