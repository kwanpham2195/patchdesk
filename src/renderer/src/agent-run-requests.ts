import type { WorkbenchResponse } from "./renderer-contracts";

export type AgentRunRequestView = NonNullable<
  WorkbenchResponse["agentRunRequests"]
>[number];

const CLIENT_NAME_LIMIT = 40;

/**
 * The MCP client's self-reported name as the Agent requests bar prints it.
 * The agent picks this string, so control and format characters (bidi
 * overrides, zero-width marks) are removed before it reaches the screen.
 */
export function displayClientName(name: string | undefined): string {
  const cleaned = (name ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned === "") return "An agent";
  const characters = [...cleaned];
  return characters.length <= CLIENT_NAME_LIMIT
    ? cleaned
    : `${characters.slice(0, CLIENT_NAME_LIMIT - 1).join("")}…`;
}

/**
 * What the sidebar's "agent" marker depends on for the open Review: each
 * request's status, and for an approved one its Insight's status and
 * retained run. The sidebar
 * listing computes the marker from storage; a change here tells the renderer
 * to read it again.
 */
export function agentMarkerInputs(
  workbench: Pick<WorkbenchResponse, "agentRunRequests" | "insights">,
): string {
  return JSON.stringify(
    (workbench.agentRunRequests ?? []).map((request) => [
      request.requestId,
      request.status,
      request.status === "approved"
        ? [
            workbench.insights[request.type]?.status,
            workbench.insights[request.type]?.retained?.runId,
          ]
        : null,
    ]),
  );
}

/** The session's requests after a run of `type` started: the awaiting one of that type is approved with it, as the main process records. */
export function approveAgentRunRequests(
  requests: ReadonlyArray<AgentRunRequestView> | undefined,
  type: AgentRunRequestView["type"],
  runId: string,
): AgentRunRequestView[] | undefined {
  return requests?.map((request) =>
    request.type === type && request.status === "awaiting_approval"
      ? { ...request, status: "approved" as const, runId }
      : request,
  );
}
