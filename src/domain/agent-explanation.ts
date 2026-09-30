import * as v from "valibot";

import { definedProps } from "./defined-props";
import type { ReviewAnchorFingerprint } from "./diff-anchor";
import {
  parseAgentExplanationId,
  parseIsoTimestamp,
  parseRepoRelativePath,
  parseReviewSessionId,
  type AgentExplanationId,
  type IsoTimestamp,
  type ReviewSessionId,
} from "./ids";
import { storedAnchorSchema } from "./local-draft";
import { err, ok, type Result } from "./result";

/** A Review holds at most this many Agent explanations, carried ones included (#665). */
export const MAX_AGENT_EXPLANATIONS = 10;

/** An explanation is a short note on key lines, not a design document. */
const MAX_AGENT_EXPLANATION_LENGTH = 1_000;

/**
 * The coding agent's explanation of its change on diff lines of a local
 * Review's Combined view (#665). It is not a Local draft: it is stored on the
 * Review beside them, and never enters Copy as agent prompt, `get_feedback`,
 * the hand-off, or an Insight prompt. The maintainer replies to it with an
 * ordinary note or dismisses it. The text is untrusted and shown as plain text.
 */
export type AgentExplanation = {
  readonly explanationId: AgentExplanationId;
  /** The session whose Combined patch the anchor is fingerprinted against; a move carries it to the new one. */
  readonly sessionId: ReviewSessionId;
  readonly anchor: ReviewAnchorFingerprint;
  readonly text: string;
  readonly createdAt: IsoTimestamp;
  /** Set once a move found its lines changed; it stays set. */
  readonly outdated?: true;
};

/** What the workbench shows for one Agent explanation; the fingerprint stays in the main process. */
export type AgentExplanationEntry = {
  readonly explanationId: AgentExplanationId;
  readonly sessionId: ReviewSessionId;
  readonly path: string;
  readonly side: "new" | "old";
  readonly startLine: number;
  readonly line: number;
  readonly text: string;
  readonly createdAt: IsoTimestamp;
  readonly outdated?: true;
};

const nonEmpty = v.pipe(v.string(), v.minLength(1));
const lineNumber = v.pipe(v.number(), v.integer(), v.minValue(1));
const explanationText = v.pipe(
  nonEmpty,
  v.maxLength(MAX_AGENT_EXPLANATION_LENGTH),
);

/** The stored form of one Agent explanation; unknown fields are refused. */
export const storedAgentExplanationSchema = v.strictObject({
  explanationId: nonEmpty,
  sessionId: nonEmpty,
  anchor: storedAnchorSchema,
  text: explanationText,
  createdAt: nonEmpty,
  outdated: v.optional(v.literal(true)),
});

/** The wire form the workbench projection, the detection answer, and Dismiss send. */
export const agentExplanationEntrySchema = v.strictObject({
  explanationId: nonEmpty,
  sessionId: nonEmpty,
  path: nonEmpty,
  side: v.picklist(["new", "old"]),
  startLine: lineNumber,
  line: lineNumber,
  text: explanationText,
  createdAt: nonEmpty,
  outdated: v.exactOptional(v.literal(true)),
});

type StoredAgentExplanation = v.InferOutput<
  typeof storedAgentExplanationSchema
>;

/** Refines stored explanations; an empty list is stored as no list, and one bad entry refuses the list. */
export function parseStoredAgentExplanations(
  raw: ReadonlyArray<StoredAgentExplanation>,
): Result<ReadonlyArray<AgentExplanation>, "invalid"> {
  if (raw.length === 0) return err("invalid");
  const explanations: AgentExplanation[] = [];
  for (const entry of raw) {
    const explanationId = parseAgentExplanationId(entry.explanationId);
    const sessionId = parseReviewSessionId(entry.sessionId);
    const path = parseRepoRelativePath(entry.anchor.path);
    const text = parseAgentExplanationText(entry.text);
    const createdAt = parseIsoTimestamp(entry.createdAt);
    if (
      explanationId._tag === "err" ||
      sessionId._tag === "err" ||
      path._tag === "err" ||
      text._tag === "err" ||
      createdAt._tag === "err" ||
      entry.anchor.line < entry.anchor.startLine
    )
      return err("invalid");
    explanations.push({
      explanationId: explanationId.value,
      sessionId: sessionId.value,
      anchor: { ...entry.anchor, path: path.value },
      text: text.value,
      createdAt: createdAt.value,
      ...definedProps({ outdated: entry.outdated }),
    });
  }
  return ok(explanations);
}

/** An explanation's text: anything but whitespace, within its length limit. */
export function parseAgentExplanationText(
  text: string,
): Result<string, "invalid"> {
  return text.trim().length === 0 || text.length > MAX_AGENT_EXPLANATION_LENGTH
    ? err("invalid")
    : ok(text);
}

export function projectAgentExplanation(
  explanation: AgentExplanation,
): AgentExplanationEntry {
  return {
    explanationId: explanation.explanationId,
    sessionId: explanation.sessionId,
    path: explanation.anchor.path,
    side: explanation.anchor.side,
    startLine: explanation.anchor.startLine,
    line: explanation.anchor.line,
    text: explanation.text,
    createdAt: explanation.createdAt,
    ...definedProps({ outdated: explanation.outdated }),
  };
}
