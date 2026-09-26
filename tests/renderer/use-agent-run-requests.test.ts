// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentRunRequestView } from "../../src/renderer/src/agent-run-requests";
import { displayClientName } from "../../src/renderer/src/agent-run-requests";
import type { ReviewWorkbenchPatch } from "../../src/renderer/src/flows/use-review-observation";
import { useAgentRunRequests } from "../../src/renderer/src/hooks/use-agent-run-requests";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

const DECLINE = "/v1/reviews/insights/agent-requests/decline";
let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
});

const awaitingAnalysis: AgentRunRequestView = {
  requestId: "agent-request-1",
  sessionId: "session-a",
  type: "analysis",
  requestedAt: "2026-09-26T10:00:00.000Z",
  status: "awaiting_approval",
};
const declinedAnalysis = {
  requestId: "agent-request-1",
  sessionId: "session-a",
  type: "analysis",
  requestedAt: "2026-09-26T10:00:00.000Z",
  status: "declined",
} as const;
const awaitingBrief: AgentRunRequestView = {
  ...awaitingAnalysis,
  requestId: "agent-request-2",
  type: "brief",
};

function renderRequests() {
  const patches: ReviewWorkbenchPatch[] = [];
  const hook = renderHook(() =>
    useAgentRunRequests({
      profileId: "acme",
      reviewId: "review-1",
      requests: [awaitingAnalysis, awaitingBrief],
      onWorkbenchPatch: (patch) => patches.push(patch),
    }),
  );
  return { ...hook, patches };
}

describe("useAgentRunRequests", () => {
  it("declines one request and patches the declined request from the answer, keeping the other awaiting", async () => {
    const bodies: unknown[] = [];
    desktop = installDesktopDouble({
      [DECLINE]: (input) => {
        bodies.push(input.body);
        return success({ request: declinedAnalysis });
      },
    });
    const { result, patches } = renderRequests();

    act(() => result.current.decline("agent-request-1"));
    await waitFor(() => expect(patches).toHaveLength(1));

    expect(bodies).toEqual([
      { profileId: "acme", reviewId: "review-1", requestId: "agent-request-1" },
    ]);
    expect(patches[0]?.agentRunRequests).toEqual([
      declinedAnalysis,
      awaitingBrief,
    ]);
    expect(result.current.declining).toBeUndefined();
  });

  it("marks the request whose Decline was refused and patches nothing", async () => {
    desktop = installDesktopDouble({
      [DECLINE]: () => failure({ error: "request_not_awaiting" }, 409),
    });
    const { result, patches } = renderRequests();

    act(() => result.current.decline("agent-request-1"));
    await waitFor(() =>
      expect(result.current.declineFailed).toBe("agent-request-1"),
    );

    expect(patches).toEqual([]);
    expect(result.current.awaiting).toHaveLength(2);
  });
});

describe("displayClientName", () => {
  it.each([
    {
      name: "control and bidi characters",
      raw: `claude${String.fromCodePoint(0x202e)}-code${String.fromCodePoint(0x07)}`,
      shown: "claude-code",
    },
    { name: "a missing name", raw: undefined, shown: "An agent" },
    {
      name: "a name of only format characters",
      raw: String.fromCodePoint(0x200b, 0x2066),
      shown: "An agent",
    },
    {
      name: "a name past 40 characters",
      raw: "a".repeat(60),
      shown: `${"a".repeat(39)}…`,
    },
  ])("shows $name safely", ({ raw, shown }) => {
    expect(displayClientName(raw)).toBe(shown);
  });
});
