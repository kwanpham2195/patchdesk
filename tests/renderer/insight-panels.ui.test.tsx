// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { InsightRunning } from "../../src/renderer/src/components/insight-panels";

afterEach(() => {
  cleanup();
});

it("renders a running Insight's command trace", () => {
  render(
    <InsightRunning
      type="brief"
      projection={{
        status: "running",
        activeRun: {
          runId: "run-a",
          sessionId: "session-a",
          startedAt: "2026-09-17T00:00:00.000Z",
        },
      }}
      activity={{
        phase: "turn",
        reasoningLine: "Checking how citations resolve",
        commands: [
          {
            id: "cmd-1",
            command: "git diff HEAD~1",
            status: "completed",
            exitCode: 0,
            durationMs: 400,
          },
          {
            id: "cmd-2",
            command: "git log --oneline -20",
            status: "in_progress",
          },
        ],
      }}
    />,
  );

  const commands = screen.getByRole("list", { name: "Commands" });
  expect(within(commands).getAllByRole("listitem")).toHaveLength(2);
});
