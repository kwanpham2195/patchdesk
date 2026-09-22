// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import {
  InsightFailed,
  InsightRunning,
} from "../../src/renderer/src/components/insight-panels";

const failedProjection = {
  status: "failed",
  replacementFailure: {
    runId: "run-a",
    model: "gpt-5.6-luna",
    reasoning: "high",
    category: "review_worktree_unavailable",
    retryable: true,
  },
} as const;

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
        approvals: { accepted: 2, declined: 0 },
      }}
    />,
  );

  const commands = screen.getByRole("list", { name: "Commands" });
  expect(within(commands).getAllByRole("listitem")).toHaveLength(2);
});

it("offers Review re-preparation for a missing worktree without duplicating the retained-result message", async () => {
  const onReprepare = vi.fn().mockResolvedValue(undefined);
  const onRetry = vi.fn();
  render(
    <InsightFailed
      projection={failedProjection}
      onRetry={onRetry}
      onReprepare={onReprepare}
    />,
  );

  expect(
    screen.getByText(
      "This Review’s local files are unavailable. Re-prepare the Review, then run this Insight again.",
    ),
  ).not.toBeNull();
  expect(screen.getAllByText("No retained result is available.")).toHaveLength(
    1,
  );
  fireEvent.click(screen.getByRole("button", { name: "Re-prepare Review" }));
  await waitFor(() => expect(onReprepare).toHaveBeenCalledOnce());
  expect(onRetry).toHaveBeenCalledOnce();
});

it("keeps a failed run's full untrusted command and duration in the trace", () => {
  const command = `/bin/zsh -lc '${"printf diagnostic-output ".repeat(12)}'`;
  render(
    <InsightFailed
      projection={{
        ...failedProjection,
        replacementFailure: {
          ...failedProjection.replacementFailure,
          category: "execution_failed",
        },
      }}
      onRetry={vi.fn()}
      onReprepare={vi.fn()}
      activity={{
        phase: "turn",
        commands: [
          {
            id: "cmd-long",
            command,
            status: "failed",
            exitCode: 1,
            durationMs: 12_345,
          },
        ],
        approvals: { accepted: 0, declined: 0 },
      }}
    />,
  );

  expect(screen.getByTitle(command).textContent).toBe(command);
  expect(screen.queryByText("12.3s")).not.toBeNull();
});
