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
  InsightNavRail,
  InsightRunning,
} from "#src/renderer/src/components/insight-panels";
import { briefInsight, withAnalysis } from "./review-workbench-fixtures";

const failedProjection = {
  status: "failed",
  replacementFailure: {
    runId: "run-a",
    reason: "failed",
    model: "gpt-5.6-luna",
    reasoning: "high",
    category: "review_worktree_unavailable",
    retryable: true,
  },
} as const;

afterEach(() => {
  cleanup();
});

it("names each Insight tab with its status and leaves a current result unmarked", () => {
  const workbench = withAnalysis("actionable");
  render(
    <InsightNavRail
      workbench={{
        ...workbench,
        insights: {
          ...workbench.insights,
          brief: briefInsight({ status: "failed" }),
        },
      }}
      selectedInsight="analysis"
      guideStatus={{
        status: "not_generated",
        label: undefined,
        activeStatus: undefined,
      }}
      setSelectedInsight={vi.fn()}
      runs={{
        brief: { status: "idle" },
        walkthrough: { status: "idle" },
        analysis: { status: "idle" },
        guide: { status: "idle" },
      }}
    />,
  );

  expect(screen.getByRole("tab", { name: "Brief: Failed" })).not.toBeNull();
  expect(
    screen.getByRole("tab", { name: "Walkthrough: Not run" }),
  ).not.toBeNull();
  expect(
    screen.getByRole("tab", { name: "Analysis", selected: true }),
  ).not.toBeNull();
});

it("renders a running Insight's command trace", () => {
  render(
    <InsightRunning
      type="brief"
      projection={{
        status: "running",
        activeRun: {
          status: "running",
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
    screen.getByText("This Review’s local files are unavailable."),
  ).not.toBeNull();
  expect(screen.queryByText("No retained result.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Re-prepare Review" }));
  await waitFor(() => expect(onReprepare).toHaveBeenCalledOnce());
  expect(onRetry).toHaveBeenCalledOnce();
});

it("keeps failed-run diagnostics available without a Details or Activity disclosure", () => {
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
    />,
  );

  expect(screen.queryByText("Activity")).toBeNull();
  expect(screen.queryByText("Details")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Copy diagnostics" }),
  ).not.toBeNull();
});
