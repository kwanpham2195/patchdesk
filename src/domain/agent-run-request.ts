import * as v from "valibot";

import { definedProps } from "./defined-props";
import {
  parseAgentRunRequestId,
  parseInsightRunId,
  parseIsoTimestamp,
  parseReviewSessionId,
  type AgentRunRequestId,
  type InsightRunId,
  type IsoTimestamp,
  type ReviewSessionId,
} from "./ids";
import type { InsightType } from "./insight-record";
import { err, ok, type Result } from "./result";

/**
 * A coding agent's request to run one Insight on a local Review's session
 * (ADR 0052 "Per-run approval in the app"). A Review holds at most one per
 * session and type; `approved` names the run the maintainer started, and
 * `declined` is final for the session.
 */
export type AgentRunRequest = {
  readonly requestId: AgentRunRequestId;
  readonly sessionId: ReviewSessionId;
  readonly type: InsightType;
  readonly requestedAt: IsoTimestamp;
  /** The MCP client's own name, when it sent one. */
  readonly clientName?: string;
} & (
  | { readonly status: "awaiting_approval" }
  | { readonly status: "approved"; readonly runId: InsightRunId }
  | { readonly status: "declined" }
);

const requestFields = {
  requestId: v.pipe(v.string(), v.minLength(1)),
  sessionId: v.pipe(v.string(), v.minLength(1)),
  type: v.picklist(["analysis", "walkthrough", "brief"]),
  requestedAt: v.pipe(v.string(), v.minLength(1)),
  clientName: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
};

/** The stored and wire form of one request; the workbench projection sends the same shape. */
export const agentRunRequestSchema = v.variant("status", [
  v.strictObject({ ...requestFields, status: v.literal("awaiting_approval") }),
  v.strictObject({
    ...requestFields,
    status: v.literal("approved"),
    runId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({ ...requestFields, status: v.literal("declined") }),
]);

type StoredAgentRunRequest = v.InferOutput<typeof agentRunRequestSchema>;

/** Refines stored requests; an empty list is stored as no list, and two requests for one session and type are refused. */
export function parseStoredAgentRunRequests(
  raw: ReadonlyArray<StoredAgentRunRequest>,
): Result<ReadonlyArray<AgentRunRequest>, "invalid"> {
  if (raw.length === 0) return err("invalid");
  const parsed: AgentRunRequest[] = [];
  for (const entry of raw) {
    const request = parseStoredAgentRunRequest(entry);
    if (request === undefined) return err("invalid");
    if (findAgentRunRequest(parsed, request.sessionId, request.type))
      return err("invalid");
    parsed.push(request);
  }
  return ok(parsed);
}

function parseStoredAgentRunRequest(
  raw: StoredAgentRunRequest,
): AgentRunRequest | undefined {
  const requestId = parseAgentRunRequestId(raw.requestId);
  const sessionId = parseReviewSessionId(raw.sessionId);
  const requestedAt = parseIsoTimestamp(raw.requestedAt);
  if (
    requestId._tag === "err" ||
    sessionId._tag === "err" ||
    requestedAt._tag === "err"
  )
    return undefined;
  const fields = {
    requestId: requestId.value,
    sessionId: sessionId.value,
    type: raw.type,
    requestedAt: requestedAt.value,
    ...definedProps({ clientName: raw.clientName }),
  };
  if (raw.status !== "approved") return { ...fields, status: raw.status };
  const runId = parseInsightRunId(raw.runId);
  return runId._tag === "ok"
    ? { ...fields, status: "approved", runId: runId.value }
    : undefined;
}

export function findAgentRunRequest(
  requests: ReadonlyArray<AgentRunRequest> | undefined,
  sessionId: ReviewSessionId,
  type: InsightType,
): AgentRunRequest | undefined {
  return requests?.find(
    (request) => request.sessionId === sessionId && request.type === type,
  );
}

/** The list with `next` in place of the request for its session and type. */
export function putAgentRunRequest(
  requests: ReadonlyArray<AgentRunRequest> | undefined,
  next: AgentRunRequest,
): ReadonlyArray<AgentRunRequest> {
  const kept = (requests ?? []).filter(
    (request) =>
      request.sessionId !== next.sessionId || request.type !== next.type,
  );
  return [...kept, next];
}

/** The requests a Review keeps when it moves to `sessionId`; undefined when none remain. */
export function agentRunRequestsOnSession(
  requests: ReadonlyArray<AgentRunRequest> | undefined,
  sessionId: ReviewSessionId,
): ReadonlyArray<AgentRunRequest> | undefined {
  const kept = requests?.filter((request) => request.sessionId === sessionId);
  return kept === undefined || kept.length === 0 ? undefined : kept;
}
